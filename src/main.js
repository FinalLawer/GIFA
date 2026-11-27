'use strict';

/**
 * 原神跟跑助手 —— 主进程
 * 职责：无边框置顶窗口、全局快捷键、B 站视频解析、设置持久化
 */

const { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, powerMonitor, powerSaveBlocker, screen, session, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { execFile, execFileSync, spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { createUpdateController, installExitHook, resolveUpdater } = require('./update-controller');
const { githubClient, RELEASES_PAGE } = require('./update-github');
const hookHotkeys = require('./hook-hotkeys');
const gamepad = require('./gamepad');
const { mergeHotkeys, prepareHotkeyUpdate } = require('./hotkey-config');
const { DEFAULT_GAMEPAD, GAMEPAD_ACTION_ALLOWLIST, L3_BUTTON_INDEX, mergeGamepadSettings, createChordState, stepChord, isHoldAction } = require('./gamepad-config');
const sandboxFallback = require('./sandbox-fallback');
const { DEFAULT_BEARING_LAYOUTS, loadBearingLayouts, activeBearingLayout, applyBearingLayout } = require('./bearing-layouts');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// 允许无用户手势自动播放（浮窗场景必须有）
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// 关掉 Chromium 的「后台进程进效率模式」：Windows 11 会在进程所有窗口都最小化时
// 把它判成后台、套上 EcoQoS（低优先级 + 省电调度）。低级钩子跑在独立线程里，
// 一旦被这样降速，按键回调就会超时、甚至被系统悄悄把钩子摘掉 ——
// 表现正是「启动器在前台时热键好用，一最小化就全废，切回来也回不来」。
app.commandLine.appendSwitch('disable-features', 'UseEcoQoSForBackgroundProcess');

/**
 * 是否以管理员（高完整性级别）身份运行。
 *
 * 这条决定了热键在游戏里能不能用：原神这类带反作弊的游戏一律以管理员启动，
 * 而 Windows 的 UIPI 规定 —— **非提权进程的低级键盘/鼠标钩子，收不到提权窗口在前台时的按键**。
 * 于是现象就是「启动器在前台时热键好用，一切进游戏里就全废」，与代码无关。
 * 这不是我们能绕的系统约束，只能提权运行（打包版清单里已要求管理员）。
 */
let cachedElevated = null;
// 提权重启时带上的标记，用来区分「本来就没提权」和「用户刚拒绝过 UAC」
const ELEVATE_FLAG = '--elevated';
function isElevated() {
  if (cachedElevated !== null) return cachedElevated;
  try {
    // 用 PowerShell 而不是 `whoami /groups`：在 Git Bash / MSYS 里启动时，
    // MSYS 会把 `/groups` 当 POSIX 路径转换成 `C:/Program Files/Git/groups`，
    // whoami 直接报「extra operand」→ 提权状态被误判成 false，白弹一次 UAC。
    const psExe = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    );
    const out = execFileSync(
      psExe,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 }
    );
    // S-1-16-12288 = High Mandatory Level（管理员）；中完整性是 S-1-16-8192
    cachedElevated = out.trim().toLowerCase() === 'true';
  } catch {
    cachedElevated = false;
  }
  return cachedElevated;
}

/* ------------------------------------------------- 按需提权重启（UAC） */

/**
 * 以管理员身份重新启动本程序（兜底路径）。
 *
 * 现在打包版是「双击即提权」，配置在 package.json：
 *   win.requestedExecutionLevel = "requireAdministrator"  → 主 exe 清单
 *   portable.requestExecutionLevel = "admin"              → NSIS 自解压壳清单
 * 两层都提权，双击时 Windows 只弹一次 UAC、壳只解压一次，不必进来再点重启。
 *
 * 历史坑（dist-release3）：只给内层 app.exe 加 requireAdministrator、壳仍是 asInvoker，
 * 壳用 ExecWait 启动 app.exe 时 Windows 返回 ERROR_ELEVATION_REQUIRED(740)，
 * 双击毫无反应、进程都不出现。关键是**壳和主程序必须同时提权**。
 *
 * 运行时重启只留给：开发版（electron.exe 无清单）、zip 解压直跑、UAC 被取消后
 * 仍想用普通权限，以及任何清单没生效的场景。提权是为低级键盘钩子服务的：
 * 不提权的话，UIPI 会挡住提权窗口（原神）在前台时的按键。
 */
function relaunchElevated() {
  return new Promise((resolve) => {
    // portable 版必须用**原始 exe**：process.execPath 指向 %TEMP% 里的解压副本，
    // 从那里重启等于从一个随时会被清掉的目录里启动。
    const exePath = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    const argv = process.argv
      .slice(1)
      .filter((a) => !a.startsWith('--inspect') && !a.startsWith('--remote-debugging') && a !== ELEVATE_FLAG);
    // 打上标记：万一下次判断提权状态出错，也不会陷入「无限弹 UAC」
    argv.unshift(ELEVATE_FLAG);

    // PowerShell 单引号字符串里，单引号本身写成两个
    const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
    const argList = argv.length ? ` -ArgumentList @(${argv.map(q).join(',')})` : '';
    const script =
      `Start-Process -FilePath ${q(exePath)}${argList}` +
      ` -WorkingDirectory ${q(process.cwd())} -Verb RunAs -ErrorAction Stop`;

    let child;
    try {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
        { windowsHide: true, stdio: 'ignore' }
      );
    } catch (err) {
      resolve({ ok: false, reason: err.message });
      return;
    }
    child.on('error', (err) => resolve({ ok: false, reason: err.message }));
    child.on('exit', (code) => {
      // 退出码 0 = 提权后的新进程已经创建；非 0 基本都是用户在 UAC 上点了「否」
      resolve(code === 0 ? { ok: true } : { ok: false, reason: 'uac-cancelled' });
    });
  });
}

/* ------------------------------- 数据目录：绿色版 / 安装版 [DATA-DIR-START] */

/**
 * 决定 userData 落在哪 —— 两种发行形态必须分流，否则安装版必坏。
 *
 *  绿色版（zip / portable 单 exe）：exe 同级 data\，整夹拷走设置与 ROI 标定一起走。
 *  安装版（NSIS，装到 Program Files）：%APPDATA%\原神跟跑助手\，
 *    因为 Program Files 对普通用户只读，写 settings.json 会直接抛 EPERM。
 *
 * 判定**只看 installed.flag**（由 build/installer.nsh 安装时写在 exe 同级），
 * 不猜安装路径：有人把绿色版放进 Program Files，也有人把安装版装在 D 盘可写目录，
 * 路径都不可靠。zip 里放的是 portable.flag，安装版里没有它，两者不会混淆。
 *
 * 开发时（npm start）一律用系统默认 %APPDATA%，不动用户已有设置和登录态。
 *
 * 两个老坑：
 * 1. portable 单 exe 先解压到 %TEMP% 再运行，process.execPath 指向临时副本，
 *    真实位置 electron-builder 写在 PORTABLE_EXECUTABLE_DIR 里，必须优先用它。
 * 2. 程序目录不可写时退回 APPDATA，否则启动阶段就会因为建不了 settings.json 报错。
 */
const DATA_DIR_NAME = 'data';
const INSTALLED_FLAG = 'installed.flag';
const PORTABLE_FLAG = 'portable.flag';
const MIGRATE_FROM_FILE = 'migrate-from.txt';
const MIGRATED_FLAG = '.migrated';
// settings.json 内含 ROI 标定、窗口位置、观看记录；两张 png 是识别调试截图。
// Chromium 缓存 / GPUCache / 日志一律不搬，避免把几十 MB 垃圾和隐私带进新目录。
const MIGRATE_FILES = ['settings.json', 'bearing-dump.png', 'bearing-frame.png'];
const MIGRATE_LOGIN_DIR = 'Partitions';
const MIGRATE_LOGIN_FILES = ['Local State'];

function programDir() {
  return process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe'));
}

function hasProgramFlag(name) {
  try {
    return fs.existsSync(path.join(programDir(), name));
  } catch {
    return false;
  }
}

function readTextSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** 只复制白名单文件，且绝不覆盖目标里已存在的内容 */
function copyFileIfAbsent(src, dst) {
  if (!fs.existsSync(src) || fs.existsSync(dst)) return false;
  try {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    return true;
  } catch (err) {
    console.warn(`[data] 复制 ${path.basename(src)} 失败：${err.code || err.message}`);
    return false;
  }
}

function copyTreeIfAbsent(srcDir, dstDir) {
  if (!fs.existsSync(srcDir) || fs.existsSync(dstDir)) return;
  try {
    fs.mkdirSync(dstDir, { recursive: true });
    for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
      const from = path.join(srcDir, ent.name);
      const to = path.join(dstDir, ent.name);
      if (ent.isDirectory()) copyTreeIfAbsent(from, to);
      else if (ent.isFile()) copyFileIfAbsent(from, to);
    }
  } catch (err) {
    console.warn(`[data] 复制目录 ${srcDir} 失败：${err.code || err.message}`);
  }
}

/**
 * 旧绿色版 data\ 的可能位置，按优先级：
 *  1. 安装页「迁移旧数据」填的目录 → 写在 exe 同级 migrate-from.txt 第一行
 *  2. GRB_MIGRATE_FROM 环境变量（手动 / CI 用）
 *  3. exe 同级 data\（把安装版覆盖装到原绿色版目录里的场景）
 * 允许填绿色版根目录或它里面的 data 目录，自动识别。
 */
function legacyDataCandidates(target) {
  const out = [];
  const add = (value) => {
    if (!value) return;
    let dir = path.resolve(String(value).trim().replace(/^"|"$/g, ''));
    if (!fs.existsSync(path.join(dir, 'settings.json')) &&
        fs.existsSync(path.join(dir, DATA_DIR_NAME, 'settings.json'))) {
      dir = path.join(dir, DATA_DIR_NAME);
    }
    if (dir !== path.resolve(target) && !out.includes(dir)) out.push(dir);
  };
  const lines = readTextSafe(path.join(programDir(), MIGRATE_FROM_FILE)).split(/\r?\n/);
  add(lines[0]);
  add(process.env.GRB_MIGRATE_FROM);
  add(path.join(programDir(), DATA_DIR_NAME));
  return out;
}

function migrationIncludeLogin() {
  const text = readTextSafe(path.join(programDir(), MIGRATE_FROM_FILE));
  return /includeLogin\s*=\s*1/.test(text) || process.env.GRB_MIGRATE_LOGIN === '1';
}

/**
 * 安装版首次启动时，把旧绿色版的设置 / ROI 标定搬进 %APPDATA%。
 *
 * 登录态（Partitions + Local State）**默认不搬**：过去「打包前顺手把 Cookie 库
 * 拷进 data\」的教训是，那份带凭证的目录会被整包发出去，等于送账号。
 * 这里方向相反 —— 只在本机、从用户明确指定的旧目录搬进本机 APPDATA，
 * 不进任何发布产物，所以做成安装页上的可选项（includeLogin=1）是安全的。
 * 复制而非移动，旧绿色版仍可照常用；.migrated 标记保证只跑一次。
 */
function migrateLegacyData(target) {
  const marker = path.join(target, MIGRATED_FLAG);
  if (fs.existsSync(marker) || fs.existsSync(path.join(target, 'settings.json'))) {
    return { ok: false, reason: 'already-initialized' };
  }
  const source = legacyDataCandidates(target).find(
    (dir) => fs.existsSync(path.join(dir, 'settings.json'))
  );
  if (!source) return { ok: false, reason: 'no-legacy-data' };

  const withLogin = migrationIncludeLogin();
  try {
    fs.mkdirSync(target, { recursive: true });
  } catch (err) {
    console.warn(`[data] 创建 ${target} 失败：${err.code || err.message}`);
    return { ok: false, reason: 'target-not-writable' };
  }

  let copied = 0;
  for (const name of MIGRATE_FILES) {
    if (copyFileIfAbsent(path.join(source, name), path.join(target, name))) copied++;
  }
  if (withLogin) {
    for (const name of MIGRATE_LOGIN_FILES) {
      if (copyFileIfAbsent(path.join(source, name), path.join(target, name))) copied++;
    }
    copyTreeIfAbsent(path.join(source, MIGRATE_LOGIN_DIR), path.join(target, MIGRATE_LOGIN_DIR));
  }
  try {
    fs.writeFileSync(marker, JSON.stringify({ from: source, at: new Date().toISOString(), withLogin }, null, 2), 'utf8');
  } catch (err) {
    console.warn(`[data] 写迁移标记失败：${err.code || err.message}`);
  }
  console.log(`[data] 已从 ${source} 迁移 ${copied} 项${withLogin ? '（含登录态）' : '（不含登录态）'}`);
  return { ok: true, from: source, copied, withLogin };
}

let installMode = 'dev'; // dev | installed | portable | fallback
function resolveUserDataDir() {
  const fallback = app.getPath('userData');
  if (!app.isPackaged) {
    installMode = 'dev';
    return fallback;
  }

  if (hasProgramFlag(INSTALLED_FLAG)) {
    installMode = 'installed';
    try {
      migrateLegacyData(fallback);
    } catch (err) {
      console.warn(`[data] 旧数据迁移异常，继续用 ${fallback}：${err.message}`);
    }
    try {
      fs.mkdirSync(fallback, { recursive: true });
    } catch {}
    return fallback;
  }

  const dir = path.join(programDir(), DATA_DIR_NAME);
  try {
    fs.mkdirSync(dir, { recursive: true });
    // 探写权限：只判断 exists 不够，目录可能存在但没有写权限
    const probe = path.join(dir, '.write-probe');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    installMode = 'portable';
    return dir;
  } catch (err) {
    console.warn(`[data] 程序目录不可写（${err.code || err.message}），回退到 ${fallback}`);
    installMode = 'fallback';
    return fallback;
  }
}

const USER_DATA_DIR = resolveUserDataDir();
app.setPath('userData', USER_DATA_DIR);
// 缓存类目录一并挪过去，否则 C 盘会多出一份 Chromium 缓存
app.setPath('sessionData', USER_DATA_DIR);
/* [DATA-DIR-END] ---------------------------------------------------------- */

// 管理员权限下，部分 Windows 起不了 Chromium 沙箱子进程：GPU 进程连续 launch-failed，
// 约一秒后主进程被 Chromium 主动结束，用户只看到「双击没反应」。这里在第一个子进程
// 创建之前接管：记录启动诊断日志，失败时自动改用兼容模式重启。详见 sandbox-fallback.js。
const sandboxGuard = sandboxFallback.install({ app, dialog, dataDir: USER_DATA_DIR, beforeExit: stopGamepadPoller });


// 支持 `npm start -- --open BV1xx411c7mD`：从命令行/快捷方式直接带视频启动
function argValue(flag) {
  const i = process.argv.indexOf(flag);
  const v = i !== -1 ? process.argv[i + 1] : '';
  return v && !v.startsWith('--') ? v : '';
}
const OPEN_ARG = argValue('--open');

// 播放器与登录窗口共用同一个持久化分区，登录一次全局生效
const BILI_PARTITION = 'persist:bili';

function biliSession() {
  return session.fromPartition(BILI_PARTITION);
}

/** 用该分区的 Cookie 发请求，避开 B 站风控，并且能读到登录态 */
function biliFetch(url, extraHeaders) {
  return biliSession().fetch(url, {
    signal: AbortSignal.timeout(8000),
    headers: {
      'User-Agent': UA,
      Referer: 'https://www.bilibili.com/',
      Accept: 'application/json, text/plain, */*',
      ...(extraHeaders || {})
    }
  });
}

const DEFAULT_HOTKEYS = {  togglePlay: 'Alt+Space',
  seekBack: 'Alt+Left',
  seekFwd: 'Alt+Right',
  prevPart: 'Alt+Up',
  nextPart: 'Alt+Down',
  toggleVisible: 'Alt+H',
  togglePass: 'Alt+L',
  toggleOpacity: 'Alt+O',
  toggleImmersion: 'Alt+I',
  cycleSpeed: 'Alt+S',
  holdSpeed: 'F8'
};

const PLAYBACK_RATES = [1, 1.25, 1.5, 2];
const HOLD_PLAYBACK_RATES = [1.25, 1.5, 2, 2.5, 3];

