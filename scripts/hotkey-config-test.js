'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { normalizeAccelerator, mergeHotkeys, prepareHotkeyUpdate } = require('../src/hotkey-config');
const mainSource = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');

let passed = 0;
function check(label, callback) {
  callback();
  passed += 1;
  console.log('PASS  ' + label);
}

check('修饰键别名归一化并按 Ctrl Alt Shift Super 排序', () => {
  for (const alias of ['Ctrl', 'Control', 'CmdOrCtrl', 'CommandOrControl']) {
    assert.equal(normalizeAccelerator(alias + '+j'), 'Ctrl+J');
  }
  for (const alias of ['Meta', 'Super', 'Win', 'Windows', 'Command', 'Cmd']) {
    assert.equal(normalizeAccelerator(alias + '+j'), 'Super+J');
  }
  assert.equal(normalizeAccelerator('Option+j'), 'Alt+J');
  assert.equal(normalizeAccelerator('super+SHIFT+option+control+j'), 'Ctrl+Alt+Shift+Super+J');
  assert.equal(normalizeAccelerator(' Alt + Ctrl + j '), 'Ctrl+Alt+J');
  assert.equal(normalizeAccelerator('j+Control'), 'Ctrl+J');
});

check('字母、方向、Escape、Return 和鼠标侧键规范化', () => {
  assert.equal(normalizeAccelerator('k'), 'K');
  for (const direction of ['Left', 'Right', 'Up', 'Down']) {
    assert.equal(normalizeAccelerator('Control+arrow' + direction.toLowerCase()), 'Ctrl+' + direction);
  }
  assert.equal(normalizeAccelerator('escape'), 'Esc');
  assert.equal(normalizeAccelerator('Alt+Return'), 'Alt+Enter');
  assert.equal(normalizeAccelerator('mOuSe4'), 'Mouse4');
  assert.equal(normalizeAccelerator('ctrl+MOUSE5'), 'Ctrl+Mouse5');
  assert.equal(normalizeAccelerator('shift+space'), 'Shift+Space');
  assert.equal(normalizeAccelerator('ctrl+pageup'), 'Ctrl+PageUp');
});

check('F1 至 F24 规范化，未知主键保留供运行时校验', () => {
  for (let number = 1; number <= 24; number += 1) {
    assert.equal(normalizeAccelerator('alt+f' + number), 'Alt+F' + number);
  }
  assert.equal(normalizeAccelerator('f01'), 'F1');
  assert.equal(normalizeAccelerator('Ctrl+UnrecognizedKey'), 'Ctrl+UnrecognizedKey');
  assert.equal(normalizeAccelerator('Ctrl+f25'), 'Ctrl+f25');
  assert.equal(normalizeAccelerator('NumAdd'), 'NumAdd');
});

check('常用标点保留，加号主键统一为 Electron Plus', () => {
  for (const punctuation of ['-', '=', '[', ']', ';', "'", ',', '.', '/', '\\', '`']) {
    assert.equal(normalizeAccelerator('Control+' + punctuation), 'Ctrl+' + punctuation);
  }
  assert.equal(normalizeAccelerator('+'), 'Plus');
  assert.equal(normalizeAccelerator('Ctrl++'), 'Ctrl+Plus');
  assert.equal(normalizeAccelerator('Control+plus'), 'Ctrl+Plus');
});

check('空值、重复修饰键、多主键和缺主键拒绝', () => {
  for (const invalid of [undefined, null, 42, {}, [], '', ' ', 'Ctrl+', '+J', 'Ctrl++J',
    'Ctrl+Control+J', 'CmdOrCtrl+Control+J', 'Alt+Option+J', 'Meta+Win+J',
    'Ctrl+Shift', 'Alt+Ctrl', 'J+K', 'Ctrl+J+K', 'Ctrl+Ctrl', 'Ctrl+++']) {
    assert.equal(normalizeAccelerator(invalid), '', String(invalid));
  }
});

check('老设置的单独修饰键保留规范名', () => {
  assert.equal(normalizeAccelerator('control'), 'Ctrl');
  assert.equal(normalizeAccelerator('CmdOrCtrl'), 'Ctrl');
  assert.equal(normalizeAccelerator('option'), 'Alt');
  assert.equal(normalizeAccelerator('shift'), 'Shift');
  assert.equal(normalizeAccelerator('cmd'), 'Super');
});

check('只归一化别名和顺序时不会触发互换', () => {
  const result = prepareHotkeyUpdate({ first: 'Alt+Control+j', second: 'k' }, { first: 'ctrl+alt+J' });
  assert.deepEqual(result, {
    hotkeys: { first: 'Ctrl+Alt+J', second: 'K' }, rejected: [], swapped: []
  });
});

