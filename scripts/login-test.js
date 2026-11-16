'use strict';

/* 真实登录函数的离线回归：模拟窗口、IPC 与可控异步轮询，不启动 Electron，
 * 不连接 B 站，也不读取或改写用户配置。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const projectRoot = path.resolve(__dirname, '..');
const mainSource = fs.readFileSync(path.join(projectRoot, 'src', 'main.js'), 'utf8');
const signedIn = { ok: true, loggedIn: true, uname: 'login-test-user', mid: 42, vip: false };
const signedOut = { ok: true, loggedIn: false, uname: '', mid: 0, vip: false };
let passed = 0;
let failed = 0;

function extractFunction(source, name) {
  const declaration = new RegExp('^(?:async\\s+)?function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{', 'm').exec(source);
  assert.ok(declaration, '找不到真实函数 ' + name);
  let cursor = declaration.index + declaration[0].length;
  let depth = 1;
  while (depth > 0 && cursor < source.length) {
    const character = source[cursor];
    if (character === '{') depth += 1;
    else if (character === '}') depth -= 1;
    cursor += 1;
  }
  assert.equal(depth, 0, '函数括号不完整：' + name);
  const extracted = source.slice(declaration.index, cursor);
  new vm.Script(extracted, { filename: 'extracted-' + name + '.js' });
  return extracted;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function check(label, callback) {
  try {
    await callback();
    passed += 1;
    console.log('PASS  ' + label);
  } catch (error) {
    failed += 1;
    console.error('FAIL  ' + label + '\n' + error.stack);
  }
}

function createWindow(kind = 'login', options = {}) {
  const window = new EventEmitter();
  window.kind = kind;
  window.destroyed = false;
  window.minimized = false;
  window.calls = [];
  window.messages = [];
  window.webContents = {
    send(channel, payload) {
      window.messages.push({ channel, payload: payload === undefined ? undefined : plain(payload) });
    }
  };
  window.isDestroyed = () => window.destroyed;
  window.isMinimized = () => window.minimized;
  window.restore = () => {
    window.minimized = false;
    window.calls.push('restore');
  };
  window.show = () => window.calls.push('show');
  window.focus = () => window.calls.push('focus');
  window.setAlwaysOnTop = (...arguments_) => window.calls.push(['setAlwaysOnTop', ...arguments_]);
  window.loadURL = (url) => {
    window.calls.push(['loadURL', url]);
    return options.loadError ? Promise.reject(options.loadError) : Promise.resolve();
  };
  window.close = () => {
    window.calls.push('close');
    if (window.destroyed) return;
    window.destroyed = true;
    window.emit('closed');
  };
  return window;
}

function loginMessages(window) {
  return window.messages.filter((message) => message.channel === 'login:state');
}

function createLoginHarness(options = {}) {
  const videoWindow = options.withVideo === false ? null : createWindow('video');
  const consoleWindow = createWindow('console');
  const created = [];
  const intervals = new Map();
  const intervalHistory = [];
  const logs = [];
  let nextTimer = 0;
  let elapsed = 0;
  let requests = 0;
  const context = vm.createContext({
    __dirname: path.join(projectRoot, 'src'),
    path,
    BILI_PARTITION: 'persist:bili',
    BrowserWindow: function BrowserWindow(windowOptions) {
      const window = createWindow('login', options);
      window.options = windowOptions;
      created.push(window);
      return window;
    },
    fetchNav: () => {
      requests += 1;
      return options.fetchNav ? options.fetchNav(requests) : Promise.resolve(signedOut);
    },
    setInterval(callback, delay) {
      nextTimer += 1;
      const interval = { callback, delay, id: nextTimer };
      intervals.set(nextTimer, interval);
      intervalHistory.push(interval);
      return nextTimer;
    },
    clearInterval: (timer) => intervals.delete(timer),
    Date: class MockDate extends Date {
      static now() { return elapsed; }
    },
    console: {
      log: (...messages) => logs.push({ level: 'log', messages }),
      warn: (...messages) => logs.push({ level: 'warn', messages }),
      error: (...messages) => logs.push({ level: 'error', messages })
    },
    initialVideoWindow: videoWindow,
    initialConsoleWindow: consoleWindow
  });
  vm.runInContext(`
    let win = initialVideoWindow;
    let consoleWin = initialConsoleWindow;
    let loginWin = null;
    ${extractFunction(mainSource, 'sendTo')}
    ${extractFunction(mainSource, 'broadcast')}
    ${extractFunction(mainSource, 'openLogin')}
    globalThis.testApi = {
      openLogin,
      loginWindow: () => loginWin,
      setLoginWindow: (value) => { loginWin = value; }
    };
  `, context, { filename: 'login-window-harness.js' });
  return {
    ...context.testApi,
    videoWindow,
    consoleWindow,
    created,
    intervals,
    intervalHistory,
    logs,
    requests: () => requests,
    fire(timer = intervals.keys().next().value) {
      const interval = intervals.get(timer);
      if (!interval) return Promise.resolve();
      elapsed += interval.delay;
      return Promise.resolve(interval.callback());
    },
    advance(milliseconds) { elapsed += milliseconds; }
  };
}

function createActionHarness(videoWindow) {
  const handlers = new Map();
  const calls = [];
  let loginCalls = 0;
  const context = vm.createContext({
    ipcMain: {
      on() {},
      handle: (channel, callback) => handlers.set(channel, callback)
    },
    initialVideoWindow: videoWindow,
    cancelTemporarySpeed: () => calls.push('cancel-temporary-speed'),
    openLogin: () => { loginCalls += 1; calls.push('open-login'); }
  });
  vm.runInContext(`
    let win = initialVideoWindow;
    ${extractFunction(mainSource, 'registerIpc')}
    registerIpc();
  `, context, { filename: 'login-action-harness.js' });
  return {
    invoke: () => handlers.get('win:action')({}, 'login'),
    loginCalls: () => loginCalls,
    calls
  };
}

async function main() {
  console.log('登录离线回归：真实 registerIpc/openLogin，模拟窗口与异步轮询');

  for (const state of ['missing', 'destroyed', 'active']) {
    await check('启动器登录动作在浮窗状态 ' + state + ' 时都能打开登录窗口', () => {
      const videoWindow = state === 'missing' ? null : createWindow('video');
      if (state === 'destroyed') videoWindow.destroyed = true;
      const harness = createActionHarness(videoWindow);
      const accepted = harness.invoke();
      assert.equal(harness.loginCalls(), 1, '登录动作不能受浮窗存在守卫影响');
      assert.deepEqual(harness.calls, ['cancel-temporary-speed', 'open-login']);
      assert.equal(accepted, true);
    });
  }

  await check('新登录窗口加载 B 站、前台展示并使用高置顶层级', () => {
    const harness = createLoginHarness();
    harness.openLogin();
    const window = harness.created[0];
    assert.equal(harness.created.length, 1);
    assert.equal(window.options.webPreferences.partition, 'persist:bili');
    assert.equal(window.options.webPreferences.nodeIntegration, false);
    assert.equal(window.options.webPreferences.contextIsolation, true);
    assert.equal(window.options.webPreferences.webSecurity, true);
    assert.equal(window.options.webPreferences.preload, undefined);
    assert.ok(window.calls.some((call) => Array.isArray(call) && call[0] === 'loadURL' &&
      call[1] === 'https://passport.bilibili.com/login'));
    assert.ok(window.calls.some((call) => Array.isArray(call) && call[0] === 'setAlwaysOnTop' &&
      call[1] === true && call[2] === 'screen-saver'));
    assert.ok(window.calls.includes('show'));
    assert.ok(window.calls.includes('focus'));
    assert.equal(harness.intervals.size, 1);
  });

  await check('重复点击登录会恢复最小化窗口再显示聚焦，不创建重复窗口或轮询', () => {
    const harness = createLoginHarness();
    harness.openLogin();
    const window = harness.created[0];
    window.minimized = true;
    window.calls.length = 0;
    harness.openLogin();
    assert.equal(harness.created.length, 1);
    assert.equal(harness.intervals.size, 1);
    assert.equal(window.minimized, false);
    const restore = window.calls.indexOf('restore');
    const show = window.calls.indexOf('show');
    const focus = window.calls.indexOf('focus');
    assert.ok(restore >= 0 && show > restore && focus > show, '应先 restore，再 show/focus');
  });

  await check('未登录轮询保持窗口和登录状态，无成功广播', async () => {
    const harness = createLoginHarness();
    harness.openLogin();
    await harness.fire();
    assert.equal(harness.requests(), 1);
    assert.equal(harness.created[0].destroyed, false);
    assert.equal(harness.intervals.size, 1);
    assert.deepEqual(loginMessages(harness.videoWindow), []);
    assert.deepEqual(loginMessages(harness.consoleWindow), []);
  });

  await check('扫码成功同时通知启动器和浮窗，关窗不会用 null 覆盖成功状态', async () => {
    const harness = createLoginHarness({ fetchNav: () => Promise.resolve(signedIn) });
    harness.openLogin();
    await harness.fire();
    for (const window of [harness.videoWindow, harness.consoleWindow]) {
      assert.deepEqual(loginMessages(window), [{ channel: 'login:state', payload: signedIn }]);
    }
    assert.equal(harness.created[0].destroyed, true);
    assert.equal(harness.loginWindow(), null);
    assert.equal(harness.intervals.size, 0);
  });

  await check('没有浮窗时扫码成功仍通知启动器', async () => {
    const harness = createLoginHarness({ withVideo: false, fetchNav: () => Promise.resolve(signedIn) });
    harness.openLogin();
    await harness.fire();
    assert.deepEqual(loginMessages(harness.consoleWindow), [{ channel: 'login:state', payload: signedIn }]);
    assert.equal(harness.created[0].destroyed, true);
  });

  await check('手动取消只关闭登录窗口，不把已知登录状态抹成 null', async () => {
    const harness = createLoginHarness();
    harness.videoWindow.messages.push({ channel: 'login:state', payload: signedIn });
    harness.consoleWindow.messages.push({ channel: 'login:state', payload: signedIn });
    harness.openLogin();
    harness.created[0].close();
    await Promise.resolve();
    for (const window of [harness.videoWindow, harness.consoleWindow]) {
      const lastMessage = loginMessages(window).at(-1);
      assert.ok(lastMessage && lastMessage.payload, '关闭登录页不能发布空登录态');
      assert.equal(lastMessage.payload.loggedIn, true);
    }
    assert.equal(harness.loginWindow(), null);
    assert.equal(harness.intervals.size, 0);
  });

  await check('同一窗口轮询单飞，请求未返回时再次到点不重入且成功只广播一次', async () => {
    const result = deferred();
    const harness = createLoginHarness({ fetchNav: () => result.promise });
    harness.openLogin();
    const first = harness.fire();
    const overlapping = harness.fire();
    const requestsWhilePending = harness.requests();
    result.resolve(signedIn);
    await Promise.all([first, overlapping]);
    assert.equal(requestsWhilePending, 1, '必须限制同一登录窗口的并行请求数');
    assert.equal(harness.created[0].calls.filter((call) => call === 'close').length, 1);
    for (const window of [harness.videoWindow, harness.consoleWindow]) {
      assert.deepEqual(loginMessages(window), [{ channel: 'login:state', payload: signedIn }]);
    }
    assert.equal(harness.intervals.size, 0);
  });

  await check('登录窗口关闭后迟到的成功响应不发送状态、不关闭其他窗口', async () => {
    const result = deferred();
    const harness = createLoginHarness({ fetchNav: () => result.promise });
    harness.openLogin();
    const request = harness.fire();
    const oldWindow = harness.created[0];
    oldWindow.close();
    const messagesBefore = [harness.videoWindow.messages.length, harness.consoleWindow.messages.length];
    result.resolve(signedIn);
    await request;
    assert.deepEqual([harness.videoWindow.messages.length, harness.consoleWindow.messages.length], messagesBefore);
    assert.equal(oldWindow.calls.filter((call) => call === 'close').length, 1);
    assert.equal(harness.intervals.size, 0);
  });

  await check('关闭旧登录页后重开，旧请求不能广播或关闭新登录页', async () => {
    const oldResult = deferred();
    const harness = createLoginHarness({ fetchNav: () => oldResult.promise });
    harness.openLogin();
    const request = harness.fire();
    harness.created[0].close();
    harness.openLogin();
    const newWindow = harness.created[1];
    const messagesBefore = [harness.videoWindow.messages.length, harness.consoleWindow.messages.length];
    oldResult.resolve(signedIn);
    await request;
    assert.equal(harness.loginWindow(), newWindow);
    assert.equal(newWindow.destroyed, false);
    assert.equal(newWindow.calls.includes('close'), false);
    assert.deepEqual([harness.videoWindow.messages.length, harness.consoleWindow.messages.length], messagesBefore);
    assert.equal(harness.intervals.size, 1);
  });

  await check('未完成登录时五分钟后停止轮询，不持续请求 B 站', async () => {
    const harness = createLoginHarness();
    harness.openLogin();
    for (let interval = 0; interval < 152; interval += 1) await harness.fire();
    assert.equal(harness.intervals.size, 0);
    assert.ok(harness.requests() <= 150);
    assert.ok(harness.requests() > 0);
    const requestsBefore = harness.requests();
    await harness.fire();
    assert.equal(harness.requests(), requestsBefore);
    assert.deepEqual(loginMessages(harness.consoleWindow), []);
  });

  await check('登录页加载拒绝被记录，不产生未处理 Promise 拒绝', async () => {
    const error = new Error('simulated login navigation failure');
    const unhandled = [];
    const observeUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', observeUnhandled);
    try {
      const harness = createLoginHarness({ loadError: error });
      harness.openLogin();
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(unhandled, []);
      assert.ok(harness.logs.some((entry) => entry.level === 'warn' || entry.level === 'error'),
        'loadURL 失败应留下可诊断日志');
      harness.created[0].close();
    } finally {
      process.removeListener('unhandledRejection', observeUnhandled);
    }
  });

  console.log('\n结果：' + passed + ' PASS / ' + failed + ' FAIL');
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