const HOTKEY_META = [
  // short 是给手柄圆盘扇区用的窄标签，启动器列表仍用 label
  { key: 'togglePlay', label: '播放 / 暂停', short: '暂停' },
  { key: 'seekBack', label: '后退 5 秒', short: '后退' },
  { key: 'seekFwd', label: '前进 5 秒', short: '前进' },
  { key: 'prevPart', label: '上一分 P', short: '上一P' },
  { key: 'nextPart', label: '下一分 P', short: '下一P' },
  { key: 'toggleVisible', label: '隐藏 / 显示浮窗', short: '显隐' },
  { key: 'togglePass', label: '鼠标穿透 开 / 关', short: '穿透' },
  { key: 'toggleOpacity', label: '半透明 开 / 关', short: '透明' },
  { key: 'toggleImmersion', label: '纯视频沉浸 开 / 关', short: '沉浸' },
  { key: 'cycleSpeed', label: '循环倍速 1 / 1.25 / 1.5 / 2', short: '倍速' },
  { key: 'holdSpeed', label: '长按临时加速（松开恢复）', short: '加速', hold: true }
];

/**
 * 启动器「手柄快捷键」的八个方位行，显示顺序按罗盘从北顺时针。
 * key 必须是 gamepad-config.js 的 DIRECTION_NAMES 之一 —— 行名和圆盘参考图扇区上的字
 * 都用它；label 只留给下拉框的悬停说明。
 */
const GAMEPAD_DIR_UI = [
  { key: 'n', label: '北' },
  { key: 'ne', label: '东北' },
  { key: 'e', label: '东' },
  { key: 'se', label: '东南' },
  { key: 's', label: '南' },
  { key: 'sw', label: '西南' },
  { key: 'w', label: '西' },
  { key: 'nw', label: '西北' }
];

const DEFAULT_SETTINGS = {
  // 内容区 896×504 正好 16:9，加上标题栏 30 + 控制条 34 = 604
  bounds: { width: 896, height: 568, x: null, y: null, aspect: 2 },
  pinned: true,
  opacity: 1,
  clickThrough: false,
  mode: 'web',
  volume: 100,
  muted: false,
  playbackRate: 1,
  holdPlaybackRate: 2,
  hoverFadeEnabled: true,
  muxed: false,
  lastText: '',
  lastPart: 1,
  // 「上次看到」：光有 lastText/lastPart 不够 —— 用户记不住的是「哪个视频、第几 P」，
  // 长链接/BV 号看不出片名，所以额外存标题、视频 id、分 P 总数和最后观看时间。
  lastTitle: '',
  lastCover: '',
  lastVideoId: '',
  lastPageCount: 0,
  lastWatchedAt: 0,
  // 下次启动直接把浮窗起来继续播，不用每次重粘链接
  resumeOnLaunch: true,
  hotkeys: { ...DEFAULT_HOTKEYS },
  bearing: {
    ...DEFAULT_BEARING_LAYOUTS,
    enabled: false,
    radius: 110,
    x: null,
    y: null
  },
  // 手柄：L3 按住弹八方向圆盘，右摇杆选动作。结构与出厂值都在 gamepad-config.js
  gamepad: DEFAULT_GAMEPAD,
  /* 剧情自动隐藏：识别到剧情/对话时把叠加层收起来，看完再放回。
   * 判据是模板匹配 —— 截游戏画面左上角一块做归一化互相关，
   * 命中「UI 被禁用」那个图标就认为在放剧情。 */
  storyAutoHide: {
    enabled: false,
    // 相似度阈值，0.75 左右表示形状对上了
    threshold: 0.75,
    // 扫描间隔：GDI 抓图 20~40ms、匹配 40ms，600ms 一轮 CPU 占用很低
    interval: 600,
    // 屏幕上画识别框（黄=识别区域，红=命中位置），排查时有用
    showBox: true,
    // 浮窗本身也藏起来。剧情时浮窗杵在那儿会挡住画面，默认藏
    hideFloat: true
  }
};

/**
 * 记住「上次看到」。换片和切 P 都走这里，字段一次写全。
 * 抽成纯函数是为了能离线回归（只就地改传入对象，不碰 fs / Electron）。
 */
/** 启动时是否自动把浮窗起来继续播（纯函数，便于离线回归） */
function shouldResumeOnLaunch(s, openArg) {
  if (openArg) return false; // --open 显式指定了视频，别抢
  return !!(s && s.resumeOnLaunch !== false && s.lastText);
}

function noteWatched(s, info) {
  if (!s) return s;
  const text = String(info.text || '').trim();
  if (text) s.lastText = text;
  const p = Number(info.p);
  if (Number.isFinite(p) && p > 0) s.lastPart = Math.floor(p);
  if (info.id) s.lastVideoId = String(info.id);
  if (info.title !== undefined) s.lastTitle = String(info.title || '');
  if (info.cover !== undefined) s.lastCover = typeof info.cover === 'string' ? info.cover : '';
  if (info.pageCount !== undefined) {
    const n = Number(info.pageCount);
    s.lastPageCount = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }
  s.lastWatchedAt = Date.now();
  return s;
}

/** 音量用 0..100 保存；静音独立保存，取消静音时仍能回到原来的音量。 */
function playbackSettings(s = {}) {
  const volume = Number.isFinite(s.volume) ? Math.min(100, Math.max(0, s.volume)) : 100;
  return {
    volume,
    muted: typeof s.muted === 'boolean' ? s.muted : volume === 0,
    playbackRate: Number.isFinite(s.playbackRate) ? Math.min(3, Math.max(0.25, s.playbackRate)) : 1
  };
}

function updatePlaybackSettings(s, patch = {}) {
  const next = playbackSettings(s);
  if (Number.isFinite(patch.volume)) {
    next.volume = Math.min(100, Math.max(0, patch.volume));
    // 启动器拖动音量时，正值取消静音；只切静音不会丢掉原来的音量。
    next.muted = next.volume === 0;
  }
  if (typeof patch.muted === 'boolean') next.muted = patch.muted;
  if (Number.isFinite(patch.playbackRate)) next.playbackRate = Math.min(3, Math.max(0.25, patch.playbackRate));
  const changed = Object.keys(next).some((key) => s[key] !== next[key]);
  Object.assign(s, next);
  return changed;
}

let settings = structuredClone(DEFAULT_SETTINGS);
let win = null;         // 跟跑浮窗（无边框置顶，只管播放）
let consoleWin = null;  // 启动器（所有设置都在这里）
let loginWin = null;
let playbackGuest = null;
let playbackToken = 0;
let playbackGate = 0;
let quittingFromConsole = false; // 关启动器 = 退出整个应用，防止 closed 事件重入
let failedHotkeys = [];
let saveTimer = null;
// 渲染层上报的输入状态：打字时不该触发单键热键，但「窗口在前台」不等于在打字
let typingInField = false;
let capturingHotkey = false;
let holdSpeedActive = false;
const holdSpeedSources = new Set();
let immersion = false;
let immersionSession = 0;
let immersionBounds = null;
let immersionAspect = 0;
let restoredImmersionBounds = null;
let hoverFaded = false;
let hoverTimer = null;
let hoverCandidate = false;
let hoverCandidateAt = 0;

/* ------------------------------------------------------------------ 设置 */

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    const rawBearing = raw.bearing || {};

    settings = {
      ...structuredClone(DEFAULT_SETTINGS),
      ...raw,
      ...playbackSettings(raw),
      holdPlaybackRate: HOLD_PLAYBACK_RATES.includes(raw.holdPlaybackRate) ? raw.holdPlaybackRate : 2,
      hoverFadeEnabled: raw.hoverFadeEnabled !== false,
      bounds: { ...DEFAULT_SETTINGS.bounds, ...(raw.bounds || {}) },
      hotkeys: mergeHotkeys(DEFAULT_HOTKEYS, raw.hotkeys),
      bearing: {
        ...loadBearingLayouts(rawBearing, raw.lastVideoId),
        enabled: !!rawBearing.enabled,
        radius: Number.isFinite(rawBearing.radius) ? rawBearing.radius : DEFAULT_SETTINGS.bearing.radius,
        x: Number.isFinite(rawBearing.x) ? rawBearing.x : null,
        y: Number.isFinite(rawBearing.y) ? rawBearing.y : null
      },
      gamepad: mergeGamepadSettings(DEFAULT_SETTINGS.gamepad, raw.gamepad),
      storyAutoHide: {
        ...DEFAULT_SETTINGS.storyAutoHide,
        ...(raw.storyAutoHide || {}),
        /* 旧的 1200ms 默认值迁到新的 600ms：那个值会让「进剧情要 2.4 秒」，
         * 用户反馈隐藏太慢。只迁移这一个特定值，用户自己调的其它值保留。 */
        interval: (() => {
          const v = Number(raw.storyAutoHide && raw.storyAutoHide.interval);
          return Number.isFinite(v) && v > 0 && v !== 1200 ? v : DEFAULT_SETTINGS.storyAutoHide.interval;
        })()
      }
    };
  } catch {
    settings = structuredClone(DEFAULT_SETTINGS);
  }
}

function flushSettings(atomic = false) {
  clearTimeout(saveTimer);
  saveTimer = null;
  const file = settingsFile();
  let temporaryDir;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const contents = JSON.stringify(settings, null, 2);
    if (atomic) {
      temporaryDir = fs.mkdtempSync(path.join(path.dirname(file), '.settings-'));
      const temporary = path.join(temporaryDir, 'settings.json');
      fs.writeFileSync(temporary, contents, { encoding: 'utf8', flag: 'wx', flush: true });
      fs.renameSync(temporary, file);
    } else {
      fs.writeFileSync(file, contents, 'utf8');
    }
    return true;
  } catch (err) {
    console.error('[settings] 写入失败', err);
    return false;
  } finally {
    if (temporaryDir) {
      try { fs.unlinkSync(path.join(temporaryDir, 'settings.json')); } catch {}
      try { fs.rmdirSync(temporaryDir); } catch {}
    }
  }
}

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSettings, 250);
}

function isPlaybackGuest(sender) {
  return !!(win && !win.isDestroyed() && sender === playbackGuest &&
    sender.hostWebContents === win.webContents);
}

function isPlaybackMessage(event, message) {
  return isPlaybackGuest(event.sender) && event.senderFrame === event.sender.mainFrame &&
    message && message.token === playbackToken;
}

function playbackState() {
  return {
    ...playbackSettings(settings),
    holdActive: holdSpeedActive,
    temporaryPlaybackRate: holdSpeedActive ? settings.holdPlaybackRate : null
  };
}

function guestPlaybackSettings() {
  return {
    ...playbackSettings(settings),
    ...(holdSpeedActive ? { temporaryPlaybackRate: settings.holdPlaybackRate } : {})
  };
}

function publishPlaybackSettings() {
  if (playbackGuest && !playbackGuest.isDestroyed()) {
    playbackGuest.send('player', { cmd: 'preferences', ...guestPlaybackSettings() });
  }
  broadcast('playback:state', playbackState());
}

function showNotice(text) {
  broadcast('app:notice', text);
}

function cyclePlaybackRate() {
  const current = PLAYBACK_RATES.indexOf(settings.playbackRate);
  const playbackRate = PLAYBACK_RATES[(current + 1) % PLAYBACK_RATES.length];
  updatePlaybackSettings(settings, { playbackRate });
  persist();
  publishPlaybackSettings();
  broadcast('settings:changed', settings);
  showNotice(`常规倍速 ${playbackRate}×${holdSpeedActive ? `（长按中 ${settings.holdPlaybackRate}×，松开恢复）` : ''}`);
  return playbackRate;
}

function setHoldSpeed(on, source = 'keyboard') {
  if (on && win && !win.isDestroyed()) holdSpeedSources.add(source);
  else holdSpeedSources.delete(source);
  const next = holdSpeedSources.size > 0;
  if (next === holdSpeedActive) return;
  holdSpeedActive = next;
  publishPlaybackSettings();
  showNotice(next ? `临时 ${settings.holdPlaybackRate}× · 松开恢复 ${settings.playbackRate}×` : `已恢复 ${settings.playbackRate}×`);
}

function cancelTemporarySpeed() {
  holdSpeedSources.clear();
  resetGamepadSession();
  setHoldSpeed(false);
  hookHotkeys.cancelHeld();
}

function attachPlaybackGuest(guest) {
  playbackGuest = guest;
  immersionAspect = 0;
  // 首次附加立即静音。之后由新文档的同步 player:settings 再次静音，取消导航时保留原文档的声音。
  guest.setAudioMuted(true);
  guest.on('render-process-gone', () => {
    if (playbackGuest === guest) immersionAspect = 0;
  });
  guest.once('destroyed', () => {
    if (playbackGuest === guest) {
      playbackGuest = null;
      immersionAspect = 0;
    }
  });
}

function isPlaybackPage(value, requireVideoPath = true) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === 'https://www.bilibili.com' && !url.username && !url.password &&
      (!requireVideoPath || /^\/video\/(?:BV[0-9A-Za-z]{10}|av\d+)\/?$/.test(url.pathname));
  } catch {
    return false;
  }
}

function supportsPlaybackCompatibility() {
  return process.platform === 'win32' && sandboxGuard.mode === 'normal';
}

function isPlaybackSandboxCrash(details) {
  return (details.reason === 'crashed' || details.reason === 'abnormal-exit') &&
    (details.exitCode >>> 0) === 0x80000003;
}

/* ------------------------------------------------------------------ 窗口 */

function clampBounds(b) {
  let width = Math.max(240, Math.round(b.width || 896));
  let height = Math.max(150, Math.round(b.height || 568));

  // 老配置是 540×340（2:1 扁条，画面上下被压得只剩一条）。只做一次性纠正，
  // 之后用户自己拉伸的任意比例都尊重，不再干预。
  if (b.aspect !== 2 && width < 720) {
    const maxW = Math.round(screen.getPrimaryDisplay().workArea.width * 0.8);
    width = Math.min(896, maxW);
    height = Math.round((width / 16) * 9) + 64; // 标题栏 30 + 控制条 34
  }

  const area = screen.getPrimaryDisplay().workArea;
  let x = Number.isFinite(b.x) ? Math.round(b.x) : area.x + area.width - width - 40;
  let y = Number.isFinite(b.y) ? Math.round(b.y) : area.y + 60;

  // 窗口变宽后可能顶出屏幕右边（老配置是贴着右边缘摆的），拉回来。
  // 用窗口所在的那块屏，别把它从副屏拽回主屏。
  const near = screen.getDisplayNearestPoint({ x, y }).workArea;
  if (x + width > near.x + near.width - 8) x = Math.max(near.x + 8, near.x + near.width - width - 40);

  // 保证窗口至少有一部分落在某个屏幕上
  const visible = screen.getAllDisplays().some((d) => {
    const w = d.workArea;
    return x + width > w.x + 40 && x < w.x + w.width - 40 && y + height > w.y && y < w.y + w.height - 40;
  });
  if (!visible) {
    x = area.x + area.width - width - 40;
    y = area.y + 60;
  }
  return { x, y, width, height };
}

function applyPin() {
  if (!win || win.isDestroyed()) return;
  if (settings.pinned) {
    // screen-saver 层级：在 Windows 上能压住绝大多数全屏/无边框窗口
    win.setAlwaysOnTop(true, 'screen-saver');
    try {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } catch {
      /* 平台不支持则忽略 */
    }
  } else {
    win.setAlwaysOnTop(false);
  }
}