check('使用已占用组合时与原绑定交换，别名代表同一物理组合', () => {
  const result = prepareHotkeyUpdate({ first: 'j', second: 'Control+k', third: 'l' }, { first: 'ctrl+K' });
  assert.deepEqual(result, {
    hotkeys: { first: 'Ctrl+K', second: 'J', third: 'L' }, rejected: [], swapped: ['second']
  });
});

check('重排后的物理组合也会互换', () => {
  assert.deepEqual(prepareHotkeyUpdate({ first: 'l', second: 'Alt+Control+j' }, { first: 'Ctrl+Alt+J' }), {
    hotkeys: { first: 'Ctrl+Alt+J', second: 'L' }, rejected: [], swapped: ['second']
  });

  assert.deepEqual(prepareHotkeyUpdate({ first: 'Escape', second: 'mOuSe4' }, { first: 'mouse4' }), {
    hotkeys: { first: 'Mouse4', second: 'Esc' }, rejected: [], swapped: ['second']
  });
});

check('双向显式互换均成功，不列为隐式互换且不依赖请求顺序', () => {
  const previous = { first: 'Control+j', second: 'Alt+k' };
  const expected = { hotkeys: { first: 'Alt+K', second: 'Ctrl+J' }, rejected: [], swapped: [] };
  assert.deepEqual(prepareHotkeyUpdate(previous, { first: 'Alt+K', second: 'Ctrl+J' }), expected);
  assert.deepEqual(prepareHotkeyUpdate(previous, { second: 'Control+j', first: 'Alt+k' }), expected);
});

check('批量显式请求不可被隐式互换覆盖', () => {
  const previous = { first: 'J', second: 'K', third: 'L' };
  assert.deepEqual(prepareHotkeyUpdate(previous, { first: 'K', second: 'M' }), {
    hotkeys: { first: 'K', second: 'M', third: 'L' }, rejected: [], swapped: []
  });
  assert.deepEqual(prepareHotkeyUpdate(previous, { second: 'M', first: 'K' }), {
    hotkeys: { first: 'K', second: 'M', third: 'L' }, rejected: [], swapped: []
  });
});

check('批量重复组合整体回滚所有有效请求并清空 swapped', () => {
  const previous = { first: 'j', second: 'k', third: 'l', fourth: 'm' };
  assert.deepEqual(prepareHotkeyUpdate(previous, {
    first: 'Control+n', second: 'ctrl+N', third: 'M'
  }), {
    hotkeys: { first: 'J', second: 'K', third: 'L', fourth: 'M' },
    rejected: ['first', 'second', 'third'], swapped: []
  });
});

check('显式请求参与的原绑定交换若最终仍冲突，原子回滚', () => {
  const previous = { first: 'j', second: 'k', third: 'l' };
  assert.deepEqual(prepareHotkeyUpdate(previous, { first: 'K', second: 'L' }), {
    hotkeys: { first: 'J', second: 'K', third: 'L' }, rejected: ['first', 'second'], swapped: []
  });
  assert.deepEqual(prepareHotkeyUpdate(previous, { first: 'K', second: 'K' }), {
    hotkeys: { first: 'J', second: 'K', third: 'L' }, rejected: ['first', 'second'], swapped: []
  });
});

check('未涉及的旧重复不阻止其他动作修改，涉及则拒绝', () => {
  const previous = { first: 'Control+j', second: 'Ctrl+J', third: 'K' };
  assert.deepEqual(prepareHotkeyUpdate(previous, { third: 'L' }), {
    hotkeys: { first: 'Ctrl+J', second: 'Ctrl+J', third: 'L' }, rejected: [], swapped: []
  });
  assert.deepEqual(prepareHotkeyUpdate(previous, { first: 'Ctrl+J' }), {
    hotkeys: { first: 'Ctrl+J', second: 'Ctrl+J', third: 'K' }, rejected: ['first'], swapped: []
  });
});

check('只处理 previous 自有动作及规范化有效的非空字符串', () => {
  const previous = Object.assign(Object.create({ inherited: 'Z' }), { first: 'j', second: 'k' });
  assert.deepEqual(prepareHotkeyUpdate(previous, {
    first: 7, second: 'Control+Ctrl+K', unknown: 'N', inherited: 'M'
  }), { hotkeys: { first: 'J', second: 'K' }, rejected: [], swapped: [] });
  assert.deepEqual(prepareHotkeyUpdate(previous, { first: '', second: ' ' }), {
    hotkeys: { first: 'J', second: 'K' }, rejected: [], swapped: []
  });
  assert.deepEqual(prepareHotkeyUpdate(undefined, { first: 'J' }), { hotkeys: {}, rejected: [], swapped: [] });
  assert.deepEqual(prepareHotkeyUpdate(previous), { hotkeys: { first: 'J', second: 'K' }, rejected: [], swapped: [] });
});

