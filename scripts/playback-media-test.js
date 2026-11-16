'use strict';

/* 隔离 Electron / Chromium 媒体回归。只加载本地假页面与真实 webview preload，
 * 不打开业务窗口、不登录 B 站、不碰用户配置，也不注册全局热键。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

if (!process.versions.electron) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gifa-playback-media-'));
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, temporaryRoot], { stdio: 'inherit', env: environment });
  child.on('error', (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  child.on('close', (code) => {
    assert.equal(path.dirname(temporaryRoot), path.resolve(os.tmpdir()));
    fs.rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    process.exitCode = code || 0;
  });
} else {
  runElectron().catch((error) => {
    console.error(error);
    require('electron').app.exit(1);
  });
}

async function runElectron() {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const temporaryRoot = process.argv[2];
  assert.ok(path.basename(temporaryRoot).startsWith('gifa-playback-media-'));
  app.setPath('userData', path.join(temporaryRoot, 'profile'));
  app.disableHardwareAcceleration();
  // 测试只加载自己生成的本地页面，避免 Windows Chromium 子进程沙箱阻断测试。
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  await app.whenReady();

  let preferences = { volume: 23, muted: false, playbackRate: 1.5 };
  let guest = null;
  let released = 0;
  const reports = [];
  const preloadErrors = [];
  const readyWaiters = [];
  app.on('web-contents-created', (_event, contents) => {
    contents.on('render-process-gone', (_goneEvent, details) => console.error('render-process-gone', details));
  });
  const host = new BrowserWindow({
    show: false,
    webPreferences: { webviewTag: true, backgroundThrottling: false }
  });
  host.webContents.on('did-attach-webview', (_event, contents) => {
    guest = contents;
    guest.setAudioMuted(true);
    guest.on('preload-error', (_preloadEvent, _preloadPath, error) => preloadErrors.push(error.message));
    guest.on('console-message', (details) => {
      if (details.level === 'error') console.error('[guest]', details.message);
    });
  });
  ipcMain.on('player:settings', (event) => {
    assert.equal(event.sender, guest, 'preload 必须在 guest 已附加后启动');
    assert.equal(event.sender.hostWebContents, host.webContents, '实际 guest 的宿主必须匹配');
    assert.equal(event.senderFrame, event.sender.mainFrame, '实际 IPC 主框架身份必须匹配');
    event.sender.setAudioMuted(true);
    event.returnValue = { ...preferences, token: 1 };
  });
  ipcMain.on('player:gating', (event) => event.sender.setAudioMuted(true));
  ipcMain.on('player:ready', (event) => {
    event.sender.setAudioMuted(false);
    released += 1;
    for (const resolve of readyWaiters.splice(0)) resolve();
  });
  ipcMain.on('player:changed', (event, message) => {
    const patch = message.patch;
    preferences = { ...preferences, ...patch };
    reports.push(patch);
    event.returnValue = preferences;
  });

  const sampleRate = 8000;
  const wave = Buffer.alloc(44 + sampleRate * 2);
  wave.write('RIFF', 0);
  wave.writeUInt32LE(wave.length - 8, 4);
  wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(sampleRate, 24);
  wave.writeUInt32LE(sampleRate * 2, 28);
  wave.writeUInt16LE(2, 32);
  wave.writeUInt16LE(16, 34);
  wave.write('data', 36);
  wave.writeUInt32LE(wave.length - 44, 40);
  const mediaUrl = 'data:audio/wav;base64,' + wave.toString('base64');
  const pagePath = path.join(temporaryRoot, 'player.html');
  const hostPath = path.join(temporaryRoot, 'host.html');
  fs.writeFileSync(pagePath, `<!doctype html><html><body>
    <video id="media" autoplay loop style="width:640px;height:360px" src="${mediaUrl}"></video>
    <script>
      window.observed = [];
      const media = document.getElementById('media');
      for (const type of ['play', 'playing', 'loadedmetadata']) {
        media.addEventListener(type, () => observed.push({ type, volume: media.volume, rate: media.playbackRate }));
      }
    </script></body></html>`);
  fs.writeFileSync(hostPath, '<!doctype html><html><body></body></html>');
  await host.loadURL(pathToFileURL(hostPath).href);
  const preloadUrl = pathToFileURL(path.resolve(__dirname, '../src/webview-preload.js')).href;
  await host.webContents.executeJavaScript(`{
    const view = document.createElement('webview');
    view.id = 'test-player';
    view.setAttribute('preload', ${JSON.stringify(preloadUrl)});
    view.setAttribute('src', ${JSON.stringify(pathToFileURL(pagePath).href)});
    document.body.appendChild(view);
    void 0;
  }`);

  function waitForReady(previous) {
    if (released > previous) return Promise.resolve();
    return withTimeout(new Promise((resolve) => readyWaiters.push(resolve)), '等待应用设置后首次播放');
  }

  async function readMedia() {
    return guest.executeJavaScript(`(() => {
      const media = document.querySelector('video');
      return { volume: media.volume, muted: media.muted, rate: media.playbackRate,
        defaultRate: media.defaultPlaybackRate, paused: media.paused };
    })()`);
  }

  async function expectMedia(label, expected) {
    const actual = await readMedia();
    for (const [key, value] of Object.entries(expected)) assert.equal(actual[key], value, label + ': ' + key);
    assert.equal(guest.isAudioMuted(), false, label + ': 设置恢复后必须开放原生音频');
    console.log('PASS  ' + label);
  }

  async function waitForReports(count) {
    await guest.executeJavaScript(`new Promise((resolve) => setTimeout(resolve, 50))`);
    assert.equal(reports.length, count);
  }

  try {
    await waitForReady(0);
    assert.deepEqual(preloadErrors, []);
    await expectMedia('原生 autoplay 首次播放恢复音量与倍速', { volume: 0.23, rate: 1.5, defaultRate: 1.5, muted: false });
    const observed = await guest.executeJavaScript('observed');
    assert.ok(observed.some((entry) => entry.type === 'playing'));
    assert.ok(observed.every((entry) => entry.volume === 0.23 && entry.rate === 1.5));
    await waitForReports(0);
    console.log('PASS  页面自身的首次媒体事件已经看到保存值，初始化不回写默认值');

    await guest.executeJavaScript(`document.querySelector('video').volume = 0.37`);
    await waitForReports(1);
    assert.equal(preferences.volume, 37);
    await guest.executeJavaScript(`document.querySelector('video').playbackRate = 1.75`);
    await waitForReports(2);
    assert.equal(preferences.playbackRate, 1.75);
    await guest.executeJavaScript(`document.querySelector('video').muted = true`);
    await waitForReports(3);
    assert.deepEqual(preferences, { volume: 37, muted: true, playbackRate: 1.75 });
    console.log('PASS  播放器内音量、倍速和静音同步保存，静音保留原音量');

    let previous = released;
    await guest.executeJavaScript(`{
      const old = document.querySelector('video');
      const replacement = document.createElement('video');
      replacement.style.cssText = old.style.cssText;
      replacement.autoplay = true;
      replacement.loop = true;
      replacement.src = ${JSON.stringify(mediaUrl)};
      old.replaceWith(replacement);
    }`);
    await waitForReady(previous);
    await expectMedia('SPA 替换 video 后沿用最近值及静音', { volume: 0.37, rate: 1.75, muted: true });
    await waitForReports(3);

    previous = released;
    await guest.executeJavaScript(`{
      const media = document.querySelector('video');
      media.src = ${JSON.stringify(mediaUrl + '#part2')};
      media.volume = 1;
      media.playbackRate = 1;
      media.muted = false;
      media.load();
      media.play().catch(() => {});
    }`);
    await waitForReady(previous);
    await expectMedia('同一 video 换源与初始化默认值不会覆盖偏好', { volume: 0.37, rate: 1.75, muted: true });
    await waitForReports(3);

    previous = released;
    await guest.executeJavaScript(`{
      history.replaceState({}, '', '?p=2');
      const media = document.querySelector('video');
      media.volume = 1;
      media.playbackRate = 1;
      media.muted = false;
    }`);
    await waitForReady(previous);
    await expectMedia('SPA 只切页码且复用媒体源时仍保留设置', { volume: 0.37, rate: 1.75, muted: true });
    await waitForReports(3);

    preferences = { volume: 14, muted: false, playbackRate: 2 };
    guest.send('player', { cmd: 'preferences', ...preferences });
    await guest.executeJavaScript(`new Promise((resolve) => setTimeout(resolve, 50))`);
    await expectMedia('启动器直接更新当前 guest，异步事件回声不重复保存', { volume: 0.14, rate: 2, muted: false });
    await waitForReports(3);

    previous = released;
    await guest.reload();
    await waitForReady(previous);
    await expectMedia('整页重载在首次播放前同步获取最近偏好', { volume: 0.14, rate: 2, muted: false });
    await waitForReports(3);

    await guest.executeJavaScript(`document.querySelector('video').remove()`);
    preferences = { volume: 0, muted: true, playbackRate: 0.75 };
    guest.send('player', { cmd: 'preferences', ...preferences });
    guest.send('player', { cmd: 'play' });
    previous = released;
    await guest.executeJavaScript(`{
      const media = document.createElement('video');
      media.style.cssText = 'width:640px;height:360px';
      media.loop = true;
      media.src = ${JSON.stringify(mediaUrl)};
      document.body.appendChild(media);
      void 0;
    }`);
    await waitForReady(previous);
    await expectMedia('晚出现的 video 记住先到的偏好和播放请求，零音量有效', { volume: 0, rate: 0.75, muted: true });
    await waitForReports(3);

    previous = released;
    await guest.executeJavaScript(`new Promise((resolve, reject) => {
      const replacement = document.createElement('video');
      replacement.loop = true;
      replacement.style.cssText = 'width:640px;height:360px';
      replacement.src = ${JSON.stringify(mediaUrl)};
      replacement.play().then(() => {
        document.querySelector('video').replaceWith(replacement);
        resolve();
      }, reject);
    })`);
    await waitForReady(previous);
    await expectMedia('接管已经开始播放的视频也能解除原生静音', { volume: 0, rate: 0.75, muted: true });
    await waitForReports(3);
    await guest.executeJavaScript(`new Promise((resolve) => {
      document.querySelector('video').remove();
      const media = document.createElement('video');
      media.style.cssText = 'width:640px;height:360px';
      media.loop = true;
      media.addEventListener('loadedmetadata', resolve, { once: true });
      media.src = ${JSON.stringify(mediaUrl)};
      document.body.appendChild(media);
    }).then(() => undefined)`);
    guest.sendInputEvent({ type: 'keyDown', keyCode: 'M' });
    await guest.executeJavaScript(`document.querySelector('video').volume = 0.29`);
    await waitForReports(4);
    await guest.executeJavaScript(`document.querySelector('video').playbackRate = 1.25`);
    await waitForReports(5);
    assert.equal(preferences.volume, 29);
    assert.equal(preferences.playbackRate, 1.25);
    previous = released;
    await guest.executeJavaScript(`document.querySelector('video').play()`);
    await waitForReady(previous);
    await expectMedia('首次播放前通过真实用户交互调整也会保存', { volume: 0.29, rate: 1.25, muted: true });
    preferences = { ...preferences, temporaryPlaybackRate: 2.5 };
    guest.send('player', { cmd: 'preferences', ...preferences });
    await guest.executeJavaScript(`new Promise((resolve) => setTimeout(resolve, 50))`);
    await expectMedia('长按临时倍率不改变媒体默认常规倍率', { rate: 2.5, defaultRate: 1.25 });
    await waitForReports(5);
    await guest.executeJavaScript(`document.querySelector('video').playbackRate = 1`);
    await guest.executeJavaScript(`new Promise((resolve) => setTimeout(resolve, 50))`);
    await expectMedia('临时加速期间播放器回声不覆盖常规倍率', { rate: 2.5, defaultRate: 1.25 });
    await waitForReports(5);

    preferences = { ...preferences, playbackRate: 1.5 };
    guest.send('player', { cmd: 'preferences', ...preferences });
    await guest.executeJavaScript(`new Promise((resolve) => setTimeout(resolve, 50))`);
    await expectMedia('临时加速时更新常规倍率仍保持临时播放', { rate: 2.5, defaultRate: 1.5 });
    previous = released;
    await guest.reload();
    await waitForReady(previous);
    await expectMedia('按住加速整页换 P 仍以临时倍率首播', { rate: 2.5, defaultRate: 1.5 });
    await waitForReports(5);
    delete preferences.temporaryPlaybackRate;
    guest.send('player', { cmd: 'preferences', ...preferences });
    await guest.executeJavaScript(`new Promise((resolve) => setTimeout(resolve, 50))`);
    await expectMedia('松开后回到最新常规倍率且不额外保存', { rate: 1.5, defaultRate: 1.5 });
    await waitForReports(5);

    guest.send('player', { cmd: 'presentation', videoOnly: true });
    await guest.executeJavaScript(`new Promise((resolve) => setTimeout(resolve, 50))`);
    const presentation = await guest.executeJavaScript(`(() => {
      const media = document.querySelector('video');
      const overlay = document.createElement('div');
      overlay.id = 'fake-player-controls';
      overlay.textContent = '播放器控制条';
      document.body.appendChild(overlay);
      const bounds = media.getBoundingClientRect();
      return { controls: getComputedStyle(overlay).visibility, video: getComputedStyle(media).visibility,
        width: bounds.width, height: bounds.height, viewportWidth: innerWidth, viewportHeight: innerHeight };
    })()`);
    assert.equal(presentation.controls, 'hidden');
    assert.equal(presentation.video, 'visible');
    assert.equal(presentation.width, presentation.viewportWidth);
    assert.equal(presentation.height, presentation.viewportHeight);
    console.log('PASS 沉浸时隐藏网页控件，视频覆盖整个访客区域');
    guest.send('player', { cmd: 'presentation', videoOnly: false });
    await guest.executeJavaScript(`new Promise((resolve) => setTimeout(resolve, 50))`);
    assert.equal(await guest.executeJavaScript(`getComputedStyle(document.getElementById('fake-player-controls')).visibility`), 'visible');
    console.log('PASS 退出沉浸恢复网页控件，不残留隐藏样式');
    console.log('媒体回归全部通过');
  } finally {
    host.destroy();
    app.quit();
  }
}

function withTimeout(promise, label) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(label + ' 超过 15 秒')), 15000);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