function createWindow() {
  // 浮窗可以被关掉再重新启动，这里做成幂等
  if (win && !win.isDestroyed()) {
    win.showInactive();
    applyPin();
    if (settings.bearing.enabled) showOverlay();
    return win;
  }

  const bounds = clampBounds(settings.bounds);
  // 老的扁条尺寸被纠正过一次就记下来，之后用户自己拉成什么比例都不再干预
  if (settings.bounds.aspect !== 2) {
    settings.bounds = { ...bounds, aspect: 2 };
    persist();
  }

  win = new BrowserWindow({
    ...bounds,
    minWidth: 240,
    minHeight: 150,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0d0e12',
    show: false,
    resizable: true,
    maximizable: false,
    minimizable: true,
    fullscreenable: true,
    hasShadow: true,
    alwaysOnTop: settings.pinned,
    title: '原神跟跑助手',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      spellcheck: false,
      backgroundThrottling: false
    }
  });

  applyPin();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // webview 里的 <video> 一旦走 HTML 全屏，它会铺满整个客户区并盖住我们自己的
  // 标题栏和设置按钮 —— 这是「视频全屏后找不到设置」的根因。直接禁掉，
  // 让 B 站播放器的全屏按钮改走窗口全屏（见 webview-preload 里的 requestFullscreen 改写）。
  let compatibilityAvailable = false;
  win.webContents.on('will-attach-webview', (event, prefs, params) => {
    if (params.partition !== BILI_PARTITION || !isPlaybackPage(params.src)) {
      event.preventDefault();
      return;
    }
    Object.assign(prefs, {
      preload: path.join(__dirname, 'webview-preload.js'),
      disableHtmlFullscreen: true,
      sandbox: !compatibilityAvailable || prefs.sandbox !== false,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      webSecurity: true,
      webviewTag: false
    });
  });
  win.webContents.on('did-attach-webview', (_event, guest) => {
    attachPlaybackGuest(guest);
    let navigated = false;
    guest.setWindowOpenHandler(() => ({ action: 'deny' }));
    guest.on('will-navigate', (event) => {
      if (!isPlaybackPage(event.url, false)) event.preventDefault();
    });
    guest.on('will-redirect', (event) => {
      if (event.isMainFrame && !isPlaybackPage(event.url, false)) event.preventDefault();
    });
    guest.once('did-navigate', () => { navigated = true; });
    guest.on('render-process-gone', (_gone, details) => {
      if (!isPlaybackGuest(guest) || details.reason === 'clean-exit') return;
      if (!navigated && supportsPlaybackCompatibility() && isPlaybackSandboxCrash(details)) compatibilityAvailable = true;
      sandboxGuard.log('bili-render-gone', JSON.stringify({ ...details, beforeNavigation: !navigated }));
    });
    guest.on('preload-error', () => {
      if (isPlaybackGuest(guest)) sandboxGuard.log('bili-preload-error', '播放页访客脚本加载失败');
    });
  });
  win.webContents.on('render-process-gone', () => {
    cancelTemporarySpeed();
    if (win && !win.isDestroyed()) setImmersion(false);
  });

  // 全屏状态回传给渲染页，用来切换「标题栏/控制条浮层化」
  const sendFullscreen = (on) => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('win:state', { fullscreen: on });
  };
  win.on('enter-full-screen', () => sendFullscreen(true));
  win.on('leave-full-screen', () => sendFullscreen(false));

  const videoWindow = win;
  videoWindow.once('ready-to-show', () => {
    if (win !== videoWindow || videoWindow.isDestroyed()) return;
    videoWindow.showInactive(); // 不抢游戏焦点
    applyWindowPresentation();
    if (settings.bearing.enabled) showOverlay();
    notifyFloatState();
  });

  // 窗口失焦后重新压制层级（某些窗口会抢到上面）
  win.on('blur', () => applyPin());

  const rememberBounds = () => {
    if (!win || win.isDestroyed() || immersionBounds) return;
    const b = win.getBounds();
    if (restoredImmersionBounds && sameWindowBounds(b, restoredImmersionBounds)) return;
    restoredImmersionBounds = null;
    // 保留 aspect 标记：用户手动拉过之后就不该在下次启动时被强行改回 16:9
    settings.bounds = { ...settings.bounds, x: b.x, y: b.y, width: b.width, height: b.height, aspect: 2 };
    persist();
  };
  win.on('move', rememberBounds);
  win.on('resize', rememberBounds);
  win.on('restore', syncImmersionBoundsAfterRestore);

  win.on('closed', () => {
    win = null;
    cancelTemporarySpeed();
    clearInterval(hoverTimer);
    hoverTimer = null;
    immersion = false;
    immersionBounds = null;
    immersionAspect = 0;
    restoredImmersionBounds = null;
    hoverFaded = false;
    overlayPlacing = false;
    lastBearing = null;
    // 主窗关了，叠加层不能独自留下，否则 window-all-closed 不触发、进程退不掉
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.destroy();
    notifyFloatState();
  });
}

/* ---------------------------------------------------------------- 启动器 */

function sendTo(w, channel, payload) {
  if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
}

/** 广播给所有界面窗口：设置改了，两边都要跟上 */
function broadcast(channel, payload) {
  sendTo(win, channel, payload);
  sendTo(consoleWin, channel, payload);
}

function floatState() {
  return { running: !!(win && !win.isDestroyed()), immersion, hoverFaded };
}

function notifyFloatState() {
  broadcast('float:state', floatState());
}

/** 浮窗当前该用的不透明度：剧情隐藏优先，其次悬停变淡。 */
function effectiveOpacity() {
  // 剧情中用全透明而不是 hide()：藏起来再放回会牵扯置顶层级、沉浸状态，
  // 以及和「用户自己关了浮窗」的区分。
  if (storyHidden && settings.storyAutoHide && settings.storyAutoHide.hideFloat) return 0;
  return hoverFaded ? Math.min(settings.opacity, 0.1) : settings.opacity;
}

function applyWindowPresentation() {
  if (!win || win.isDestroyed()) return;
  win.setIgnoreMouseEvents(immersion || settings.clickThrough, { forward: true });
  win.setOpacity(effectiveOpacity());
}

function updateHoverFade() {
  if (!win || win.isDestroyed()) return;
  const point = screen.getCursorScreenPoint();
  const bounds = win.getBounds();
  const inside = immersion && settings.hoverFadeEnabled && win.isVisible() && !win.isMinimized() &&
    point.x >= bounds.x && point.x < bounds.x + bounds.width &&
    point.y >= bounds.y && point.y < bounds.y + bounds.height;
  if (inside !== hoverCandidate) {
    hoverCandidate = inside;
    hoverCandidateAt = Date.now();
  }
  if (inside === hoverFaded || Date.now() - hoverCandidateAt < 120) return;
  hoverFaded = inside;
  applyWindowPresentation();
  notifyFloatState();
}

function syncHoverFade() {
  clearInterval(hoverTimer);
  hoverTimer = null;
  hoverCandidate = false;
  hoverCandidateAt = Date.now();
  hoverFaded = false;
  applyWindowPresentation();
  if (immersion && settings.hoverFadeEnabled) hoverTimer = setInterval(updateHoverFade, 60);
}

/* ---------------------------------------------------- 剧情自动隐藏
 *
 * 视频进入剧情/对话时把叠加层全部收起来，看完再放回来。
 * 识别由访客页做（模板匹配），这里只负责「藏」和「恢复」。
 *
 * 为什么必须记快照：这些窗口本来就有的开有的关（弹幕没开、字幕没开）。
 * 恢复时无脑全部 show 会把用户根本没开的窗口也弹出来。
 */
let storyHidden = false;
/** 藏之前各窗口的可见状态，恢复时按它还原 */
let storySnapshot = null;

function storyWindows() {
  return [['overlay', overlayWin]];
}

function setStoryHidden(on) {
  const want = !!on;
  if (want === storyHidden) return;
  // 先落状态：effectiveOpacity() 读的是 storyHidden，晚赋值会用到旧值
  storyHidden = want;

  if (want) {
    storySnapshot = {};
    for (const [name, w] of storyWindows()) {
      storySnapshot[name] = !!w && !w.isDestroyed() && w.isVisible();
      try {
        if (w && !w.isDestroyed()) w.hide();
      } catch {
        /* 窗口正在销毁 */
      }
    }
    /* 浮窗用「全透明」而不是 hide()：
     * 用户要的是「看不见但还在」，藏起来再放回会牵扯置顶层级、
     * 沉浸状态、以及和「他自己关了浮窗」的区分，容易出错。 */
    console.log('[story]', { hidden: true, snapshot: storySnapshot, hideFloat: !!settings.storyAutoHide.hideFloat });
    applyWindowPresentation();
  } else {
    const snap = storySnapshot || {};
    for (const [name, w] of storyWindows()) {
      if (!snap[name] || !w || w.isDestroyed()) continue;
      try {
        w.showInactive();
      } catch {
        /* 窗口正在销毁 */
      }
    }
    storySnapshot = null;
    applyWindowPresentation();
    if (win && !win.isDestroyed()) applyPin();
    console.log('[story]', { hidden: false });
  }
}

/* ------------------------------------------- 剧情识别（模板匹配）
 *
 * 判据来自 BetterGI：AutoSkip 用 disabled_ui.png 匹配
 *     roi = rect(0, 0, cw/3, ch/8)      // 游戏画面左上角 1/3 宽 × 1/8 高
 * 那个「眼睛带斜杠」的图标只在 UI 被禁用（剧情/对话）时出现，
 * 命中它就等于「现在在放剧情」。
 *
 * 实现：截一次屏 → 裁出左上角那块 → 灰度 → 和模板做归一化互相关（NCC）。
 * 只搜一小块而不是全屏，是这套方案跑得动的前提：
 * 640×135 里滑 28×20 的模板约 7 万个位置，隔点粗搜 + 邻域精修后
 * 单次几十毫秒。
 */
const STORY_ROI = { w: 1 / 3, h: 1 / 8 };
/** 模板是按 1920 宽做的，用它换算缩放 */
const STORY_BASE_WIDTH = 1920;

const storyWatch = {
  timer: 0,
  busy: false,
  tmpl: null,
  on: false,
  hits: 0,
  misses: 0,
  /* 连续「看不见游戏」的轮数。截不到图既不是命中也不是落空，
   * 单独计一路，否则切屏/抓图打嗝会直接把剧情状态翻回去。 */
  stale: 0,
  /* 是否已降频空转。连续看不见游戏时说明用户压根没开游戏（或在干别的），
   * 还按 600ms 一轮去抓图纯属白烧 CPU —— 降到 STORY_IDLE_INTERVAL，
   * 等真的抓到一帧再恢复正常间隔。 */
  slow: false,
  lastScore: 0,
  lastLogged: 0,
  lastDumpAt: 0
};

/* 去抖门槛（轮数 × interval 才是时长，默认 600ms 一轮）。
 * 进剧情连续 2 轮（约 1.2s）：再快会在 UI 淡入时误藏。
 * 出剧情连续 3 轮（约 1.8s）：比进剧情迟钝一档，避开转场/切镜头，
 *   但也不至于慢到用户以为卡住。
 * 看不见游戏连续 8 轮（约 4.8s）：短时间切屏不该把叠加层弹回来。 */
const STORY_ENTER_HITS = 2;
const STORY_EXIT_MISSES = 3;
const STORY_STALE_LIMIT = 8;
/* 连续看不见游戏后，扫描降到这个间隔（毫秒）。
 * 没开游戏时仍按 600ms 空转纯属白烧 CPU —— 尤其是兜底路径每轮要 500ms+。
 * 降到 3 秒，代价是游戏回来后最多晚 3 秒才响应，可以接受。 */
const STORY_IDLE_INTERVAL = 3000;

/** BGRA Buffer → 灰度 Float32Array */
function grayFromBitmap(bmp, w, h) {
  const out = new Float32Array(w * h);
  for (let i = 0, j = 0; j < out.length; i += 4, j += 1) {
    out[j] = 0.299 * bmp[i + 2] + 0.587 * bmp[i + 1] + 0.114 * bmp[i];
  }
  return out;
}

/** 读模板：官方 28×20 的 PNG → 灰度 */
function loadStoryTemplate() {
  if (storyWatch.tmpl) return storyWatch.tmpl;
  try {
    const file = path.join(__dirname, '..', 'assets', 'story', 'icon.png');
    const img = nativeImage.createFromPath(file);
    if (img.isEmpty()) return null;
    const { width, height } = img.getSize();
    storyWatch.tmpl = { w: width, h: height, gray: grayFromBitmap(img.toBitmap(), width, height) };
    console.log('[story]', { template: [width, height] });
    return storyWatch.tmpl;
  } catch (err) {
    console.log('[story]', { templateError: String((err && err.message) || err) });
    return null;
  }
}

/**
 * 按屏幕宽度把模板等比缩放（模板是按 1920 宽做的）。
 *
 * 结果按尺寸缓存：原来每次扫描都重新读盘 + 解码 PNG + 缩放，
 * 一秒一次白白烧 CPU。尺寸只跟分辨率有关，缓存住就行。
 */
const storyTmplCache = new Map();

function scaledStoryTemplate(tmpl, screenW) {
  const scale = screenW / STORY_BASE_WIDTH;
  if (Math.abs(scale - 1) <= 0.08) return tmpl;

  const nw = Math.max(8, Math.round(tmpl.w * scale));
  const nh = Math.max(6, Math.round(tmpl.h * scale));
  const key = nw + 'x' + nh;
  const cached = storyTmplCache.get(key);
  if (cached) return cached;

  try {
    const file = path.join(__dirname, '..', 'assets', 'story', 'icon.png');
    const img = nativeImage.createFromPath(file);
    const small = img.resize({ width: nw, height: nh, quality: 'best' });
    const made = { w: nw, h: nh, gray: grayFromBitmap(small.toBitmap(), nw, nh) };
    storyTmplCache.set(key, made);
    return made;
  } catch {
    return tmpl;
  }
}

/**
 * 在 gray 里滑模板，返回最佳 NCC 分数。
 * 粗搜隔 2 像素，再在最佳点邻域逐像素精修 —— 全像素搜要慢四倍，收益很小。
 */
function matchTemplate(gray, gw, gh, tmpl) {
  const tw = tmpl.w;
  const th = tmpl.h;
  // 统一返回结构，调用方不用区分「没得比」和「比完了」
  if (gw < tw || gh < th) return { score: -1, x: 0, y: 0, w: tw, h: th };

  const t = tmpl.gray;
  let tMean = 0;
  for (let i = 0; i < t.length; i += 1) tMean += t[i];
  tMean /= t.length;
  let tNorm = 0;
  for (let i = 0; i < t.length; i += 1) {
    const d = t[i] - tMean;
    tNorm += d * d;
  }
  tNorm = Math.sqrt(tNorm) || 1e-6;

  const scoreAt = (ox, oy) => {
    let sMean = 0;
    for (let y = 0; y < th; y += 1) {
      const row = (oy + y) * gw + ox;
      for (let x = 0; x < tw; x += 1) sMean += gray[row + x];
    }
    sMean /= tw * th;

    let num = 0;
    let sNorm = 0;
    for (let y = 0; y < th; y += 1) {
      const row = (oy + y) * gw + ox;
      const trow = y * tw;
      for (let x = 0; x < tw; x += 1) {
        const a = gray[row + x] - sMean;
        const b = t[trow + x] - tMean;
        num += a * b;
        sNorm += a * a;
      }
    }
    const den = Math.sqrt(sNorm) * tNorm;
    return den > 1e-6 ? num / den : 0;
  };

  let best = -1;
  let bx = 0;
  let by = 0;
  for (let y = 0; y + th <= gh; y += 2) {
    for (let x = 0; x + tw <= gw; x += 2) {
      const sc = scoreAt(x, y);
      if (sc > best) {
        best = sc;
        bx = x;
        by = y;
      }
    }
  }
  for (let y = Math.max(0, by - 2); y <= Math.min(gh - th, by + 2); y += 1) {
    for (let x = Math.max(0, bx - 2); x <= Math.min(gw - tw, bx + 2); x += 1) {
      const sc = scoreAt(x, y);
      if (sc > best) {
        best = sc;
        bx = x;
        by = y;
      }
    }
  }
  // 位置一起返回：调试时要画框，光有分数没法判断「差在哪」
  return { score: best, x: bx, y: by, w: tw, h: th };
}

/** 截一次屏，裁左上角那块，返回灰度与尺寸 */
/**
 * 找原神窗口。
 *
 * BetterGI 是「只抓游戏窗口」的：全屏截图在有浮窗、有其他窗口、
 * 或者游戏不是全屏时都不可靠 —— 左上角那块可能压根不是游戏画面。
 * 这里用 windows 原生 API 拿到游戏窗口的位置，再按窗口矩形裁。
 *
 * 返回屏幕物理像素坐标（和截图分辨率同一坐标系）。
 */
/**
 * 常驻的 GDI 截屏进程。
 *
 * 每次起一个 PowerShell 要 600~900ms（进程启动 + JIT + Add-Type），
 * 而真正截图只要 10~30ms。常驻下来之后，一行 stdin 换一行 PNG 就够快。
 *
 * 用的 API 和 BetterGI 一样：System.Drawing.Graphics.CopyFromScreen，
 * 底层是 GDI BitBlt。Electron 的 desktopCapturer 走 GPU 合成管线，
 * 实测一次 500~3400ms，根本没法做到「一秒扫一次还不卡」。
 */
const storyCapture = {
  proc: null,
  queue: [],
  buf: '',
  starting: false,
  failures: 0,
  retryAt: 0,
  // 上一轮失败原因：obscured / not-foreground / no-window / bad-size ...
  lastReason: '',
  // 上一轮认到的窗口身份（句柄|类名|进程|标题），没截图时也留着
  lastIdent: null
};