check('成功和回滚均不污染冻结输入，也不共享返回映射', () => {
  const previous = Object.freeze({ first: 'j', second: 'Control+k' });
  const successPatch = Object.freeze({ first: 'Ctrl+K' });
  const rejectedPatch = Object.freeze({ first: 'n', second: 'N' });
  const success = prepareHotkeyUpdate(previous, successPatch);
  const rejected = prepareHotkeyUpdate(previous, rejectedPatch);
  success.hotkeys.first = 'Changed';
  rejected.hotkeys.first = 'Changed';
  assert.deepEqual(previous, { first: 'j', second: 'Control+k' });
  assert.deepEqual(successPatch, { first: 'Ctrl+K' });
  assert.deepEqual(rejectedPatch, { first: 'n', second: 'N' });
});

check('迁移先处理全部旧绑定，新增默认键不能抢先占用原有动作', () => {
  const defaults = { cycleSpeed: 'Ctrl+Alt+J', togglePlay: 'Space', holdSpeed: 'F8' };
  assert.deepEqual(mergeHotkeys(defaults, { togglePlay: 'Alt+Control+j' }), {
    cycleSpeed: '', togglePlay: 'Ctrl+Alt+J', holdSpeed: 'F8'
  });
  assert.deepEqual(mergeHotkeys({ holdSpeed: 'Mouse4', seekBack: 'Alt+Left' }, { seekBack: 'mOUSE4' }), {
    holdSpeed: '', seekBack: 'Mouse4'
  });
});

check('迁移保留显式空绑定，不用默认值悄悄恢复', () => {
  assert.deepEqual(mergeHotkeys({ togglePlay: 'Space', holdSpeed: 'F8', cycleSpeed: 'F9' }, {
    togglePlay: '', holdSpeed: '   '
  }), { togglePlay: '', holdSpeed: '', cycleSpeed: 'F9' });
});

check('迁移保留已保存动作间的历史重复，只禁止新增默认键加入冲突', () => {
  assert.deepEqual(mergeHotkeys({ first: 'J', second: 'K', added: 'Ctrl+J' }, {
    first: 'Control+j', second: 'Ctrl+J'
  }), { first: 'Ctrl+J', second: 'Ctrl+J', added: '' });
});

check('迁移不接未知或继承动作，未知绑定也不能占用新增默认键', () => {
  const defaults = Object.assign(Object.create({ inheritedDefault: 'Z' }), { first: 'j', added: 'F8' });
  const saved = Object.assign(Object.create({ first: 'K' }), { unknown: 'F8' });
  assert.deepEqual(mergeHotkeys(defaults, saved), { first: 'J', added: 'F8' });
});

check('迁移规范化默认键和保存键，非字符串保存值回退默认', () => {
  assert.deepEqual(mergeHotkeys({ first: 'control+j', second: 'Alt+ArrowLeft', third: 'Option+k' }, {
    first: null, second: 'return', third: 'Ctrl+Control+K'
  }), { first: 'Ctrl+J', second: 'Enter', third: '' });
  assert.deepEqual(mergeHotkeys({ first: 'Control+J', added: 'Ctrl+j' }), { first: 'Ctrl+J', added: '' });
  assert.deepEqual(mergeHotkeys(undefined, { unknown: 'J' }), {});
});

check('迁移不修改冻结输入，输出是独立映射且重复迁移幂等', () => {
  const defaults = Object.freeze({ added: 'Ctrl+J', first: 'K', second: 'F9' });
  const saved = Object.freeze({ first: 'Control+j', second: '', unknown: 'F8' });
  const result = mergeHotkeys(defaults, saved);
  assert.deepEqual(mergeHotkeys(defaults, result), result);
  result.first = 'Changed';
  assert.deepEqual(defaults, { added: 'Ctrl+J', first: 'K', second: 'F9' });
  assert.deepEqual(saved, { first: 'Control+j', second: '', unknown: 'F8' });
});

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function extractRegisterIpc() {
  const declaration = /^function registerIpc\s*\(\)\s*\{/m.exec(mainSource);
  assert.ok(declaration, '找不到真实 registerIpc 函数');
  let cursor = declaration.index + declaration[0].length;
  let depth = 1;
  while (depth > 0 && cursor < mainSource.length) {
    const character = mainSource[cursor];
    if (character === '{') depth += 1;
    else if (character === '}') depth -= 1;
    cursor += 1;
  }
  assert.equal(depth, 0, 'registerIpc 函数括号不完整');
  return mainSource.slice(declaration.index, cursor);
}

function createMainHarness(previous, failuresFor = () => []) {
  const handlers = new Map();
  const attempts = [];
  const persisted = [];
  const broadcasts = [];
  const settings = { hotkeys: plain(previous) };
  const context = vm.createContext({
    DEFAULT_HOTKEYS: plain(previous),
    settings,
    prepareHotkeyUpdate,
    ipcMain: {
      on() {},
      handle: (channel, callback) => handlers.set(channel, callback)
    },
    registerHotkeys() {
      const candidate = plain(settings.hotkeys);
      attempts.push(candidate);
      return failuresFor(candidate);
    },
    persist: () => persisted.push(plain(settings.hotkeys)),
    broadcast: (channel, payload) => broadcasts.push({ channel, payload: plain(payload) }),
    hookHotkeys: { isRunning: () => true }
  });
  vm.runInContext(extractRegisterIpc() + '\nregisterIpc();', context, { filename: 'hotkey-main-harness.js' });
  assert.ok(handlers.has('hotkeys:update'), '真实主进程应注册 hotkeys:update');
  return {
    update: (patch) => plain(handlers.get('hotkeys:update')({}, patch)),
    current: () => plain(settings.hotkeys),
    attempts,
    persisted,
    broadcasts
  };
}

check('真实 main：隐式互换的另一方注册失败，双方及本批其他请求一起回滚', () => {
  const previous = Object.freeze({ togglePlay: 'Ctrl+J', seekBack: 'Alt+K', cycleSpeed: 'F9' });
  const patch = Object.freeze({ togglePlay: 'Option+k', cycleSpeed: 'F10' });
  const harness = createMainHarness(previous, (candidate) => candidate.seekBack === 'Ctrl+J'
    ? [{ key: 'seekBack', accelerator: 'Ctrl+J', hook: false }] : []);
  const result = harness.update(patch);
  assert.deepEqual(harness.attempts, [
    { togglePlay: 'Alt+K', seekBack: 'Ctrl+J', cycleSpeed: 'F10' },
    previous
  ]);
  assert.deepEqual(result, {
    hotkeys: previous, failed: [], rejected: ['togglePlay', 'cycleSpeed'], swapped: [], hookRunning: true
  });
  assert.deepEqual(harness.current(), previous);
  assert.deepEqual(harness.persisted, [previous]);
  assert.deepEqual(harness.broadcasts, [{ channel: 'settings:changed', payload: { hotkeys: previous } }]);
  assert.deepEqual(patch, { togglePlay: 'Option+k', cycleSpeed: 'F10' });
});

check('真实 main：批量别名重复被拒绝，不注册冲突映射或发布半成品', () => {
  const previous = { togglePlay: 'Control+j', seekBack: 'Alt+k', cycleSpeed: 'f9' };
  const normalizedPrevious = { togglePlay: 'Ctrl+J', seekBack: 'Alt+K', cycleSpeed: 'F9' };
  const harness = createMainHarness(previous);
  const result = harness.update({ togglePlay: 'Alt+Ctrl+n', cycleSpeed: 'Control+Alt+N' });
  assert.deepEqual(result, {
    hotkeys: normalizedPrevious, failed: [], rejected: ['togglePlay', 'cycleSpeed'], swapped: [], hookRunning: true
  });
  assert.deepEqual(harness.attempts, [normalizedPrevious]);
  assert.deepEqual(harness.persisted, [normalizedPrevious]);
  assert.deepEqual(harness.broadcasts, [{ channel: 'settings:changed', payload: { hotkeys: normalizedPrevious } }]);
});

check('真实 main：成功互换一次注册并返回隐式动作，保存和广播完整候选', () => {
  const previous = { togglePlay: 'Control+j', seekBack: 'Alt+k', cycleSpeed: 'f9' };
  const candidate = { togglePlay: 'Alt+K', seekBack: 'Ctrl+J', cycleSpeed: 'F9' };
  const harness = createMainHarness(previous);
  assert.deepEqual(harness.update({ togglePlay: 'Option+k' }), {
    hotkeys: candidate, failed: [], rejected: [], swapped: ['seekBack'], hookRunning: true
  });
  assert.deepEqual(harness.attempts, [candidate]);
  assert.deepEqual(harness.current(), candidate);
  assert.deepEqual(harness.persisted, [candidate]);
  assert.deepEqual(harness.broadcasts, [{ channel: 'settings:changed', payload: { hotkeys: candidate } }]);
});

console.log('\n' + passed + ' PASS / 0 FAIL');