function stopStoryCaptureProc() {
  if (storyCapture.proc) {
    try {
      storyCapture.proc.stdin.end();
      storyCapture.proc.kill();
    } catch {
      /* 进程已退出 */
    }
  }
  storyCapture.proc = null;
  storyCapture.buf = '';
  // 挂起的请求全部按失败收场，否则 await 永远不返回
  const pending = storyCapture.queue.splice(0);
  for (const p of pending) p(null);
}

function ensureStoryCaptureProc() {
  if (storyCapture.proc && !storyCapture.proc.killed) return storyCapture.proc;
  if (storyCapture.starting) return null;
  /* 连续失败就退避：起一个 PowerShell 要 600~900ms（还要 Add-Type 编译），
   * 如果脚本一直失败还每 1.2 秒重起一个，机器会被拖垮。
   * 失败三次后停 60 秒再试。 */
  const now = Date.now();
  if (storyCapture.failures >= 3 && now < storyCapture.retryAt) return null;

  const script = path.join(__dirname, '..', 'assets', 'story', 'capture.ps1');
  storyCapture.starting = true;
  try {
    const proc = spawn(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }
    );

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      storyCapture.buf += chunk;
      let nl = storyCapture.buf.indexOf('\n');
      while (nl >= 0) {
        const line = storyCapture.buf.slice(0, nl).trim();
        storyCapture.buf = storyCapture.buf.slice(nl + 1);
        // NONE:<reason>|窗口身份 里带上原因，主进程据此决定要不要恢复窗口。
        // 身份也一起留着：没截到图时「窗口对不上」和「游戏没开」是两回事。
        if (line.startsWith('NONE')) {
          const rest = line.slice(line.indexOf(':') + 1);
          const cut = rest.indexOf('|');
          storyCapture.lastReason = cut >= 0 ? rest.slice(0, cut) : rest || 'unknown';
          storyCapture.lastIdent = cut >= 0 ? parseStoryWindowIdent(rest.slice(cut + 1)) : null;
        } else {
          storyCapture.lastReason = '';
          storyCapture.lastIdent = null;
        }
        const pending = storyCapture.queue.shift();
        if (pending) pending(parseStoryCaptureLine(line));
        nl = storyCapture.buf.indexOf('\n');
      }
    });

    const onDead = () => {
      storyCapture.proc = null;
      storyCapture.failures += 1;
      if (storyCapture.failures >= 3) storyCapture.retryAt = Date.now() + 60000;
      stopStoryCaptureProc();
    };
    proc.on('exit', onDead);
    proc.on('error', onDead);

    storyCapture.proc = proc;
    storyCapture.failures = 0;
    return proc;
  } catch {
    return null;
  } finally {
    storyCapture.starting = false;
  }
}

/** 认窗口身份的 "句柄|类名|进程id|标题" → 对象。取不到返回 null */
function parseStoryWindowIdent(ident) {
  if (!ident) return null;
  const parts = String(ident).split('|');
  if (parts.length < 2) return null;
  const hwnd = Number(parts[0]) || 0;
  const cls = parts[1] || '';
  const pid = Number(parts[2]) || 0;
  // 标题里可能带 '|'，剩下的全部拼回去
  const title = parts.slice(3).join('|');
  if (!hwnd && !cls && !pid) return null;
  return { hwnd, cls, pid, title };
}

/** "gameW|gameH|roiW|roiH|base64png|ident" → 结果对象；NONE 返回 null */
function parseStoryCaptureLine(line) {
  if (!line || line.startsWith('NONE')) return null;
  /* 格式：客户区X|Y|游戏宽|游戏高|ROI宽|ROI高|PNG|偏移X|偏移Y|整块尺寸|窗口身份
   * 窗口身份放最后：标题里可能带 '|'，它之后的字段没法按固定下标取。 */
  const parts = line.split('|');
  if (parts.length < 7) return null;
  const [srcX, srcY, gw, gh, rw, rh, b64] = parts;
  if (!b64) return null;
  try {
    const img = nativeImage.createFromBuffer(Buffer.from(b64, 'base64'));
    if (img.isEmpty()) return null;
    const size = img.getSize();
    // 子区域偏移：命中坐标要加上它才能换算回整块 ROI
    const offX = Number(parts[7]) || 0;
    const offY = Number(parts[8]) || 0;
    // '640x135' → 整块尺寸，画识别区域框要用它（不能拿子区域去画）
    const full = String(parts[9] || '').match(/^(\d+)x(\d+)$/);
    // 窗口身份：句柄 / 类名 / 进程 id / 标题。日志里必须留一份，
    // 否则「分数一直 0.4x」时无从判断是截错窗口还是模板不对。
    const ident = parseStoryWindowIdent(parts.slice(10).join('|'));
    return {
      gray: grayFromBitmap(img.toBitmap(), size.width, size.height),
      w: size.width,
      h: size.height,
      img,
      // 客户区在屏幕上的位置和尺寸（物理像素），画框要用
      srcX: Number(srcX) || 0,
      srcY: Number(srcY) || 0,
      gameW: Number(gw) || 0,
      gameH: Number(gh) || 0,
      roiW: Number(rw) || size.width,
      roiH: Number(rh) || size.height,
      // 这次实际截的子区域相对整块的偏移
      offX,
      offY,
      // 整块 ROI 尺寸（未裁剪时等于 roiW/roiH）
      fullW: full ? Number(full[1]) : Number(rw) || size.width,
      fullH: full ? Number(full[2]) : Number(rh) || size.height,
      found: true,
      // 名字仍然给一个默认值，但真正的证据是下面的 ident
      name: (ident && ident.title) || '原神',
      ident
    };
  } catch {
    return null;
  }
}

/** 让常驻进程截一张。超时或进程挂了就返回 null */
/* 图标固定在左上角这块区域里（实测命中点在 640×135 内的 266,38 与 361,45，
 * 随浮窗是否遮挡/UI 版本会有 ±100px 的横向漂移）。
 * 先只抓这块，匹配面积降到约 1/5，一轮从 100ms 降到 ~25ms。
 * 范围要给足余量 —— 之前取 x 0.30~0.56 太窄，图标右移 3px 就落到界外，
 * 结果每轮都回退整块，反而更慢。 */
const STORY_TIGHT_ROI = { x: 0.24, y: 0.02, w: 0.42, h: 0.80 };

function grabStoryRoiGdi(tight = true) {
  if (process.platform !== 'win32') return Promise.resolve(null);

  return new Promise((resolve) => {
    const proc = ensureStoryCaptureProc();
    if (!proc) {
      resolve(null);
      return;
    }

    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };

    storyCapture.queue.push(finish);
    // 1.5 秒还没回来说明这条链路不正常，直接判失败，别拖着
    setTimeout(() => {
      if (done) return;
      const i = storyCapture.queue.indexOf(finish);
      if (i >= 0) storyCapture.queue.splice(i, 1);
      finish(null);
    }, 1500);

    try {
      const cmd = tight
        ? `CAP ${STORY_TIGHT_ROI.x} ${STORY_TIGHT_ROI.y} ${STORY_TIGHT_ROI.w} ${STORY_TIGHT_ROI.h}\n`
        : 'CAP\n';
      proc.stdin.write(cmd);
    } catch {
      finish(null);
    }
  });
}

/**
 * 兜底：GDI 拿不到时（权限、非 Windows、PowerShell 被策略禁掉），
 * 退回 Electron 的 desktopCapturer。
 *
 * 这条路径慢得多（一次 500ms 以上），而且有可能截到挡住游戏的窗口，
 * 所以只在 GDI 失败时用，日志里会标明走了哪条路。
 */
/** 兜底路径截图的宽度：只需要左上角一块，960 够用且快 */
const STORY_CAPTURE_WIDTH = 960;

async function grabStoryRoiFallback() {
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: STORY_CAPTURE_WIDTH, height: Math.round((STORY_CAPTURE_WIDTH * 9) / 16) }
  });
  if (!sources.length) return null;

  /* 只在窗口确实就是游戏时才用兜底结果。
   *
   * 松匹配会抓到自己的浮窗或标题带「原神」的浏览器，拿那种画面去比对
   * 只有 0.4~0.5 的低分，看着像「没命中图标」，其实是截错了对象。
   * 判据与抓图脚本一致：标题必须就是游戏名，并按 id 排掉本进程窗口。
   * 对不上返回 null，上层当成「这一轮没结论」而不是「剧情结束」。 */
  const GAME_TITLE = /^原神(\s|$|[·\-—_（(])|^Genshin\s*Impact\b/i;
  /* id 格式是 window:窗口句柄:YY，YY=1 表示「本进程自己的窗口」。
   * 这一条不靠猜标题，直接按 Electron 的定义排掉我们自己的浮窗。 */
  const isOwnWindow = (x) => String(x.id || '').split(':')[2] === '1';
  const looksLikeGame = (x) => {
    if (isOwnWindow(x)) return false;
    const n = String(x.name || '').trim();
    if (!n) return false;
    // 兜底再排一次本项目窗口，防止 id 规则在别的系统上不成立
    if (n.includes('跟跑助手')) return false;
    return GAME_TITLE.test(n);
  };
  const src = sources.find(looksLikeGame) || null;
  if (!src || !src.thumbnail || src.thumbnail.isEmpty()) {
    storyCapture.lastReason = 'fallback-no-game-window';
    return null;
  }

  const game = src.thumbnail;
  const gs = game.getSize();
  if (gs.width < 200 || gs.height < 100) return null;

  const rw = Math.min(gs.width, Math.max(32, Math.round(gs.width * STORY_ROI.w)));
  const rh = Math.min(gs.height, Math.max(32, Math.round(gs.height * STORY_ROI.h)));
  const cropped = game.crop({ x: 0, y: 0, width: rw, height: rh });
  const cs = cropped.getSize();

  return {
    gray: grayFromBitmap(cropped.toBitmap(), cs.width, cs.height),
    w: cs.width,
    h: cs.height,
    img: cropped,
    gameW: gs.width,
    gameH: gs.height,
    found: true,
    name: src.name || '',
    fallback: true
  };
}

/** 对外保持同一个入口，先走 GDI，不行再退回 desktopCapturer */
/* GDI 已经给出**明确结论**的原因码。
 *
 * capture.ps1 一旦返回这些，就说明它成功枚举了窗口、拿到了确定答案：
 *   no-window      窗口列表里没有游戏
 *   no-rect        拿到了窗口但取不到矩形
 *   obscured       识别区域被别的窗口盖住
 *   not-foreground 游戏不在前台
 *   bad-size/bad-roi 尺寸或区域不合法
 *
 * 这种情况下不能再走 desktopCapturer 兜底。兜底是给「GDI 本身不可用」
 * 准备的（PowerShell 被禁用、非 Windows、C# 编译失败），它要枚举全部窗口
 * 并抓缩略图，一次 500ms 以上。而 GDI 已经枚举过窗口、只是没找到游戏时，
 * 兜底只会得到同样的结论，白付代价。
 */
const STORY_GDI_DEFINITE_MISS = new Set([
  'no-window', 'no-rect', 'obscured', 'not-foreground', 'bad-size', 'bad-roi'
]);

/** 整块 1/3×1/8 再抓一次。只在两级搜索的第一级没命中时才调用。 */
async function grabStoryRoiWide() {
  const gdi = await grabStoryRoiGdi(false);
  if (gdi) return gdi;
  // GDI 已给出确定结论（含被遮挡 / 不在前台）时不许走兜底：
  // 兜底对后台窗口返回缓存帧，会给出接近 1 的假满分。
  if (STORY_GDI_DEFINITE_MISS.has(storyCapture.lastReason)) return null;
  return grabStoryRoiFallback();
}

/** 对外保持同一个入口，先走 GDI，不行再退回 desktopCapturer */
async function grabStoryRoi() {
  const gdi = await grabStoryRoiGdi(true);
  if (gdi) return gdi;

  /* GDI 已给出明确结论时，不再走 desktopCapturer 兜底。
   *
   * 兜底只该在 GDI 根本没跑起来时用（PowerShell 被禁用、非 Windows、
   * C# 编译失败 —— 对应 bad-cmd）。只要 GDI 返回了明确原因，说明它成功
   * 枚举了窗口、拿到了确定答案：
   *
   *   no-window / no-rect / bad-size / bad-roi
   *     游戏不在窗口列表或几何不合法。兜底枚举的是同一批窗口，
   *     结论一样，却要多付枚举全部窗口并抓缩略图的代价。
   *
   *   obscured / not-foreground
   *     游戏在，但不在前台或被盖住。兜底对后台窗口返回缓存的旧帧，
   *     那帧里只要有图标就给接近 1 的假满分 —— 比低分危险得多：
   *     用户切去看攻略，程序却判定还在剧情，叠加层一直藏着不回来。
   */
  if (STORY_GDI_DEFINITE_MISS.has(storyCapture.lastReason)) return null;

  return grabStoryRoiFallback();
}


/* ------------------------------------------------- 识别结果遮罩
 *
 * 参考 BetterGI 的「识别结果遮罩」：把识别区域和命中位置直接画在屏幕上。
 * 排查「为什么不生效」时，看一眼框落在哪就知道是 ROI 偏了、模板不对，
 * 还是压根没命中 —— 比翻日志快得多。
 */
let storyBoxWin = null;

function ensureStoryBox() {
  if (storyBoxWin && !storyBoxWin.isDestroyed()) return storyBoxWin;
  const d = screen.getPrimaryDisplay();
  storyBoxWin = new BrowserWindow({
    ...d.bounds,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'storybox', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  storyBoxWin.setAlwaysOnTop(true, 'screen-saver');
  storyBoxWin.setIgnoreMouseEvents(true, { forward: true });
  storyBoxWin.loadFile(path.join(__dirname, 'storybox', 'index.html'));

  storyBoxWin.once('ready-to-show', () => {
    try {
      if (storyBoxWin && !storyBoxWin.isDestroyed()) storyBoxWin.showInactive();
    } catch {
      /* 窗口正在销毁 */
    }
  });
  storyBoxWin.on('closed', () => {
    storyBoxWin = null;
  });
  return storyBoxWin;
}

/** 只清空画面，不销毁窗口 —— 每秒销毁重建窗口会额外制造卡顿 */
function clearStoryBox() {
  try {
    if (storyBoxWin && !storyBoxWin.isDestroyed()) {
      storyBoxWin.webContents.send('storybox:draw', { found: false });
    }
  } catch {
    /* 窗口正在销毁 */
  }
}

function destroyStoryBox() {
  if (storyBoxWin && !storyBoxWin.isDestroyed()) {
    try {
      storyBoxWin.destroy();
    } catch {
      /* 已经没了 */
    }
  }
  storyBoxWin = null;
}

/**
 * 把这次的识别结果画到遮罩上。
 *
 * 坐标换算：截屏拿到的是**物理像素**，canvas 用的是 CSS 像素，
 * 中间差一个 display.scaleFactor；还要把客户区原点搬到窗口内坐标。
 */
function drawStoryBox(roi, hit, score, threshold) {
  if (!settings.storyAutoHide || settings.storyAutoHide.showBox === false) {
    clearStoryBox();
    return;
  }

  /* 兜底路径（desktopCapturer）拿不到客户区在屏幕上的坐标，
   * 硬画会画到错的地方，不如不画。 */
  if (typeof roi.srcX !== 'number' || typeof roi.srcY !== 'number') {
    clearStoryBox();
    return;
  }

  const d = screen.getPrimaryDisplay();
  const k = d.scaleFactor || 1;
  const ox = d.bounds.x;
  const oy = d.bounds.y;

  const toCss = (px, py, pw, ph) => ({
    x: px / k - ox,
    y: py / k - oy,
    w: pw / k,
    h: ph / k
  });

  /* 分数低时「最佳匹配位置」是噪声：模板在画面任何地方都能凑出 0.4~0.6，
   * 那个位置每帧都在跳，看起来像程序在乱抓。
   * 只在这两个条件之一成立时才画命中框：
   *   1. 分数已经够高，位置有意义
   *   2. 已经判定命中（比分门槛还高）
   * 其余情况只画识别区域，画面保持干净。 */
  /* 分数低时「最佳匹配位置」是噪声：模板在画面任何地方都能凑出 0.5~0.7，
   * 那个位置每帧都在跳，看起来像程序在乱抓。
   * 只在分数已经够高（接近命中）时才画命中框，其余只留识别区域。
   * 门槛取 0.72：比阈值 0.75 略低一点，能在「快要命中」时给出提示，
   * 又不至于让 0.6x 的噪声框满屏跳。 */
  const STORY_HIT_VISIBLE = 0.72;
  const showHit = !!hit && score >= Math.min(STORY_HIT_VISIBLE, threshold);

  const payload = {
    found: !!roi.found,
    score,
    hitHit: score >= threshold,
    /* 黄框画整块识别区域（不是这次截的子区域），用户才知道程序在看哪儿；
     * 红框要加上子区域偏移才会落在真实位置。 */
    roi: toCss(roi.srcX || 0, roi.srcY || 0, roi.fullW || roi.roiW || roi.w, roi.fullH || roi.roiH || roi.h),
    hit: showHit
      ? toCss((roi.srcX || 0) + (roi.offX || 0) + hit.x, (roi.srcY || 0) + (roi.offY || 0) + hit.y, hit.w, hit.h)
      : null
  };

  const w = ensureStoryBox();
  const send = () => {
    try {
      if (w && !w.isDestroyed()) w.webContents.send('storybox:draw', payload);
    } catch {
      /* 窗口正在销毁 */
    }
  };
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', send);
  else send();
}

async function storyProbe() {
  if (storyWatch.busy) return;
  const cfg = settings.storyAutoHide;
  if (!cfg || !cfg.enabled) return;
  const tmpl = loadStoryTemplate();
  if (!tmpl) return;

  storyWatch.busy = true;
  const t0 = Date.now();
  try {
    const tGrab = Date.now();
    /* 两级搜索：先只抓图标所在的小区域（快约 10 倍），
     * 没命中再退回整块 1/3×1/8。
     * 平时走小区域，一轮 100ms → 约 25ms；
     * 布局真变了（分辨率 / UI 缩放 / 别的客户端）也不会漏，只是那一轮慢一点。 */
    let roi = await grabStoryRoi();
    if (roi) {
      // 这次抓的是子区域时，模板要按子区域宽度缩放才能比较
      const shotW = roi.w / STORY_TIGHT_ROI.w / STORY_ROI.w;
      const narrowTmpl = scaledStoryTemplate(loadStoryTemplate(), shotW);
      const preHit = narrowTmpl ? matchTemplate(roi.gray, roi.w, roi.h, narrowTmpl) : null;
      const thrNow = Number(cfg.threshold) || 0.75;
      if (!preHit || preHit.score < thrNow) {
        // 小区域没找到：退回整块再来一次（只在必要时付这份钱）
        const wide = await grabStoryRoiWide();
        if (wide) roi = wide;
      }
    }
    if (!roi) {
      /* 截不到图 = 这一轮没有结论，不是「剧情结束」。
       *
       * 以前这里一帧失败就立刻 setStoryHidden(false)，于是：
       * 用户切一下屏、抓图打一次嗝，叠加层就弹回来，回到游戏又藏起来 ——
       * 肉眼看到的就是「一直在抽」。日志里 9 秒一翻就是这么来的。
       *
       * 现在的规则：连续 STORY_STALE_LIMIT 轮都看不见游戏，才认为
       * 用户确实离开了（或者关了游戏），这时恢复窗口。
       * 中途只要截到一帧就清零，短暂切屏完全不影响状态。 */
      storyWatch.stale += 1;
      clearStoryBox();
      const reason = storyCapture.lastReason || 'unknown';
      if (storyWatch.stale < STORY_STALE_LIMIT) {
        if (Date.now() - storyWatch.lastLogged > 5000) {
          storyWatch.lastLogged = Date.now();
          console.log('[story]', {
            skip: reason,
            stale: storyWatch.stale,
            hold: storyWatch.on,
            win: storyCapture.lastIdent || null
          });
        }
        return;
      }
      if (storyWatch.on) {
        storyWatch.on = false;
        storyWatch.hits = 0;
        setStoryHidden(false);
      }
      if (Date.now() - storyWatch.lastLogged > 5000) {
        storyWatch.lastLogged = Date.now();
        console.log('[story]', {
          skip: reason,
          stale: storyWatch.stale,
          giveUp: true,
          win: storyCapture.lastIdent || null
        });
      }
      /* 已经确认「看不见游戏」很多轮了：降到慢速轮询。
       *
       * 不这么做的话，定时器会一直按 600ms 空转 —— 用户没开游戏、
       * 或者只是在干别的事时，程序每 600ms 醒一次去枚举窗口、抓图、
       * 匹配模板，纯属白烧 CPU。日志里 stale 涨到 698 就是这来的。
       * 降到 3 秒一轮，代价是「游戏重新出现后最多晚 3 秒才反应过来」，
       * 对自动隐藏来说完全可以接受。 */
      if (!storyWatch.slow) {
        storyWatch.slow = true;
        const iv = rearmStoryWatch(STORY_IDLE_INTERVAL);
        console.log('[story]', { idle: true, interval: iv });
      }
      return;
    }
    // 截到图了，说明刚才的「看不见」是暂时的
    storyWatch.stale = 0;
    // 之前降过频就恢复正常节奏
    if (storyWatch.slow) {
      storyWatch.slow = false;
      const iv = rearmStoryWatch(storyNormalInterval());
      console.log('[story]', { idle: false, interval: iv });
    }
    const grabMs = Date.now() - tGrab;

    const tMatch = Date.now();
    /* 模板按「整块 ROI 对应的屏幕宽度」缩放。
     * 用 roi.fullW 而不是 roi.w：子区域时 roi.w 只有整块的四分之一，
     * 直接拿它算会把模板缩得过小，分数全崩。 */
    const t = scaledStoryTemplate(tmpl, (roi.fullW || roi.w) / STORY_ROI.w);
    const hit = matchTemplate(roi.gray, roi.w, roi.h, t);
    const score = hit.score;
    const matchMs = Date.now() - tMatch;
    const ms = Date.now() - t0;
    storyWatch.lastScore = score;


    /* 没找到原神窗口时截到的是桌面/别的窗口，那里的「匹配」纯属巧合。
     * 拿它去藏窗口会有很荒唐的后果：游戏明明没开，浮窗却被藏了。
     * 所以这种情况直接跳过判定，只保留日志。 */
    if (!roi.found) {
      /* 兜底路径拿不到窗口坐标时也算「没结论」，同样不该推进状态机 ——
       * 否则一次截错对象就会被当成落空，把刚进去的剧情判成结束。 */
      storyWatch.stale += 1;
      if (Date.now() - storyWatch.lastLogged > 5000) {
        storyWatch.lastLogged = Date.now();
        console.log('[story]', {
          skip: 'no-window',
          stale: storyWatch.stale,
          score: Math.round(score * 1000) / 1000,
          win: roi.ident || null
        });
      }
      return;
    }

    const thr = Number(cfg.threshold) || 0.75;
    // 每轮都把识别结果画到遮罩上，肉眼能看到「在看哪儿、命中的位置」
    drawStoryBox(roi, hit, score, thr);

    if (score >= thr) {
      storyWatch.hits += 1;
      storyWatch.misses = 0;
    } else {
      storyWatch.misses += 1;
      storyWatch.hits = 0;
    }

    /* 去抖：进剧情要连续 STORY_ENTER_HITS 轮，出剧情要连续 STORY_EXIT_MISSES 轮。
     * 单帧误判很常见（UI 淡入淡出、转场），只认连续。
     * 出剧情那一侧刻意比进剧情更迟钝 —— 用户感受到的「抽动」几乎都发生在
     * 剧情结束前后：转场、镜头切换、UI 复位都会让图标短暂消失。 */
    if (!storyWatch.on && storyWatch.hits >= STORY_ENTER_HITS) {
      storyWatch.on = true;
      setStoryHidden(true);
    } else if (storyWatch.on && storyWatch.misses >= STORY_EXIT_MISSES) {
      storyWatch.on = false;
      setStoryHidden(false);
    }

    // 15 秒最多记一条，够调阈值又不刷屏
    if (Date.now() - storyWatch.lastLogged > 15000) {
      storyWatch.lastLogged = Date.now();
      console.log('[story]', {
        score: Math.round(score * 1000) / 1000,
        // 换算成整块 ROI 坐标，和子区域无关 —— 这样不同版本、不同裁剪下的
        // 日志可以直接对比，不会被子区域偏移带偏
        at: [hit.x + (roi.offX || 0), hit.y + (roi.offY || 0)],
        roi: [roi.w, roi.h],
        tmpl: [t.w, t.h],
        // found=false 说明没找到原神窗口，退回全屏截的 —— 那种情况多半不准
        found: roi.found,
        name: roi.name,
        // 截的是哪个窗口：句柄 / 类名 / 进程 / 标题。
        // 没有这一项，「分数低」到底是窗口抓错了还是模板不对，分不清。
        win: roi.ident || null,
        game: [roi.gameW, roi.gameH],
        // 分段耗时：grab 慢说明截屏是瓶颈，match 慢说明搜索范围太大
        ms,
        grabMs,
        matchMs,
        on: storyWatch.on
      });
    }
  } catch (err) {
    console.log('[story]', { error: String((err && err.message) || err) });
  } finally {
    storyWatch.busy = false;
  }
}

function stopStoryWatch() {
  if (storyWatch.timer) {
    clearInterval(storyWatch.timer);
    storyWatch.timer = 0;
  }
  // 常驻的截屏进程一起收掉，别留个 PowerShell 挂在那里
  stopStoryCaptureProc();
  destroyStoryBox();
  /* 停扫时一定要把窗口放回来。
   * 否则一旦上次判定为「剧情中」，关掉开关后窗口就永远藏着了 ——
   * 用户只会看到「点了启动跟跑什么都没出来」。 */
  if (storyHidden || storyWatch.on) {
    storyWatch.on = false;
    setStoryHidden(false);
  }
  storyWatch.hits = 0;
  storyWatch.misses = 0;
  storyWatch.stale = 0;
  storyWatch.slow = false;
  if (storyWatch.on) {
    storyWatch.on = false;
    setStoryHidden(false);
  }
}

/** 配置里的正常扫描间隔（与 DEFAULT_SETTINGS.storyAutoHide.interval 同口径） */
function storyNormalInterval() {
  const cfg = settings.storyAutoHide;
  return Math.max(300, Math.min(5000, Number(cfg && cfg.interval) || 600));
}

/** 按给定间隔重挂定时器。降频和恢复正常都走这里，避免两处各写一遍 clear/set。 */
function rearmStoryWatch(iv) {
  if (storyWatch.timer) {
    clearInterval(storyWatch.timer);
    storyWatch.timer = 0;
  }
  storyWatch.timer = setInterval(storyProbe, iv);
  return iv;
}

function restartStoryWatch() {
  stopStoryWatch();
  const cfg = settings.storyAutoHide;
  if (!cfg || !cfg.enabled) return;
  const iv = rearmStoryWatch(storyNormalInterval());
  console.log('[story]', { watch: true, interval: iv });
}


function sameWindowBounds(first, second) {
  return first.x === second.x && first.y === second.y && first.width === second.width && first.height === second.height;
}

function fitImmersionPosition(start, size, fittedSize, workStart, workSize) {
  const workEnd = workStart + workSize;
  // Windows 的 DPI 换算可能让已贴边的窗口相差 1–2 个逻辑像素。
  const atStart = Math.abs(start - workStart) <= 2;
  const atEnd = Math.abs(start + size - workEnd) <= 2;
  if (atStart && !atEnd) return workStart;
  if (atEnd && !atStart) return workEnd - fittedSize;
  // 普通位置或两侧都贴边时，沿这个轴居中。
  const centered = start + Math.round((size - fittedSize) / 2);
  return Math.max(workStart, Math.min(workEnd - fittedSize, centered));
}

function fitImmersionWindow() {
  if (!immersion || !immersionBounds || !immersionAspect || !win || win.isDestroyed() || win.isFullScreen() || win.isMinimized()) return;
  const original = immersionBounds;
  const { workArea } = screen.getDisplayMatching(original);
  const current = win.getBounds();
  const content = win.getContentBounds();
  const frameW = Math.max(0, current.width - content.width);
  const frameH = Math.max(0, current.height - content.height);
  const maxW = Math.max(1, Math.min(original.width, workArea.width) - frameW);
  const maxH = Math.max(1, Math.min(original.height, workArea.height) - frameH);
  const width = Math.max(1, Math.min(maxW, Math.round(maxH * immersionAspect))) + frameW;
  const height = Math.max(1, Math.min(maxH, Math.round(maxW / immersionAspect))) + frameH;
  const x = fitImmersionPosition(original.x, original.width, width, workArea.x, workArea.width);
  const y = fitImmersionPosition(original.y, original.height, height, workArea.y, workArea.height);
  const bounds = { x, y, width, height };
  if (!sameWindowBounds(current, bounds)) win.setBounds(bounds);
}

function restoreImmersionWindow(bounds, correctRounding) {
  if (win.isFullScreen() || sameWindowBounds(win.getBounds(), bounds)) return;
  let requested = bounds;
  win.setBounds(requested);
  if (!correctRounding) return;
  const keys = ['x', 'y', 'width', 'height'];
  for (let retry = 0; retry < 2; retry += 1) {
    const applied = win.getBounds();
    if (sameWindowBounds(applied, bounds) || keys.some((key) => Math.abs(bounds[key] - applied[key]) > 2)) return;
    requested = Object.fromEntries(keys.map((key) => [key, requested[key] + bounds[key] - applied[key]]));
    if (requested.width <= 0 || requested.height <= 0) return;
    win.setBounds(requested);
  }
}

function syncImmersionBoundsAfterRestore() {
  if (immersion) return fitImmersionWindow();
  if (!immersionBounds || !win || win.isDestroyed() || win.isMinimized()) return;
  restoreImmersionWindow(immersionBounds, true);
  restoredImmersionBounds = win.getBounds();
  immersionBounds = null;
}

function setImmersion(on) {
  const next = !!on;
  if (next && (!win || win.isDestroyed())) createWindow();
  if (!win || win.isDestroyed()) return false;
  if (next) {
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.showInactive();
  }
  if (immersion === next) return immersion;
  if (next) {
    immersionBounds ||= win.getBounds();
    immersionAspect = 0;
    immersionSession += 1;
    immersion = true;
  }
  win.setResizable(!next);
  win.setMovable(!next);
  if (next) {
    restoreImmersionWindow(immersionBounds, false);
  } else {
    immersionAspect = 0;
    immersion = false;
    syncImmersionBoundsAfterRestore();
  }
  syncHoverFade();
  sendTo(win, 'win:state', { immersion });
  if (playbackGuest && !playbackGuest.isDestroyed()) {
    playbackGuest.send('player', { cmd: 'presentation', videoOnly: immersion, token: playbackToken, immersionSession });
  }
  notifyFloatState();
  showNotice(immersion ? `已进入纯视频沉浸 · ${settings.hotkeys.toggleImmersion || '启动器开关'} 退出` : '已退出纯视频沉浸');
  return immersion;
}

/** 启动器窗口：16:9、居中、按工作区留边等比缩放（小屏/125% 缩放也不出界） */
function consoleBounds(work) {
  const maxW = Math.max(800, work.width - 80);
  const maxH = Math.max(450, work.height - 70);
  let width = Math.min(1280, maxW);
  let height = Math.round((width * 9) / 16);
  if (height > maxH) {
    height = maxH;
    width = Math.round((height * 16) / 9);
  }
  width = Math.round(width);
  height = Math.round(height);
  return {
    width,
    height,
    x: Math.round(work.x + (work.width - width) / 2),
    y: Math.round(work.y + (work.height - height) / 2)
  };
}

function createConsole() {
  if (consoleWin && !consoleWin.isDestroyed()) {
    if (consoleWin.isMinimized()) consoleWin.restore();
    consoleWin.show();
    consoleWin.focus();
    return consoleWin;
  }

  // 首次打开固定 16:9（1280×720 基准），屏幕放不下时等比缩，并居中显示
  const work = screen.getPrimaryDisplay().workArea;
  const box = consoleBounds(work);

  consoleWin = new BrowserWindow({
    width: box.width,
    height: box.height,
    x: box.x,
    y: box.y,
    minWidth: 800,
    minHeight: 450,
    title: '原神跟跑助手 · 启动器',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    backgroundColor: '#1e1e1e',
    autoHideMenuBar: true,
    // Window Controls Overlay 的颜色、高度与 console.css 的 --chrome / --title-h 一致。
    ...(process.platform === 'win32'
      ? { titleBarStyle: 'hidden', titleBarOverlay: { color: '#1e1e1e', symbolColor: '#e6e6e6', height: 40 } }
      : {}),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });

  consoleWin.loadFile(path.join(__dirname, 'console', 'index.html'));

  // 最小化/恢复都补挂一次钩子。Windows 对低级钩子有「钩子过程超时就被静默摘掉」的
  // 规矩，而窗口最小化恰恰会让主进程忙上一阵（窗口销毁、合成器重排），
  // 正好是钩子最容易被打掉的时候；最小化后 1 秒补一次，切回前台再补一次，
  // 用户不必为了热键失灵去重启程序。
  consoleWin.on('minimize', () => setTimeout(() => hookHotkeys.rearm(), 1000));
  consoleWin.on('restore', () => hookHotkeys.rearm());

  consoleWin.once('ready-to-show', () => {
    consoleWin.show();
    sandboxGuard.startupComplete();
    notifyFloatState();
  });

  consoleWin.on('closed', () => {
    consoleWin = null;
    // 关启动器就是退出整个应用：跟跑视频窗、方位叠加层、登录窗一起收掉。
    // 旧逻辑只在「浮窗没开」时 quit，于是开着跟跑时关启动器，视频窗会留在
    // 屏幕上、进程也不退出，用户还得再去任务栏手动关一次。
    if (quittingFromConsole) return;
    quittingFromConsole = true;
    for (const w of [win, overlayWin, loginWin, discWin]) {
      try {
        if (w && !w.isDestroyed()) w.destroy();
      } catch (err) {
        console.warn('[quit] 关闭窗口失败：', err.message);
      }
    }
    app.quit();
  });

  return consoleWin;
}

// 强力置顶：层级被抢时自动恢复
setInterval(() => {
  if (!win || win.isDestroyed() || !settings.pinned) return;
  if (!win.isAlwaysOnTop()) applyPin();
}, 2500);

/* ------------------------------------------------------- 方位标记叠加层 */

let overlayWin = null;
let overlayReleaseTimer = null;
let overlayPlacing = false;
let lastBearing = null;

function clearBearingOverlay() {
  lastBearing = null;
  sendTo(overlayWin, 'bearing', { clear: true });
}

function overlaySize() {
  // 半径 ×2 再留 12% 余量，箭头尖端才不会贴到窗口边被裁掉
  return Math.round(Math.max(60, Number(settings.bearing.radius) || 110) * 2.24);
}

function overlayBounds() {
  const size = overlaySize();
  const area = screen.getPrimaryDisplay().workArea;
  const cx = Number.isFinite(settings.bearing.x) ? settings.bearing.x : area.x + 260;
  const cy = Number.isFinite(settings.bearing.y) ? settings.bearing.y : area.y + 260;
  return {
    x: Math.round(cx - size / 2),
    y: Math.round(cy - size / 2),
    width: size,
    height: size
  };
}

function createOverlay() {
  if (overlayWin && !overlayWin.isDestroyed()) return overlayWin;

  overlayWin = new BrowserWindow({
    ...overlayBounds(),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'overlay', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setIgnoreMouseEvents(true, { forward: true });

  // 拖动后记住圆心，下次启动原地复活
  overlayWin.on('move', () => {
    if (!overlayWin || overlayWin.isDestroyed()) return;
    const b = overlayWin.getBounds();
    settings.bearing.x = Math.round(b.x + b.width / 2);
    settings.bearing.y = Math.round(b.y + b.height / 2);
    persist();
  });

  const overlay = overlayWin;
  overlay.on('closed', () => {
    if (overlayWin !== overlay) return;
    clearTimeout(overlayReleaseTimer);
    overlayReleaseTimer = null;
    overlayWin = null;
  });
  overlay.webContents.on('did-finish-load', () => {
    if (overlayWin !== overlay || overlay.isDestroyed()) return;
    overlay.webContents.send('mode', overlayPlacing ? 'place' : 'lock');
    if (lastBearing) overlay.webContents.send('bearing', lastBearing);
    if (settings.bearing.enabled && (win || overlayPlacing) && !overlay.isVisible()) overlay.showInactive();
  });
  overlay.loadFile(path.join(__dirname, 'overlay', 'index.html'));
  return overlay;
}

function showOverlay() {
  clearTimeout(overlayReleaseTimer);
  overlayReleaseTimer = null;
  const overlay = createOverlay();
  if (!overlay.isVisible() && !overlay.webContents.isLoading()) overlay.showInactive();
  return overlay;
}

function setOverlayPlacing(placing) {
  // 不传参数 = 按当前状态切换。主进程是唯一真相源：以前启动器每次都硬传
  // true，第二下点「锁定位置」又进了一次放置模式，红圈永远锁不上。
  // 显式传 true/false 仍然保留，供热键等需要幂等设置的调用方使用。
  overlayPlacing = placing === undefined || placing === null ? !overlayPlacing : !!placing;
  const w = showOverlay();

  if (overlayPlacing) {
    w.setIgnoreMouseEvents(false);
    w.setFocusable(true);
    w.showInactive();
  } else {
    w.setIgnoreMouseEvents(true, { forward: true });
    w.setFocusable(false);
  }

  if (!w.webContents.isLoading()) w.webContents.send('mode', overlayPlacing ? 'place' : 'lock');
  return overlayPlacing;
}

function setBearingEnabled(on) {
  settings.bearing.enabled = !!on;

  if (on) {
    if (win && !win.isDestroyed()) showOverlay();
  } else {
    overlayPlacing = false;
    clearBearingOverlay();
    const overlay = overlayWin;
    if (overlay && !overlay.isDestroyed()) {
      overlay.setIgnoreMouseEvents(true, { forward: true });
      overlay.setFocusable(false);
      overlay.hide();
      // 短时间内反复切换可以直接复用窗口，闲置后释放独立的渲染进程。
      clearTimeout(overlayReleaseTimer);
      overlayReleaseTimer = setTimeout(() => {
        overlayReleaseTimer = null;
        if (overlayWin === overlay && !overlay.isDestroyed() && !overlay.isVisible()) overlay.destroy();
      }, 3000);
    }
  }

  persist();
  broadcast('settings:changed', settings);
  return settings.bearing;
}

function setOverlayRadius(r) {
  settings.bearing.radius = Math.min(400, Math.max(50, Math.round(Number(r) || 110)));
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.setBounds(overlayBounds());
  }
  persist();
  return settings.bearing.radius;
}

/* ---------------------------------------------------- 手柄八方向圆盘 */

let discWin = null;
let discReady = false;
let discShown = false;
let discHighlight = '';
let chordState = createChordState();
let activeGamepadSlot = null;
const gamepadDevices = new Map();
const gamepadPauses = new Set();

function discSize() {
  // 与 overlaySize 同一条余量规则：半径 ×2 再留 12%，扇区文字才不会被窗口边裁掉
  return Math.round(Math.max(60, Number(settings.gamepad.disc.radius) || 132) * 2.24);
}

function discBounds() {
  const size = discSize();
  const area = screen.getPrimaryDisplay().workArea;
  // 圆盘只在按住 L3 时出现，没定位过就摆主屏正中，手边就是
  const cx = Number.isFinite(settings.gamepad.disc.x) ? settings.gamepad.disc.x : area.x + area.width / 2;
  const cy = Number.isFinite(settings.gamepad.disc.y) ? settings.gamepad.disc.y : area.y + area.height / 2;
  return {
    x: Math.round(cx - size / 2),
    y: Math.round(cy - size / 2),
    width: size,
    height: size
  };
}

/** 扇区标签取自 HOTKEY_META.short，和启动器里的动作名同一份出处 */
function discLabels() {
  const shortByKey = new Map(HOTKEY_META.map((meta) => [meta.key, meta.short || meta.label]));
  const labels = {};
  for (const [direction, action] of Object.entries(settings.gamepad.map)) {
    labels[direction] = action ? shortByKey.get(action) || action : '未绑定';
  }
  return labels;
}

function createDisc() {
  if (discWin && !discWin.isDestroyed()) return discWin;

  const window = new BrowserWindow({
    ...discBounds(),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'disc', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  discWin = window;
  discReady = false;
  window.setIgnoreMouseEvents(true, { forward: true });
  window.on('closed', () => {
    if (discWin !== window) return;
    discWin = null;
    discReady = false;
    resetGamepadSession();
  });
  window.webContents.on('render-process-gone', () => {
    if (!window.isDestroyed()) window.destroy();
  });
  window.once('ready-to-show', () => {
    if (discWin !== window || window.isDestroyed()) return;
    discReady = true;
    if (discShown) window.showInactive();
  });
  window.webContents.on('did-finish-load', () => {
    if (discWin === window && !window.isDestroyed()) {
      window.webContents.send('disc:ui', discUiState(discHighlight));
    }
  });
  window.loadFile(path.join(__dirname, 'disc', 'index.html')).catch((err) => {
    if (window.isDestroyed()) return;
    console.warn('[gamepad] 圆盘加载失败：', err.message);
    window.destroy();
  });
  return window;
}

function discUiState(highlight) {
  // hold 由高亮扇区现算，不用额外记状态：同一份映射下它只随 highlight 变
  return {
    highlight,
    labels: discLabels(),
    hold: isHoldAction(settings.gamepad.map[highlight] || '')
  };
}

function pushDiscState(highlight, force = false) {
  if (!force && highlight === discHighlight) return;
  discHighlight = highlight;
  if (discWin && !discWin.isDestroyed() && !discWin.webContents.isLoading()) {
    discWin.webContents.send('disc:ui', discUiState(discHighlight));
  }
}

function showDisc() {
  const window = createDisc();
  window.setAlwaysOnTop(true, 'screen-saver');
  window.setBounds(discBounds());
  discShown = true;
  pushDiscState('', true);
  if (discReady) window.showInactive();
}

function hideDisc() {
  // 只 hide 不 destroy：圆盘要能反复弹，而重建窗口会连渲染进程一起重新排队
  if (discWin && !discWin.isDestroyed()) discWin.hide();
  discShown = false;
  discHighlight = '';
}

function resetGamepadSession() {
  activeGamepadSlot = null;
  chordState = createChordState();
  if (discShown) hideDisc();
  setHoldSpeed(false, 'gamepad');
}

function gamepadDeviceModels() {
  return Array.from(gamepadDevices.values(), (device) => device.model);
}

function notifyGamepadDevices() {
  sendTo(consoleWin, 'gamepad:devices', gamepadDeviceModels());
}

function handleGamepadFrame(frame) {
  const slot = frame?.slot;
  if (!settings.gamepad.enabled || (!frame?.connected && slot === undefined)) {
    resetGamepadSession();
    if (gamepadDevices.size) {
      gamepadDevices.clear();
      notifyGamepadDevices();
    }
    return;
  }
  if (!frame.connected) {
    if (slot === activeGamepadSlot) resetGamepadSession();
    if (gamepadDevices.delete(slot)) notifyGamepadDevices();
    return;
  }

  const pressed = !!frame.buttons[L3_BUTTON_INDEX];
  const device = gamepadDevices.get(slot);
  const freshPress = device?.pressed === false && pressed;
  if (device) device.pressed = pressed;
  else {
    gamepadDevices.set(slot, { model: frame.model, pressed });
    notifyGamepadDevices();
  }

  if (gamepadPauses.size || typingInField || capturingHotkey ||
      (loginWin && BrowserWindow.getFocusedWindow() === loginWin)) {
    if (activeGamepadSlot !== null) resetGamepadSession();
    return;
  }
  // 圆盘归本次按下左摇杆的设备。首次报告就是按住时，先等该设备松开。
  if (activeGamepadSlot === null && freshPress) activeGamepadSlot = slot;
  if (activeGamepadSlot !== slot) return;

  const step = stepChord(chordState, frame, settings.gamepad);
  chordState = step.state;
  if (!step.active) {
    activeGamepadSlot = null;
    if (discShown) hideDisc();
  } else {
    if (!discShown) showDisc();
    pushDiscState(step.highlighted);
  }
  if (step.release) handleHotkey(step.release, 'up', 'gamepad');
  if (step.press) handleHotkey(step.press, 'down', 'gamepad');
  if (step.fired) handleHotkey(step.fired);
}

function setGamepadEnabled(enabled) {
  if (settings.gamepad.enabled === enabled) return;
  settings.gamepad.enabled = enabled;
  if (enabled) {
    gamepad.start(handleGamepadFrame);
  } else {
    stopGamepadPoller();
    handleGamepadFrame(null);
    if (discWin && !discWin.isDestroyed()) discWin.destroy();
  }
}

function stopGamepadPoller() {
  try {
    gamepad.stop();
  } catch (err) {
    console.warn('[gamepad] 停止轮询失败：', err.message);
  }
}

/* -------------------------------------------------------------- 全局热键 */

function sendPlayerAction(action) {
  // 浮窗没起来时热键也要有反应：否则用户在启动器里按键，什么都不发生
  if (!win || win.isDestroyed()) {
    createWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.once('did-finish-load', () => {
        if (win && !win.isDestroyed()) win.webContents.send('hotkey', action);
      });
    }
    return;
  }
  win.webContents.send('hotkey', action);
}

/** 热键动作的唯一入口：键盘加速器和鼠标侧键都走这里 */
function handleHotkey(key, phase, source = 'keyboard') {
  if (key === 'holdSpeed') return setHoldSpeed(phase === 'down', source);
  if (capturingHotkey) return;
  if (key === 'cycleSpeed' && (typingInField || (loginWin && !loginWin.isDestroyed() && BrowserWindow.getFocusedWindow() === loginWin))) return;
  if (key === 'cycleSpeed') return cyclePlaybackRate();
  if (key === 'toggleImmersion') return setImmersion(!immersion);
  if (key === 'toggleVisible') return toggleVisible();
  if (key === 'togglePass') return setPass(!settings.clickThrough);
  if (key === 'toggleOpacity') return setOpacity(settings.opacity > 0.95 ? 0.65 : 1);
  sendPlayerAction(key);
}

function toggleVisible() {
  if (!win || win.isDestroyed()) return;
  if (win.isVisible()) {
    win.hide();
  } else {
    win.showInactive();
    applyPin();
  }
}

function setPass(on) {
  settings.clickThrough = !!on;
  applyWindowPresentation();
  persist();
  if (win && !win.isDestroyed()) win.webContents.send('win:state', { clickThrough: settings.clickThrough });
}

function setOpacity(v) {
  settings.opacity = Math.min(1, Math.max(0.3, Number(v) || 1));
  applyWindowPresentation();
  persist();
  if (win && !win.isDestroyed()) win.webContents.send('win:state', { opacity: settings.opacity });
}

function registerHotkeys() {
  cancelTemporarySpeed();
  globalShortcut.unregisterAll();
  failedHotkeys = [];

  for (const { key } of HOTKEY_META) {
    const acc = settings.hotkeys[key];
    if (!acc) continue;
    // 鼠标侧键和单键不进 globalShortcut：前者不支持，后者会把键全局吞掉。
    // 这两类统一交给低级钩子被动监听。
    if (hookHotkeys.isHookAccelerator(acc, key)) continue;

    let ok = false;
    try {
      ok = globalShortcut.register(acc, () => handleHotkey(key));
    } catch {
      ok = false;
    }
    if (!ok) failedHotkeys.push({ key, accelerator: acc });
  }

  // 钩子类绑定：不可用时要把涉及的动作全部标为失败，界面才解释得清
  const hookState = hookHotkeys.apply(
    settings.hotkeys,
    handleHotkey,
    /**
     * 什么时候不响应单键/侧键。
     *
     * 原来这里是「自己的任一窗口在前台就全部忽略」，代价太大：浮窗本身就是
     * 置顶播放器，用户点一下它、或者刚在启动器里配完热键就按 J 试试，
     * 都会被判成「在自己的窗口里」，表现得就像热键彻底没接上。
     *
     * 现在只挡两种确实会打架的情形：正在输入框里打字、正在录制新键位。
     * 登录窗例外：那里面一定要能正常输入账号密码。
     */
    () => {
      if (capturingHotkey) return true;
      if (typingInField) return true;
      const focused = BrowserWindow.getFocusedWindow();
      return !!focused && focused === loginWin;
    }
  );

  if (hookState.needed && !hookState.ok) {
    for (const { key } of HOTKEY_META) {
      const acc = settings.hotkeys[key];
      if (hookHotkeys.isHookAccelerator(acc, key)) failedHotkeys.push({ key, accelerator: acc, hook: true });
    }
  }
  for (const acc of hookState.keys) {
    const hit = HOTKEY_META.find((m) => settings.hotkeys[m.key] === acc);
    if (hit) failedHotkeys.push({ key: hit.key, accelerator: acc, unsupported: true });
  }

  if (failedHotkeys.length) {
    console.warn('[hotkeys] 注册失败（可能被其他程序占用）:', failedHotkeys);
  }
  return failedHotkeys;
}

/* ------------------------------------------------------------ B 站解析 */

async function followRedirect(url) {
  try {
    const res = await biliFetch(url, { Accept: 'text/html' });
    try {
      await res.arrayBuffer();
    } catch {
      /* ignore */
    }
    return res.url || url;
  } catch {
    return url;
  }
}

function extractId(text) {
  const s = String(text || '').trim();
  let m = s.match(/(BV[0-9A-Za-z]{10})/);
  if (m) return 'BV' + m[0].slice(2);
  m = s.match(/[?&/]av(\d+)/i) || s.match(/^av(\d+)$/i);
  if (m) return 'av' + m[1];
  return null;
}

async function resolveInput(text) {
  let s = String(text || '').trim();
  if (!s) return { ok: false, message: '请输入视频链接或 BV 号' };

  if (/b23\.tv|bili2233\.cn/i.test(s)) {
    const direct = s.match(/https?:\/\/\S+/i);
    if (direct) s = await followRedirect(direct[0]);
  }

  const id = extractId(s);
  if (!id) return { ok: false, message: '没认出 BV 号，请粘贴完整视频链接' };

  const pm = s.match(/[?&](?:p|page)=(\d+)/i);
  return { ok: true, id, p: pm ? Number(pm[1]) : 1 };
}

async function fetchVideoInfo(id) {
  const q = id.startsWith('av') ? `aid=${id.slice(2)}` : `bvid=${id}`;
  try {
    const res = await biliFetch(`https://api.bilibili.com/x/web-interface/view?${q}`);
    const json = await res.json();
    if (json.code !== 0) return { ok: false, message: json.message || `接口返回 ${json.code}` };
    const d = json.data || {};
    return {
      ok: true,
      id: d.bvid || id,
      title: d.title || '',
      cover: typeof d.pic === 'string' ? d.pic : '',
      owner: d.owner ? d.owner.name : '',
      pages: (d.pages || []).map((p) => ({ page: p.page, part: p.part, duration: p.duration }))
    };
  } catch (err) {
    return { ok: false, message: '读取视频信息失败：' + err.message };
  }
}

/** 查询登录态：未登录只能看预览/低清晰度，登录后才是完整视频 */
async function fetchNav() {
  try {
    const res = await biliFetch('https://api.bilibili.com/x/web-interface/nav');
    const json = await res.json();
    const d = json.data || {};
    return {
      ok: true,
      loggedIn: !!d.isLogin,
      uname: d.uname || '',
      mid: d.mid || 0,
      vip: d.vipStatus === 1,
      level: d.level_info ? d.level_info.current_level : 0
    };
  } catch (err) {
    return { ok: false, loggedIn: false, uname: '', message: err.message };
  }
}

/** 只用 www.bilibili.com 视频页：站外嵌入播放器（player.bilibili.com）无论如何都上不了高清 */
function buildUrl(id, p) {
  const page = Math.max(1, Number(p) || 1);
  const key = id.startsWith('av') ? `av${id.slice(2)}` : id;
  return `https://www.bilibili.com/video/${key}/?p=${page}&autoplay=1`;
}

/* ---------------------------------------------------------------- 登录 */

function openLogin() {
  if (loginWin && !loginWin.isDestroyed()) {
    if (loginWin.isMinimized()) loginWin.restore();
    loginWin.show();
    loginWin.focus();
    return;
  }

  const currentLoginWindow = new BrowserWindow({
    width: 480,
    height: 720,
    title: '登录 B 站',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    alwaysOnTop: true,
    webPreferences: {
      partition: BILI_PARTITION,
      // 当前 Windows / Electron 组合的沙箱登录页会直接 ERR_FAILED，连本地页也无法加载。
      // 仅此窗口兼容运行；远程页面不接入 preload / Node / 应用 IPC。
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      spellcheck: false
    }
  });
  loginWin = currentLoginWindow;
  // 跟跑浮窗使用 screen-saver 层级，登录窗口也要到同层，才能显示在它上面。
  currentLoginWindow.setAlwaysOnTop(true, 'screen-saver');
  currentLoginWindow.show();
  currentLoginWindow.focus();
  currentLoginWindow.loadURL('https://passport.bilibili.com/login').catch((err) => {
    console.warn('[bili] 登录页面加载失败：', err.message);
  });

  // 查询单飞，避免网络慢时 interval 重入，扫码后重复通知、重载播放器。
  let checking = false;
  let completed = false;
  const deadline = Date.now() + 5 * 60 * 1000;
  const timer = setInterval(async () => {
    if (completed || currentLoginWindow.isDestroyed() || loginWin !== currentLoginWindow || Date.now() > deadline) {
      clearInterval(timer);
      return;
    }
    if (checking) return;
    checking = true;
    try {
      const nav = await fetchNav();
      // 用户可能在接口返回前关闭窗口，或者已经重新打开了另一个登录窗口。
      if (completed || currentLoginWindow.isDestroyed() || loginWin !== currentLoginWindow || !nav.loggedIn) return;
      completed = true;
      clearInterval(timer);
      console.log('[bili] 登录成功：', nav.uname, nav.vip ? '(大会员)' : '');
      broadcast('login:state', nav);
      currentLoginWindow.close();
    } finally {
      checking = false;
    }
  }, 2000);

  currentLoginWindow.on('closed', () => {
    completed = true;
    clearInterval(timer);
    if (loginWin === currentLoginWindow) loginWin = null;
  });
}

/* ---------------------------------------------------------------- IPC */

function registerIpc() {
  // 这里只读写内存；访客 preload 在站点脚本之前同步拿到偏好。
  ipcMain.on('player:settings', (event) => {
    if (!isPlaybackGuest(event.sender) || event.senderFrame !== event.sender.mainFrame) {
      event.returnValue = null;
      return;
    }
    event.sender.setAudioMuted(true);
    playbackGate = 0;
    immersionAspect = 0;
    event.returnValue = {
      ...guestPlaybackSettings(), token: ++playbackToken, ...(immersion ? { videoOnly: true, immersionSession } : {})
    };
  });
  ipcMain.on('player:video-size', (event, message) => {
    if (!immersion || !isPlaybackMessage(event, message) || message.immersionSession !== immersionSession) return;
    const { width, height } = message;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 0 || height < 0) return;
    const aspect = width && height ? width / height : 0;
    if (aspect === immersionAspect) return;
    immersionAspect = aspect;
    fitImmersionWindow();
  });
  ipcMain.on('player:gating', (event, message) => {
    if (isPlaybackMessage(event, message) && Number.isSafeInteger(message.seq) && message.seq > playbackGate) {
      playbackGate = message.seq;
      event.sender.setAudioMuted(true);
    }
  });
  ipcMain.on('player:ready', (event, message) => {
    if (isPlaybackMessage(event, message) && message.seq === playbackGate) event.sender.setAudioMuted(false);
  });
  ipcMain.on('player:changed', (event, message) => {
    if (!isPlaybackMessage(event, message)) {
      event.returnValue = null;
      return;
    }
    const patch = { ...(message.patch || {}) };
    if (holdSpeedActive) delete patch.playbackRate;
    if (updatePlaybackSettings(settings, patch)) {
      persist();
      broadcast('settings:changed', settings);
    }
    // 同步完成：紧接着切 P 的新 preload 也能读到用户刚调好的值。
    event.returnValue = guestPlaybackSettings();
  });

  ipcMain.handle('app:boot', async () => {
    const nav = await fetchNav();
    console.log(
      '[bili] 登录态：',
      nav.loggedIn ? `已登录 ${nav.uname}${nav.vip ? '（大会员）' : ''}` : '未登录',
      nav.ok ? '' : `接口异常 ${nav.message || ''}`
    );
    return {
      settings,
      floatState: floatState(),
      playbackState: playbackState(),
      hotkeys: HOTKEY_META,
      // 手柄圆盘的可绑动作表要连白名单一起给界面，否则启动器会列出圆盘其实不认的动作
      gamepadDirs: GAMEPAD_DIR_UI,
      gamepadActions: GAMEPAD_ACTION_ALLOWLIST,
      gamepadModels: gamepadDeviceModels(),
      failedHotkeys,
      initialUrl: OPEN_ARG,
      nav,
      playbackCompatibility: supportsPlaybackCompatibility(),
      version: app.getVersion(),
      // 界面要能一眼看出「单键/侧键的全局钩子到底起来了没有」，
      // 否则热键不响应时只能靠猜
      hookRunning: hookHotkeys.isRunning(),
      // 没提权时游戏内热键必然收不到（UIPI），界面要直说，别让用户怀疑程序坏了
      elevated: isElevated(),
      // 让启动器能显示「设置和登录态存在哪」，绿色版就是 exe 同级的 data\
      dataDir: app.getPath('userData'),
      portable: installMode === 'portable',
      installMode
    };
  });

  ipcMain.handle('bili:nav', () => fetchNav());

  /* ---- 提权重启：游戏内热键要管理员身份才行（UIPI），由用户按需触发 ---- */
  ipcMain.handle('app:relaunch-elevated', async () => {
    if (isElevated()) return { ok: false, reason: 'already-elevated' };
    // 先让出单实例锁：提权后的新进程启动时会申请它。不让出的话新进程会立刻自杀，
    // 而这边也已经退出 —— 用户看到的现象就是「点了按钮，程序直接消失」。
    if (saveTimer) flushSettings();
    const hadLock = app.hasSingleInstanceLock();
    stopGamepadPoller();
    handleGamepadFrame(null);
    if (hadLock) app.releaseSingleInstanceLock();
    const result = await relaunchElevated();
    // UAC 被取消：把锁要回来，继续以普通权限运行
    if (!result.ok) {
      if (hadLock) app.requestSingleInstanceLock();
      if (settings.gamepad.enabled) gamepad.start(handleGamepadFrame);
    } else {
      setTimeout(() => app.exit(0), 400);
    }
    return result;
  });

  /* ---- 输入状态：决定单键热键要不要让路 ---- */

  ipcMain.on('ui:typing', (_e, on) => {
    typingInField = !!on;
    if (typingInField) cancelTemporarySpeed();
  });
  ipcMain.on('ui:capture', (_e, on) => {
    capturingHotkey = !!on;
    if (capturingHotkey) cancelTemporarySpeed();
  });

  ipcMain.on('overlay:bearing', (event, payload) => {
    if (event.sender !== win?.webContents || !payload || !settings.bearing.enabled) return;
    const layout = activeBearingLayout(settings.bearing);
    if (!payload.clear && (payload.layoutId !== layout.id || payload.revision !== layout.revision)) return;
    lastBearing = payload;
    sendTo(overlayWin, 'bearing', payload);
  });

  ipcMain.handle('overlay:enable', (_e, on) => setBearingEnabled(on));

  ipcMain.handle('bearing:layout', (event, command) => {
    const bearing = settings.bearing;
    const fromFloat = !!win && event.sender === win.webContents;
    const fromConsole = !!consoleWin && event.sender === consoleWin.webContents;
    const operations = fromFloat ? ['select', 'create', 'calibrate'] : fromConsole ? ['select', 'default', 'rename', 'remove'] : [];
    if (!operations.includes(command?.op)) return { ok: false, reason: 'invalid' };
    const previous = activeBearingLayout(bearing);
    const result = applyBearingLayout(bearing, command);
    if (result.ok) {
      const current = activeBearingLayout(bearing);
      if (current.id !== previous.id || current.revision !== previous.revision) clearBearingOverlay();
      persist();
      broadcast('settings:changed', settings);
    }
    return { ...result, bearing };
  });

  ipcMain.handle('bearing:auto-center-result', (event, result) => {
    const bearing = settings.bearing;
    const layout = activeBearingLayout(bearing);
    if (event.sender !== win?.webContents || !result || !bearing.enabled ||
        layout.id !== result.layoutId || layout.revision !== result.revision) return { ok: false, reason: 'invalid' };
    let out = { ok: false, reason: result.reason };
    if (result.ok) {
      const saved = applyBearingLayout(bearing, { ...result, op: 'center', id: layout.id });
      out = saved.ok ? { ok: true } : { ok: false, reason: 'save-failed' };
      if (saved.ok) {
        persist();
        broadcast('settings:changed', settings);
      }
    }
    if (result.manual && result.reason !== 'reset') sendTo(consoleWin, 'auto-center-result', out);
    return out;
  });
  ipcMain.handle('overlay:place', (_e, on) => setOverlayPlacing(on));
  // 启动器重建 / 箭头开关切换后，用它把按钮文案对齐到主进程的真实状态
  ipcMain.handle('overlay:place-state', () => overlayPlacing);
  ipcMain.handle('overlay:radius', (_e, r) => setOverlayRadius(r));

  // 调试：把访客抓到的识别区域落盘，用来肉眼确认 ROI 有没有对准小地图
  ipcMain.handle('overlay:dump-save', (_e, payload = {}) => {
    const dir = app.getPath('userData');
    const b64 = String(payload.dataUrl || '').split(',')[1] || '';
    if (!b64) return { ok: false, file: '' };

    const file = path.join(dir, 'bearing-dump.png');
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));

    // 整帧 + 红框图：用来肉眼判断识别区域有没有落在小地图上
    const fb64 = String(payload.frame || '').split(',')[1] || '';
    const frameFile = path.join(dir, 'bearing-frame.png');
    if (fb64) fs.writeFileSync(frameFile, Buffer.from(fb64, 'base64'));

    const rois = Array.isArray(payload.rois) ? payload.rois : [];
    const roiText = rois
      .map((r) => `(${r.cx.toFixed(3)}, ${r.cy.toFixed(3)}) r=${r.r.toFixed(3)}`)
      .join(' | ');

    console.log(
      '[bearing] 识别区域已导出',
      `${payload.size}px`,
      `视频 ${payload.vw}×${payload.vh}`,
      `${rois.length} 处：${roiText || '无'}`,
      `不透明 ${payload.opaque}/${payload.total}`,
      `→ ${frameFile}`
    );
    return { ok: true, file, frameFile: fb64 ? frameFile : '', dir, size: payload.size };
  });

  // 导出后让用户在资源管理器里直接看到，不用自己翻 AppData
  ipcMain.handle('overlay:reveal-dump', () => {
    const dir = app.getPath('userData');
    const frame = path.join(dir, 'bearing-frame.png');
    if (fs.existsSync(frame)) shell.showItemInFolder(frame);
    else shell.openPath(dir);
    return dir;
  });

  ipcMain.handle('settings:save', (_e, patch = {}) => {
    const playbackChanged = updatePlaybackSettings(settings, patch);
    if (typeof patch.gamepadEnabled === 'boolean') setGamepadEnabled(patch.gamepadEnabled);
    if (HOLD_PLAYBACK_RATES.includes(patch.holdPlaybackRate)) settings.holdPlaybackRate = patch.holdPlaybackRate;
    if (typeof patch.hoverFadeEnabled === 'boolean') {
      settings.hoverFadeEnabled = patch.hoverFadeEnabled;
      syncHoverFade();
      notifyFloatState();
    }
    if (patch.storyAutoHide) {
      const v = patch.storyAutoHide;
      const cur = settings.storyAutoHide;
      if (typeof v.enabled === 'boolean') cur.enabled = v.enabled;
      if (typeof v.hideFloat === 'boolean') {
        cur.hideFloat = v.hideFloat;
        applyWindowPresentation();
      }
      if (typeof v.showBox === 'boolean') {
        cur.showBox = v.showBox;
        if (!v.showBox) clearStoryBox();
      }
      if (Number.isFinite(Number(v.threshold))) {
        cur.threshold = Math.max(0.4, Math.min(0.95, Number(v.threshold)));
      }
      if (Number.isFinite(Number(v.interval))) {
        cur.interval = Math.max(300, Math.min(5000, Number(v.interval)));
      }
      // 关掉时立刻把窗口放回来，别让用户对着空屏幕找开关
      if (!cur.enabled) setStoryHidden(false);
      restartStoryWatch();
    }
    if (playbackChanged || patch.holdPlaybackRate !== undefined) publishPlaybackSettings();
    // 自动连播 / 手动切 P 只带 lastPart：页码和时间要一起刷新，
    // 否则启动器上的「上次看到」会一直停在第一次打开视频那一刻。
    if (patch.lastText !== undefined || patch.lastPart !== undefined) {
      noteWatched(settings, {
        ...(patch.lastText !== undefined ? { text: patch.lastText } : {}),
        ...(patch.lastPart !== undefined ? { p: patch.lastPart } : {})
      });
    }
    // 这个开关本身不是「观看记录」，别顺手刷新 lastWatchedAt
    if (patch.resumeOnLaunch !== undefined) settings.resumeOnLaunch = !!patch.resumeOnLaunch;
    if (patch.pinned !== undefined) {
      settings.pinned = !!patch.pinned;
      applyPin();
    }
    if (patch.clickThrough !== undefined) setPass(patch.clickThrough);
    if (patch.opacity !== undefined) setOpacity(patch.opacity);
    if (patch.hotkeys) settings.hotkeys = { ...settings.hotkeys, ...patch.hotkeys };
    persist();
    broadcast('settings:changed', settings);
    return settings;
  });

  ipcMain.handle('hotkeys:update', (_e, next = {}) => {
    const valid = {};
    for (const [k, v] of Object.entries(next)) {
      if (Object.prototype.hasOwnProperty.call(DEFAULT_HOTKEYS, k) && typeof v === 'string' && v.trim()) {
        valid[k] = v.trim();
      }
    }

    const previous = { ...settings.hotkeys };
    const prepared = prepareHotkeyUpdate(previous, valid);
    settings.hotkeys = prepared.hotkeys;
    let failed = registerHotkeys();
    let rejected = prepared.rejected;
    const affected = new Set([...Object.keys(valid), ...prepared.swapped]);
    // 换键是一个事务：隐式互换的另一方注册失败，也必须一起退回。
    if (failed.some((failure) => affected.has(failure.key))) {
      settings.hotkeys = previous;
      rejected = Object.keys(valid);
      failed = registerHotkeys();
    }
    persist();
    broadcast('settings:changed', settings);
    return {
      hotkeys: settings.hotkeys,
      failed,
      rejected,
      swapped: rejected.length ? [] : prepared.swapped,
      hookRunning: hookHotkeys.isRunning()
    };
  });

  ipcMain.handle('hotkeys:reset', () => {
    settings.hotkeys = { ...DEFAULT_HOTKEYS };
    const failed = registerHotkeys();
    persist();
    broadcast('settings:changed', settings);
    return { hotkeys: settings.hotkeys, failed, hookRunning: hookHotkeys.isRunning() };
  });

  const saveGamepadMap = (map) => {
    resetGamepadSession();
    settings.gamepad = mergeGamepadSettings(settings.gamepad, { map });
    persist();
    broadcast('settings:changed', settings);
    return settings.gamepad;
  };
  ipcMain.handle('gamepad:update', (_e, map = {}) => saveGamepadMap(map));
  ipcMain.handle('gamepad:reset', () => saveGamepadMap(DEFAULT_GAMEPAD.map));

  ipcMain.handle('win:action', (_e, action, payload) => {
    // 下面这几个动作主要由启动器发起，而启动器点它们的时候浮窗往往还没起，
    // 所以必须放在「浮窗存在」的守卫之前；否则按钮点了没有任何反应。
    switch (action) {
      case 'start-float':
        createWindow();
        return true;
      case 'stop-float':
        if (win && !win.isDestroyed()) win.close();
        return true;
      case 'open-console':
        createConsole();
        return true;
      case 'login':
        cancelTemporarySpeed();
        openLogin();
        return true;
      case 'immersion':
        return setImmersion(payload === undefined ? !immersion : !!payload);
      case 'cycle-speed':
        return cyclePlaybackRate();
      case 'open-data':
        shell.openPath(app.getPath('userData'));
        return true;
      case 'open-license':
        return shell.openPath(app.isPackaged
          ? path.join(process.resourcesPath, 'licenses', 'NOTICE-GIFA.txt')
          : path.join(app.getAppPath(), 'build', 'LICENSE.txt'));
      case 'calib':
        if (!win || win.isDestroyed() || !playbackGuest || !settings.lastVideoId) return false;
        if (payload?.op !== 'create' && payload?.op !== 'calibrate') return false;
        if (settings.clickThrough) return 'click-through';
        if (immersion) setImmersion(false);
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        sendTo(win, 'float:cmd', { cmd: 'calib', command: payload });
        return true;
      case 'autocenter':
        if (!win || win.isDestroyed() || !playbackGuest || !settings.lastVideoId) return false;
        sendTo(win, 'float:cmd', { cmd: 'autocenter' });
        return true;
      case 'dump':
        if (win && !win.isDestroyed()) sendTo(win, 'float:cmd', { cmd: 'dump' });
        return true;
      case 'float-load':
        if (win && !win.isDestroyed()) {
          sendTo(win, 'float:cmd', { cmd: 'load', text: payload && payload.text, p: payload && payload.p });
        }
        return true;
      default:
        break;
    }

    if (!win || win.isDestroyed()) return false;
    switch (action) {
      case 'minimize':
        win.minimize();
        break;
      case 'open-video-browser':
        if (_e.sender !== win.webContents || _e.senderFrame !== _e.sender.mainFrame || !isPlaybackPage(payload)) return false;
        return shell.openExternal(payload).then(() => true, () => false);
      case 'close':
        // 只关跟跑浮窗，不退出程序 —— 启动器还在，随时可以再点「启动跟跑」。
        // 反方向不一样：关启动器会连带收掉所有窗口并退出（见 createConsole）。
        win.close();
        break;
      case 'hide':
        toggleVisible();
        break;
      case 'pin':
        settings.pinned = !!payload;
        applyPin();
        persist();
        break;
      case 'pass':
        setPass(payload);
        break;
      case 'opacity':
        setOpacity(payload);
        break;
      case 'fullscreen':
        // 纯视频模式锁住窗口尺寸，网页内部的全屏请求不改变它。
        if (immersion) return false;
        // payload 省略时按当前状态取反，方便同一个入口做开关
        win.setFullScreen(payload === undefined ? !win.isFullScreen() : !!payload);
        break;
      case 'resize':
        if (immersion) return false;
        if (payload && Number.isFinite(payload.w) && Number.isFinite(payload.h)) {
          win.setBounds({
            x: win.getBounds().x,
            y: win.getBounds().y,
            width: Math.max(240, Math.round(payload.w)),
            height: Math.max(150, Math.round(payload.h))
          });
        }
        break;
      default:
        break;
    }
    return true;
  });

  let latestVideoLoad = 0;
  ipcMain.handle('bili:load', async (_e, payload = {}) => {
    const load = ++latestVideoLoad;
    const resolved = await resolveInput(payload.text);
    if (load !== latestVideoLoad) return { ok: false, message: '已发出新的播放请求' };
    if (!resolved.ok) return { ok: false, message: resolved.message };

    const p = Number(payload.p) || resolved.p || 1;
    const info = await fetchVideoInfo(resolved.id);
    // 旧请求迟到时不能覆盖当前视频的观看记录。
    if (load !== latestVideoLoad) return { ok: false, message: '已发出新的播放请求' };
    const id = (info.ok && info.id) || resolved.id;
    const pages = info.ok ? info.pages : [];

    // 同一视频切 P 时接口偶尔读不到分 P 信息，别把已知的标题/总数清掉
    const sameVideo =
      settings.lastVideoId &&
      String(settings.lastVideoId).toLowerCase() === String(id).toLowerCase();
    const cover = (info.ok && info.cover) || (sameVideo ? settings.lastCover : '') || '';
    noteWatched(settings, {
      text: payload.text,
      p,
      id,
      title: info.ok ? info.title : sameVideo ? settings.lastTitle : '',
      cover,
      pageCount: pages.length || (sameVideo ? settings.lastPageCount : 0)
    });
    persist();
    // 启动器可能正开着：让「上次看到」那一行立刻跟上，不用等下次启动
    broadcast('settings:changed', settings);

    return {
      ok: true,
      id,
      p,
      url: buildUrl(id, p),
      title: info.ok ? info.title : '',
      owner: info.ok ? info.owner : '',
      cover,
      pages,
      message: info.ok ? '' : `读不到分 P 信息（${info.message}），已直接载入`
    };
  });
}

/* ---------------------------------------------------------------- 生命周期 */

let updates;

function updateSender(event) {
  return consoleWin && !consoleWin.isDestroyed() && event.sender === consoleWin.webContents &&
    event.senderFrame && event.senderFrame === consoleWin.webContents.mainFrame &&
    event.senderFrame.url === pathToFileURL(path.join(__dirname, 'console', 'index.html')).href;
}

async function registerUpdates() {
  const directory = programDir();
  const resources = process.resourcesPath;
  const updater = await resolveUpdater({
    packaged: app.isPackaged, platform: process.platform, arch: process.arch, mode: installMode, programDir: directory,
    resourcesPath: resources, selfExtracting: !!(process.env.PORTABLE_EXECUTABLE_DIR || process.env.PORTABLE_EXECUTABLE_FILE)
  });
  const version = app.getVersion();
  updates = createUpdateController({
    version, updater, client: githubClient(), tempDir: app.getPath('temp'),
    updated: process.argv.includes('--gifa-updated'),
    onState: state => sendTo(consoleWin, 'update:state', state),
    async confirmInstall(targetVersion) {
      if (overlayPlacing || capturingHotkey || (loginWin && !loginWin.isDestroyed())) {
        throw new Error('请先完成登录、快捷键录制或方位标定，再安装更新。');
      }
      const result = await dialog.showMessageBox(consoleWin, {
        type: 'question', title: '安装 GIFA 更新', message: `重启并更新到 v${targetVersion}？`,
        detail: '浮窗播放器将停止，更新后会重新启动 GIFA。你的设置、标定和 B 站登录状态会保留。',
        buttons: ['稍后', '重启并安装'], cancelId: 0, defaultId: 0, noLink: true
      });
      return result.response === 1;
    },
    async prepareInstall({ manifestPath, artifactPath }) {
      if (!isElevated()) throw new Error('请以管理员身份运行 GIFA，再安装更新。');
      if (updater.mode === 'installed' && fs.existsSync(path.join(directory, 'data'))) {
        throw new Error('安装目录仍有旧绿色版的 data，请先将它备份并迁出，再安装更新。');
      }
      if (!flushSettings(true)) throw new Error('无法保存当前设置，未启动更新器。');
      try { await biliSession().cookies.flushStore(); }
      catch { throw new Error('无法刷新本地登录状态，未启动更新器。'); }
      const args = ['--apply', updater.mode, directory, String(process.pid), version, manifestPath, artifactPath];
      await new Promise((resolve, reject) => {
        execFile(updater.helper, args, { windowsHide: true, timeout: 180000 }, (error, _stdout, stderr) => {
          if (!error) return resolve();
          const code = /^GIFA_UPDATE_ERROR ([A-Z_]+)$/.exec(stderr.trim())?.[1];
          const messages = {
            LEGACY_DATA: '安装目录仍有旧绿色版的 data，请先将它备份并迁出。',
            SCOPE: '无法确认原安装位置或安装范围，请到官方发布页手动升级。',
            UNSAFE_PATH: '当前目录的权限或路径不支持安全更新，请到官方发布页手动升级。',
            INTERRUPTED: '检测到上次更新留下的备份。请先保留备份和 data，再手动修复。',
            NO_KEY: '此构建未配置更新公钥，请从官方发布页获取新版。',
            NOT_ELEVATED: '请以管理员身份运行 GIFA，再安装更新。',
            BUSY: '另一个更新或 GIFA 实例正在运行，请关闭后重试。'
          };
          console.warn('[update] helper preflight:', error.code, code || 'PREPARE_FAILED');
          reject(new Error(messages[code] || '更新器无法准备安装，请检查文件占用和可用空间。'));
        });
      });
    },
    quit: () => app.quit()
  });

  const actions = {
    status: updates.snapshot,
    check: updates.check,
    download: updates.download,
    cancel: updates.cancel,
    install: updates.install,
    'open-releases': async () => {
      await shell.openExternal(RELEASES_PAGE);
      return updates.snapshot();
    }
  };
  for (const [action, handle] of Object.entries(actions)) {
    ipcMain.handle('update:' + action, event => {
      if (!updateSender(event)) throw new Error('无权使用更新服务');
      return handle();
    });
  }

  installExitHook(app, updates);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 再次启动 exe 时把启动器叫回来，而不是只动浮窗
    if (consoleWin && !consoleWin.isDestroyed()) {
      if (consoleWin.isMinimized()) consoleWin.restore();
      consoleWin.show();
      consoleWin.focus();
    } else {
      createConsole();
    }
  });

  app.whenReady().then(async () => {
    // 打包版已在 exe 清单层提权（双击即弹 UAC），这里**不再自动重启**：
    // portable 版是「自解压壳 + 主程序」，运行时再提权等于多解压一遍 100MB、多等 20 秒。
    // 只有清单没生效时（开发版 / 解压直跑 / UAC 被取消），启动器顶部横幅仍提供
    // 「以管理员身份重启」作为兜底。
    // 常驻工具：明确告诉系统「别挂起我」。配合上面的 EcoQoS 开关，
    // 保证窗口最小化后全局钩子照常工作（这正是「在游戏里按热键」的核心场景）。
    powerSaveBlocker.start('prevent-app-suspension');
    if (process.platform === 'win32') app.setAppUserModelId('com.finallawer.genshin-route-buddy');
    powerMonitor.on('suspend', () => {
      gamepadPauses.add('suspend');
      cancelTemporarySpeed();
    });
    powerMonitor.on('lock-screen', () => {
      gamepadPauses.add('lock');
      cancelTemporarySpeed();
    });
    powerMonitor.on('unlock-screen', () => gamepadPauses.delete('lock'));
    powerMonitor.on('resume', () => {
      gamepadPauses.delete('suspend');
      cancelTemporarySpeed();
      hookHotkeys.rearm();
    });

    loadSettings();
    // 调试用：本次启动强制打开方位标记，不写进设置文件
    if (process.argv.includes('--bearing')) settings.bearing.enabled = true;
    try {
      session.defaultSession.setUserAgent(UA);
    } catch {
      /* ignore */
    }
    registerIpc();
    await registerUpdates().catch(error => console.warn('[update] initialization failed:', error.message));
    for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) {
      screen.on(event, fitImmersionWindow);
    }
    // 剧情自动隐藏：设置里开着才起扫描循环
    try {
      restartStoryWatch();
    } catch (err) {
      console.warn('[story] 启动扫描失败：', err.message);
    }
    const launcher = createConsole(); // 先出启动器，配置好了再点「启动跟跑」
    launcher.on('close', event => {
      if (updates?.isPreparing()) event.preventDefault();
    });
    registerHotkeys();
    // Windows 手柄输入由独立子进程处理，关闭手柄快捷键时无需启动它。
    if (settings.gamepad.enabled) gamepad.start(handleGamepadFrame);

    // `--open BVxxx` 是从快捷方式直接带视频来的，那就顺手把浮窗也起来
    if (OPEN_ARG) createWindow();
    // 「上次看到」：直接把浮窗起来，浮窗 init() 会读 lastText/lastPart 继续播。
    // 显式 --open 优先；开关可在启动器里关掉（只想改设置、不想每次弹浮窗时）。
    else if (shouldResumeOnLaunch(settings, OPEN_ARG)) {
      console.log('[resume] 继续上次观看', settings.lastTitle || settings.lastText, `P${settings.lastPart}`);
      createWindow();
    }

    // 只允许登录窗口弹 B 站域名的子窗口（第三方登录/扫码），其余一律拦截
    app.on('web-contents-created', (_e, contents) => {
      contents.setWindowOpenHandler(({ url }) => {
        const isBili = /^https?:\/\/([a-z0-9-]+\.)*bilibili\.com([/?#:]|$)/i.test(url);
        const fromLogin =
          loginWin && !loginWin.isDestroyed() && contents === loginWin.webContents;
        if (fromLogin && isBili) {
          return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true } };
        }
        return { action: 'deny' };
      });
    });
  });

  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => {
    clearInterval(hoverTimer);
    cancelTemporarySpeed();
    if (saveTimer) flushSettings();
    globalShortcut.unregisterAll();
    stopGamepadPoller();
    try {
      hookHotkeys.apply({}, null); // 清空映射并停止钩子
    } catch (err) {
      // 退出路径上的异常会弹出 Electron 的报错框，这里必须兜住
      console.warn('[hook] 退出前停止钩子失败：', err.message);
    }
  });
}
