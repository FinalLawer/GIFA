'use strict';

/**
 * 原神跟跑助手 —— 主进程
 * 职责：无边框置顶窗口、全局快捷键、B 站视频解析、设置持久化
 */

const { app, BrowserWindow, dialog, globalShortcut, ipcMain, powerMonitor, powerSaveBlocker, screen, session, shell } = require('electron');
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
  /* 底部字幕精灵：把视频字幕显示到屏幕底部。
   * 字幕文本还能用来判方位（见雷达功能），这里只管显示。 */
  enableSubtitleSprite: false,
  // 优先用官方字幕接口（带精确时间戳）；关掉只走 DOM 抓取
  subtitleUseApi: true,
  // 隐藏播放器原生字幕，避免两套同时出现
  subtitleHideNative: true,
  // 同一时刻多行字幕合并显示；关掉只取最新一条
  subtitleMergeOverlap: true,
  // 暂停时隐藏字幕
  subtitleHideOnPause: false,
  // 自动点开播放器字幕按钮
  subtitleAutoOpen: true,
  /* 字幕提到「清怪」时自动暂停。
   * 攻略里说「清怪」是要开打了，先把视频停住看完再动手。
   * 「清完怪」这类是打完之后的描述，不触发。 */
  subtitlePauseOnClear: false,
  /* 字幕出现后等几秒再暂停。字幕是整句一起出现的，没有「说到哪个字」的概念，
   * 所以要留出读完这一句的时间。0 = 立即暂停。 */
  subtitlePauseDelay: 2.5,
  // 字幕位置：bottom / top
  subtitlePos: 'bottom',
  /* 转向提醒：字幕里出现「左转/右转/往东」等词时，
   * 在画面边缘弹一个大箭头。与字幕层共用同一个窗口。 */
  enableTurnReminder: false,
  // 分组开关：左右 / 上下 可分别启用
  turnEnableLR: true,
  turnEnableUD: true,
  /* 罗盘雷达：方位叠加层上多画一圈四轴方位。字幕出现方位词时点亮 */
  overlayRadar: false,
  /* 放大提醒：方位点亮时把游戏小地图那块抓一帧放大显示 */
  alertEnabled: false,
  alertSize: 260,
  alertX: null,
  alertY: null
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
      gamepad: mergeGamepadSettings(DEFAULT_SETTINGS.gamepad, raw.gamepad)
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

function applyWindowPresentation() {
  if (!win || win.isDestroyed()) return;
  win.setIgnoreMouseEvents(immersion || settings.clickThrough, { forward: true });
  win.setOpacity(hoverFaded ? Math.min(settings.opacity, 0.1) : settings.opacity);
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

async function fetchSubtitleCues(bvid, cid, gen) {
  if (!cid || !bvid) return [];
  if (subtitleCid === cid && subtitleCues.length) return subtitleCues;
  if (subtitleLoading === cid) return subtitleCues;
  subtitleLoading = cid;
  const myGen = gen === undefined ? subtitleGen : gen;
  /** 只有代数没变才落地；返回 false 表示这是过期结果 */
  const commit = (cues) => {
    if (myGen !== subtitleGen) return false;
    subtitleCues = cues;
    subtitleCid = cid;
    return true;
  };
  try {
    const res = await biliFetch(
      `https://api.bilibili.com/x/player/wbi/v2?bvid=${encodeURIComponent(bvid)}&cid=${cid}`
    );
    const json = await res.json();
    const data = (json && json.data) || {};
    const subs = data.subtitle && data.subtitle.subtitles;
    if (!Array.isArray(subs) || !subs.length) {
      // 分清两种「没有字幕」：没登录 vs 这个视频本来就没字幕轨
      console.log('[subtitle]', { cid, count: 0, needLogin: !!data.need_login_subtitle });
      console.log(
        '[subtitle] 接口没有字幕轨（need_login_subtitle=%s），回退 DOM 抓取',
        !!data.need_login_subtitle
      );
      return commit([]) ? [] : null;
    }
    // 优先中文正式轨，其次 AI 中文，最后任意含 zh 的
    const pick =
      subs.find((x) => /^zh(-Hans)?$/i.test(x.lan || '')) ||
      subs.find((x) => /^ai-zh/i.test(x.lan || '')) ||
      subs.find((x) => /zh/i.test(x.lan || ''));
    if (!pick || !pick.subtitle_url) {
      return commit([]) ? [] : null;
    }
    let url = String(pick.subtitle_url);
    if (url.startsWith('//')) url = 'https:' + url;
    const r2 = await biliFetch(url, { Accept: 'application/json' });
    const doc = await r2.json();
    const body = doc && Array.isArray(doc.body) ? doc.body : [];
    const cues = [];
    for (const row of body) {
      if (!row) continue;
      const from = Number(row.from);
      const to = Number(row.to);
      const text = String(row.content || '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || !text) continue;
      cues.push({ from, to, text: text.slice(0, 500) });
    }
    cues.sort((a, b) => a.from - b.from);
    if (!commit(cues)) return null; // 换片了，这个结果作废
    console.log('[subtitle]', { cid, count: cues.length, lan: pick.lan });
    console.log('[subtitle] 已加载字幕 %d 条（cid=%s，轨=%s）', cues.length, cid, pick.lan);
    return cues;
  } catch (err) {
    console.log('[subtitle]', { cid, error: err.message });
    console.warn('[subtitle] 拉取失败，回退到 DOM 抓取：', err.message);
    return commit([]) ? [] : null;
  } finally {
    subtitleLoading = 0;
  }
}

/**
 * 取某一时刻的全部字幕。
 * 这里就是「重叠字幕合并」：把所有 from <= t < to 的 cue 都取出来，
 * 去重后按顺序拼接 —— 同时有两行对白时两行都会显示。
 */
function subtitleAt(t) {
  const out = [];
  for (const c of subtitleCues) {
    if (c.from > t) break; // 已按 from 升序，后面的更晚
    if (t < c.to) out.push(c.text);
  }
  // 合并：同一时刻的多行对白拼成一行；不合并：只取最新一条
  if (settings.subtitleMergeOverlap === false) return out[out.length - 1].slice(0, 500);
  return [...new Set(out)].join(' ').slice(0, 500);
}

function subtitleBounds() {
  // 用 bounds 而不是 workArea：字幕层要覆盖整个屏幕，包括任务栏那一条，
  // 否则某些布局下底部会被裁掉。
  const d = screen.getPrimaryDisplay();
  return { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height };
}

function createSubtitleWindow() {
  if (subtitleWin && !subtitleWin.isDestroyed()) return subtitleWin;
  console.log('[subWin]', { create: true });

  subtitleWin = new BrowserWindow({
    ...subtitleBounds(),
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
    title: 'GIFA 字幕层',
    webPreferences: {
      preload: path.join(__dirname, 'subtitle', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 字幕窗只在有文本时才有事做：允许 Chromium 在不可见/空闲时降频，
      // 避免一个全屏透明层空转着把 CPU 啃掉（玩游戏时尤其明显）
      backgroundThrottling: true
    }
  });

  subtitleWin.setAlwaysOnTop(true, 'screen-saver');
  // 整窗穿透：字幕层永远不接收鼠标，剪贴板/游戏点击都落在下面的窗口
  subtitleWin.setIgnoreMouseEvents(true, { forward: true });

  subtitleWin.on('closed', () => {
    subtitleWin = null;
  });

  subtitleWin.loadFile(path.join(__dirname, 'subtitle', 'index.html'));

  // 换分辨率 / 缩放 / 切主屏时重新铺满
  subtitleWin.webContents.on('did-finish-load', () => {
    if (!subtitleWin || subtitleWin.isDestroyed()) return;
    subtitleWin.setBounds(subtitleBounds());
    pushSubtitleConfig();
    pushTurnConfig();
  });

  return subtitleWin;
}

/** 显示器参数变化时把字幕层重新铺满（外接屏拔插、改分辨率都会触发） */
function refitSubtitleWindow() {
  if (!subtitleWin || subtitleWin.isDestroyed()) return;
  try {
    subtitleWin.setBounds(subtitleBounds());
  } catch {
    /* 窗口正在销毁 */
  }
}

/** 显示一句字幕；text 为空表示立刻隐藏 */
function showSubtitleText(text) {
  if (!settings.enableSubtitleSprite) return;
  if (!text) {
    hideSubtitleText();
    return;
  }
  pushSubtitleToWindow(text);
}

/**
 * 把文本推给字幕窗口并确保它可见（不判断开关）。
 * 抽出来是为了让调试自检也能直接调用，不被 settings 拦住。
 */
function pushSubtitleToWindow(text) {
  const w = createSubtitleWindow();
  pushSubtitleConfig();
  const send = () => {
    if (!w || w.isDestroyed()) return;
    // 先补外观配置再发文本：窗口刚建好时 did-finish-load 之前的推送会丢
    w.webContents.send('subtitle:config', subtitleStyleSnapshot());
    w.webContents.send('subtitle:text', { text: String(text) });
  };

  // 关键：必须 showInactive 让窗口真正显示。之前只在「不可见」时调，
  // 而窗口创建时 show:false，did-finish-load 早于这里，容易出现窗口一直隐藏。
  if (!w.isVisible()) w.showInactive();
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', send);
  else send();
}

function hideSubtitleText() {
  if (!subtitleWin || subtitleWin.isDestroyed()) return;
  try {
    subtitleWin.webContents.send('subtitle:text', { off: true });
    subtitleWin.hide();
  } catch {
    /* 窗口正在销毁 */
  }
}

function destroySubtitleWindow() {
  if (!subtitleWin || subtitleWin.isDestroyed()) return;
  subtitleWin.destroy();
  subtitleWin = null;
}

/** 校验并写入一组字幕外观字段（非法值直接忽略，保留原值） */
function applySubtitleStylePatch(patch = {}) {
  const clamp = (v, min, max, fb) =>
    Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Math.round(Number(v)))) : fb;

  if (patch.scale !== undefined)
    settings.subtitleScale = clamp(patch.scale, 50, 200, settings.subtitleScale);
  if (patch.offset !== undefined)
    settings.subtitleOffset = clamp(patch.offset, 10, 500, settings.subtitleOffset);
  if (patch.bgOpacity !== undefined)
    settings.subtitleBgOpacity = clamp(patch.bgOpacity, 0, 100, settings.subtitleBgOpacity);

  if (typeof patch.color === 'string' && /^#[0-9a-f]{6}$/i.test(patch.color)) {
    settings.subtitleColor = patch.color.toLowerCase();
  }
  if (typeof patch.stroke === 'string' && SUB_STROKE_LIST.includes(patch.stroke)) {
    settings.subtitleStroke = patch.stroke;
  }
  if (typeof patch.pos === 'string' && SUB_POS_LIST.includes(patch.pos)) {
    settings.subtitlePos = patch.pos;
  }
  if (patch.keepRatio !== undefined) settings.subtitleKeepRatio = !!patch.keepRatio;
  if (patch.fade !== undefined) settings.subtitleFade = !!patch.fade;
  if (patch.hold !== undefined) settings.subtitleHold = clamp(patch.hold, 1, 10, settings.subtitleHold);
  if (patch.maxWidth !== undefined)
    settings.subtitleMaxWidth = clamp(patch.maxWidth, 30, 100, settings.subtitleMaxWidth);
  if (patch.weight !== undefined)
    settings.subtitleWeight = clamp(patch.weight, 500, 900, settings.subtitleWeight);
  if (patch.radius !== undefined)
    settings.subtitleRadius = clamp(patch.radius, 0, 24, settings.subtitleRadius);
}

/** 当前字幕外观的快照，直接给字幕窗口用 */
function subtitleStyleSnapshot() {
  return {
    scale: settings.subtitleScale,
    color: settings.subtitleColor,
    stroke: settings.subtitleStroke,
    pos: settings.subtitlePos,
    // hold 传 0：字幕窗不再按墙上时间自动隐藏，改由主进程按视频进度下发 off。
    // 否则暂停时计时器照跑，一句没说完的字幕会被提前吃掉。
    // 真正的停留时长 subtitleHold 由访客页的 ticker 使用，不经这里。
    hold: 0,
    offset: settings.subtitleOffset,
    bgOpacity: settings.subtitleBgOpacity,
    keepRatio: settings.subtitleKeepRatio,
    fade: settings.subtitleFade,
    maxWidth: settings.subtitleMaxWidth,
    weight: settings.subtitleWeight,
    radius: settings.subtitleRadius
  };
}

/** 把外观推给字幕窗口；窗口还没建就跳过（下次显示时会带上最新配置） */
function pushSubtitleConfig() {
  if (!subtitleWin || subtitleWin.isDestroyed()) return;
  try {
    subtitleWin.webContents.send('subtitle:config', subtitleStyleSnapshot());
  } catch {
    /* 窗口正在销毁 */
  }
}

function pushTurnConfig() {
  if (!subtitleWin || subtitleWin.isDestroyed()) return;
  try {
    subtitleWin.webContents.send('turn:config', turnStyleSnapshot());
  } catch {
    /* 窗口正在销毁 */
  }
}

function pushTurnHint(hint) {
  if (!hint && (!subtitleWin || subtitleWin.isDestroyed())) return;

  const w = createSubtitleWindow();
  // 剧情期间不弹转向箭头（每句字幕都会触发，否则字幕层刚藏就被顶出来）
  if (hint && !w.isVisible() && !storyHidden) w.showInactive();
  if (hint) {
    w.webContents.send('subtitle:config', subtitleStyleSnapshot());
    w.webContents.send('turn:config', turnStyleSnapshot());
  }

  const send = () => {
    if (!w || w.isDestroyed()) return;
    w.webContents.send('turn:hint', hint || { off: true });
    console.log('[turn] 主进程 → 字幕层:', hint ? hint.dir : 'off', '| visible=', w.isVisible());
  };
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', send);
  else send();
}

/**
 * 转向提示：把方向塞给字幕层里的大箭头；null 表示收起。
 *
 * 两个容易踩的点：
 *  1) 字幕条关掉时窗口可能还没建 —— 要按需创建；
 *  2) 窗口建好但被 hide 了（字幕 3 秒淡出后不会 hide，但关开关会），
 *     这里必须主动 showInactive，否则箭头画在隐藏窗口里，等于没显示。
 */
function applyTurnStylePatch(patch = {}) {
  const clamp = (v, min, max, fb) =>
    Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Math.round(Number(v)))) : fb;

  if (patch.offset !== undefined) settings.turnOffset = clamp(patch.offset, 10, 400, settings.turnOffset);
  if (patch.scale !== undefined) settings.turnScale = clamp(patch.scale, 60, 200, settings.turnScale);
  if (patch.duration !== undefined)
    settings.turnDuration = clamp(patch.duration, 1, 10, settings.turnDuration);
  if (patch.opacity !== undefined)
    settings.turnOpacity = clamp(patch.opacity, 20, 100, settings.turnOpacity);
  if (typeof patch.color === 'string' && /^#[0-9a-f]{6}$/i.test(patch.color)) {
    settings.turnColor = patch.color.toLowerCase();
  }
  if (patch.posY !== undefined) settings.turnPosY = clamp(patch.posY, 5, 95, settings.turnPosY);
  if (patch.posX !== undefined) settings.turnPosX = clamp(patch.posX, 5, 95, settings.turnPosX);
  // 分组开关：左右 / 上下 可以分开启用
  if (patch.enableLR !== undefined) settings.turnEnableLR = !!patch.enableLR;
  if (patch.enableUD !== undefined) settings.turnEnableUD = !!patch.enableUD;
}

function turnStyleSnapshot() {
  return {
    offset: settings.turnOffset,
    scale: settings.turnScale,
    duration: settings.turnDuration,
    opacity: settings.turnOpacity,
    color: settings.turnColor,
    posY: settings.turnPosY,
    posX: settings.turnPosX
  };
}

function pushRadarConfig() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const b = settings.bearing || {};
  /* 只要「开过箭头 + 有可用布局」就挂雷达。
   * 上游改成命名布局后不再有 rois / roiBy：是否已标定看当前布局是否已经对准圆心。 */
  const layout = activeBearingLayout(b);
  const hasRois = !!(layout && layout.roi && Array.isArray(b.layouts) && b.layouts.length > 0);
  const visible = !!b.enabled && hasRois;
  const payload = {
    radius: Math.max(60, Number(b.radius) || 110),
    visible,
    // 高亮时序：雷达圈和放大提醒窗必须同亮同灭
    hold: CUE_HOLD_MS,
    fade: CUE_FADE_MS
  };
  try {
    overlayWin.webContents.send('radar:config', payload);
  } catch {
    /* 窗口正在销毁 */
  }
}

function cueSubtitleText(text) {
  const t = String(text || '');
  if (!t) return;
  lastSubtitleTextAt = Date.now();
  if (!win || win.isDestroyed()) return;
  // 记一句：能区分「主进程根本没发」和「发了但浮窗没解析」
  const now = Date.now();
  if (now - lastCueTextAt > 3000) {
    lastCueTextAt = now;
    const gap = lastPartSwitchAt ? Math.round((Date.now() - lastPartSwitchAt) / 100) / 10 : null;
    console.log('[cueText]', { text: t.slice(0, 40), sincePart: gap });
  }
  try {
    sendTo(win, 'compass-text', { text: t });
  } catch (err) {
    console.log('[cueText]', { error: String((err && err.message) || err) });
  }
}

function alertSize() {
  // 必须和叠加层里**实际画出来的圆环**对齐：
  // radar.js 的 radius() 是「窗口短边的一半 × 0.86」，不是整个窗口。
  // 按窗口尺寸裁会大出约 4%，看着就是「边框比画面大一圈」。
  return Math.round(overlaySize() * 0.86);
}

function alertBounds() {
  const size = alertSize();
  // 默认放在主屏右侧居中：不挡游戏主体，余光能看到
  let area = null;
  try {
    area = screen.getPrimaryDisplay().workArea;
  } catch {
    area = null;
  }
  if (!area) return { x: 40, y: 40, width: size, height: size };

  const x = Number.isFinite(settings.alertX) ? settings.alertX : Math.round(area.x + area.width - size - 40);
  const y = Number.isFinite(settings.alertY) ? settings.alertY : Math.round(area.y + (area.height - size) / 2);
  return { x, y, width: size, height: size };
}

function createAlertWindow() {
  if (alertWin && !alertWin.isDestroyed()) return alertWin;

  alertWin = new BrowserWindow({
    ...alertBounds(),
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
    title: 'GIFA 放大提醒',
    webPreferences: {
      preload: path.join(__dirname, 'alert', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 窗口平时是隐藏的，但屏幕流必须继续跑 ——
      // 否则每次点亮都要重新建流，第一帧空白半秒。
      backgroundThrottling: false
    }
  });

  alertWin.setAlwaysOnTop(true, 'screen-saver');
  // 平时整窗穿透：提醒窗不能挡游戏点击，只有放置模式才接管鼠标
  alertWin.setIgnoreMouseEvents(true, { forward: true });

  alertWin.on('move', () => {
    if (!alertWin || alertWin.isDestroyed()) return;
    const b = alertWin.getBounds();
    settings.alertX = Math.round(b.x);
    settings.alertY = Math.round(b.y);
    persist();
  });

  alertWin.on('closed', () => {
    alertWin = null;
    alertHideTimer = null;
  });

  alertWin.loadFile(path.join(__dirname, 'alert', 'index.html'));
  alertWin.webContents.on('did-finish-load', () => {
    if (!alertWin || alertWin.isDestroyed()) return;
    alertWin.webContents.send('alert:placing', alertPlacing);
    // 页面一就绪就把屏幕流建起来，等第一次点亮时画面已经在了
    sendAlertStream();
  });

  return alertWin;
}

function setAlertPlacing(on) {
  alertPlacing = !!on;
  const w = alertPlacing ? createAlertWindow() : alertWin;
  if (!w || w.isDestroyed()) return alertPlacing;
  // 放置模式要能拖：放开鼠标接管，并让页面切成可拖动区域
  w.setIgnoreMouseEvents(!alertPlacing, { forward: true });
  // 无边框窗口靠 -webkit-app-region: drag 拖动，而 Windows 上
  // 这一步需要窗口能被激活。提醒窗平时是 focusable:false（不能抢游戏焦点），
  // 拖拽就会时好时坏 —— 放置期间临时放开，退出时立刻收回去。
  try {
    w.setFocusable(alertPlacing);
  } catch {
    /* 个别平台没有这个方法 */
  }
  if (alertPlacing && !w.isVisible() && !storyHidden) w.showInactive();
  if (!w.webContents.isLoading()) w.webContents.send('alert:placing', alertPlacing);
  return alertPlacing;
}

async function sendAlertStream() {
  const w = alertWin;
  if (!w || w.isDestroyed()) return;

  let display = null;
  try {
    display = screen.getDisplayMatching(overlayBounds());
  } catch {
    display = null;
  }
  if (!display) return;

  let sources = [];
  try {
    // 只要 sourceId，缩略图给 1×1 就够，几乎不花时间
    sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
  } catch (err) {
    console.warn('[alert] 取屏幕源失败：', err && err.message);
    return;
  }
  if (!sources || !sources.length) return;

  const src = sources.find((x) => String(x.display_id) === String(display.id)) || sources[0];
  const ring = alertSize();
  const b = overlayBounds();
  const cx = b.x + b.width / 2 - ring / 2;
  const cy = b.y + b.height / 2 - ring / 2;

  const payload = {
    sourceId: src.id,
    region: {
      x: Math.round(cx - display.bounds.x),
      y: Math.round(cy - display.bounds.y),
      size: ring
    },
    screen: { width: display.size.width, height: display.size.height }
  };

  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', () => {
    if (w && !w.isDestroyed()) w.webContents.send('alert:stream', payload);
  });
  else {
    try {
      w.webContents.send('alert:stream', payload);
    } catch {
      /* 窗口正在销毁 */
    }
  }
}

function showAlertCue() {
  if (!settings.alertEnabled) return;

  /* 只记录，不改行为 —— 提醒窗是不是把罗盘拖卡了，还没有证据，
   * 先让它照常亮，用日志看「提醒窗亮着」和「罗盘停摆」是否真的同步。 */
  if (Date.now() - lastAlertAt > 10000) {
    lastAlertAt = Date.now();
    console.log('[alert]', { show: true, overlay: !!overlayWin && !overlayWin.isDestroyed() });
  }

  const w = createAlertWindow();
  const hold = CUE_HOLD_MS;

  const push = () => {
    if (!w || w.isDestroyed()) return;
    try {
      const size = alertSize();
      const b = w.getBounds();
      if (b.width !== size || b.height !== size) w.setBounds({ ...b, width: size, height: size });
      w.webContents.send('alert:show', { hold });
      if (!w.isVisible() && !storyHidden) w.showInactive();
      // 位置/半径可能刚改过，顺手把显示区域同步过去
      sendAlertStream();
    } catch {
      /* 窗口正在销毁 */
    }
  };

  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', push);
  else push();

  clearTimeout(alertHideTimer);
  alertHideTimer = setTimeout(() => {
    if (!alertWin || alertWin.isDestroyed()) return;
    if (alertPlacing) return; // 正在拖动就先别藏
    try {
      alertWin.hide(); // 隐藏窗口但保留屏幕流，下次点亮不用重连
    } catch {
      /* 窗口正在销毁 */
    }
  }, CUE_HOLD_MS + ALERT_FADE_MS);
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
// 底部字幕层
let subtitleWin = null;
let subtitleCues = [];
let subtitleCid = 0;
let subtitleGen = 0;
let lastApiSubtitleText = '';
let lastDomSubtitleText = '';
// 当前分 P 的 cid，字幕按它拉官方轨
let currentCid = 0;
// 放大提醒窗
let alertWin = null;
let alertPlacing = false;
let alertStreamTimer = null;
let lastAlertCueAt = 0;
// 字幕续期（雷达光晕只亮 3.2 秒，字还挂着时要按节奏补）
let lastCompassKeepAlive = 0;
let lastCueTextAt = 0;
let lastSubtitleTextAt = 0;
let lastPartSwitchAt = 0;
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

  /* ---- 底部字幕精灵 ---- */
  ipcMain.on('subtitle:time', (_e, payload = {}) => {
    if (!settings.enableSubtitleSprite) return;
    if (!subtitleCues.length) return; // 没有接口字幕，走 DOM 抓取那条路
    // 暂停时按开关决定要不要清屏
    if (payload && payload.paused && settings.subtitleHideOnPause) {
      if (lastApiSubtitleText) {
        lastApiSubtitleText = '';
        hideSubtitleText();
      }
      return;
    }
    const t = Number(payload && payload.t);
    if (!Number.isFinite(t)) return;
    const text = subtitleAt(t);
    if (text === lastApiSubtitleText) {
      /* 同一句字幕还在屏幕上：定期续期罗盘。
       *
       * 接口字幕只在**文本变化**时才推送，文本不变就再也没有消息。
       * 而叠加层的光晕 3.2 秒就淡出 —— 用户看到字、抬头看小地图，
       * 光早就没了，所以一直觉得「根本没亮」。
       * 这里由主进程按帧驱动续期，不依赖文本变化。 */
      if (text && Date.now() - lastCompassKeepAlive > 1000) {
        lastCompassKeepAlive = Date.now();
        cueSubtitleText(text);
      }
      return;
    }
    lastApiSubtitleText = text;
    lastCompassKeepAlive = Date.now();
    if (text) {
      showSubtitleText(text);
      // 接口字幕也要判方位，否则雷达在这种模式下永远不亮
      cueSubtitleText(text);
    } else {
      hideSubtitleText();
    }
  });

  ipcMain.on('subtitle:update', (_e, payload = {}) => {
    if (!settings.enableSubtitleSprite) {
      hideSubtitleText();
      return;
    }
    if (payload && payload.off) {
      hideSubtitleText();
      return;
    }
    const text = String((payload && payload.text) || '').trim();
    if (!text) return;
    if (text !== lastDomSubtitleText) cueSubtitleText(text);
    lastDomSubtitleText = text;
    showSubtitleText(text);
  });

  ipcMain.on('subtitle:idle', () => {
    if (!subtitleWin || subtitleWin.isDestroyed()) return;
    if (!settings.enableSubtitleSprite && !settings.enableTurnReminder) return;
    // 窗口 hide 后仍保留实例，下次有文本时 showInactive 即可，不用重建
    if (subtitleWin.isVisible()) subtitleWin.hide();
  });

  ipcMain.handle('subtitle:status', () => {
    const api = subtitleCues.length > 0;
    return {
      mode: api ? 'api' : lastDomSubtitleText ? 'dom' : 'none',
      count: subtitleCues.length,
      cid: subtitleCid,
      // 官方字幕模式取主进程查表的结果，DOM 模式取访客页推上来的最后一句
      lastText: api ? lastApiSubtitleText : lastDomSubtitleText,
      enabled: !!settings.enableSubtitleSprite,
      apiEnabled: settings.subtitleUseApi !== false
    };
  });

  ipcMain.handle('subtitle:refetch', async () => {
    if (!settings.subtitleUseApi) return { ok: false, reason: 'api-off' };
    const bvid = settings.lastVideoId;
    const cid = currentCid;
    if (!bvid || !cid) return { ok: false, reason: 'no-video' };
    subtitleCid = 0;
    subtitleCues = [];
    subtitleGen += 1;
    const gen = subtitleGen;
    lastApiSubtitleText = '';
    const cues = await fetchSubtitleCues(bvid, cid, gen);
    if (cues === null || gen !== subtitleGen) return { ok: false, reason: 'stale' };
    if (win && !win.isDestroyed()) {
      sendTo(win, 'subtitle:api', { on: cues.length > 0, count: cues.length });
    }
    return { ok: true, count: cues.length };
  });

  /* ---- 转向提醒 ---- */
  ipcMain.on('turn:update', (_e, payload = {}) => {
    if (!settings.enableTurnReminder) return;
    // 分组开关（前端已过滤一次，这里再兜一道，防止旧配置/竞态漏过来）
    if (payload && (payload.dir === 'left' || payload.dir === 'right') && !settings.turnEnableLR) return;
    if (payload && (payload.dir === 'up' || payload.dir === 'down') && !settings.turnEnableUD) return;
    if (payload && payload.off) {
      pushTurnHint(null);
      return;
    }
    const dir = String(payload.dir || '');
    if (!dir) return;
    pushTurnHint({ dir, label: String(payload.label || ''), text: String(payload.text || '') });
  });

  /* ---- 罗盘雷达 / 放大提醒 ---- */
  ipcMain.handle('alert:place', (_e, on) => {
    const next = on === undefined ? !alertPlacing : !!on;
    const result = setAlertPlacing(next);
    // 进放置模式时同步一次显示区域，窗口才有画面
    if (result) sendAlertStream();
    return result;
  });

  ipcMain.on('compass:cue', (_e, cue) => {
    const deg = Number(cue && cue.deg);
    if (!Number.isFinite(deg)) return;
    const alive = !!overlayWin && !overlayWin.isDestroyed();
    console.log('[compass]', {
      deg,
      label: String(cue.label || ''),
      text: String(cue.text || ''),
      overlay: alive,
      radar: !!settings.overlayRadar
    });

    /* 放大提醒：画面由常驻屏幕流实时提供，所以这里是「直接亮窗」，
     * 没有任何抓图等待 —— 和雷达同一帧出现。
     * 放在叠加层判断之前：提醒窗和雷达是两件事，
     * 叠加层没开的时候提醒不该跟着一起哑掉。 */
    showAlertCue();

    if (!alive) return;
    try {
      overlayWin.webContents.send('compass:cue', { deg, label: String(cue.label || '') });
    } catch {
      /* 窗口正在销毁 */
    }
  });

  ipcMain.on('compass:none', (_e, payload = {}) => {
    const now = Date.now();
    if (now - lastCompassNoneAt < 2000) return;
    lastCompassNoneAt = now;
    console.log('[compassNone]', {
      reason: String(payload.reason || ''),
      text: String(payload.text || '').slice(0, 50),
      deg: payload.deg
    });
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
    /* 字幕开关：开了建窗口并拉字幕轨，关了销毁 */
    if (typeof patch.enableSubtitleSprite === 'boolean') {
      settings.enableSubtitleSprite = patch.enableSubtitleSprite;
      if (settings.enableSubtitleSprite) {
        createSubtitleWindow();
        pushSubtitleConfig();
        // 视频已经载入后才打开开关：补拉一次官方字幕轨
        if (settings.subtitleUseApi && settings.lastVideoId && currentCid) {
          subtitleGen += 1;
          fetchSubtitleCues(settings.lastVideoId, currentCid, subtitleGen);
        }
      } else {
        hideSubtitleText();
        destroySubtitleWindow();
      }
    }
    // 字幕样式与开关：改了就下发
    const subKeys = ['subtitleUseApi', 'subtitleHideNative', 'subtitleMergeOverlap',
      'subtitleHideOnPause', 'subtitleAutoOpen', 'subtitlePauseOnClear'];
    let subChanged = false;
    for (const key of subKeys) {
      if (typeof patch[key] === 'boolean') { settings[key] = patch[key]; subChanged = true; }
    }
    if (patch.subtitle && typeof patch.subtitle === 'object') {
      if (patch.subtitle.pos !== undefined) settings.subtitlePos = patch.subtitle.pos;
      subChanged = true;
    }
    if (subChanged) pushSubtitleConfig();
    // 清怪暂停的延迟秒数（0~10，0 = 立即）
    if (patch.subtitlePauseDelay !== undefined) {
      const v = Number(patch.subtitlePauseDelay);
      if (Number.isFinite(v)) settings.subtitlePauseDelay = Math.max(0, Math.min(10, v));
    }
    /* 转向提醒：与字幕共用窗口，任一个开着就要有窗口 */
    if (typeof patch.enableTurnReminder === 'boolean') {
      settings.enableTurnReminder = patch.enableTurnReminder;
      if (settings.enableTurnReminder) createSubtitleWindow();
      else if (!settings.enableSubtitleSprite) destroySubtitleWindow();
      pushTurnConfig();
    }
    for (const key of ['turnEnableLR', 'turnEnableUD']) {
      if (typeof patch[key] === 'boolean') { settings[key] = patch[key]; pushTurnConfig(); }
    }
    /* 罗盘雷达 / 放大提醒 */
    if (typeof patch.overlayRadar === 'boolean') {
      settings.overlayRadar = patch.overlayRadar;
      pushRadarConfig();
    }
    if (typeof patch.alertEnabled === 'boolean') {
      settings.alertEnabled = patch.alertEnabled;
      if (settings.alertEnabled) createAlertWindow();
      else if (alertWin && !alertWin.isDestroyed()) { alertWin.destroy(); alertWin = null; }
    }
    if (Number.isFinite(Number(patch.alertSize))) {
      settings.alertSize = Math.max(120, Math.min(600, Number(patch.alertSize)));
      if (alertWin && !alertWin.isDestroyed()) alertWin.setBounds(alertBounds());
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

    /* 字幕按 cid 拉官方轨。切 P 时 cid 会变，旧字幕必须丢掉重建，
     * 否则新一 P 会弹出上一 P 的字幕。 */
    const nextCid = pages.find((x) => x.page === p)?.cid || (info.ok ? info.cid : 0) || 0;
    if (nextCid !== currentCid) {
      currentCid = nextCid;
      subtitleCues = [];
      subtitleCid = 0;
      lastApiSubtitleText = '';
      lastDomSubtitleText = '';
    }
    if (currentCid && settings.enableSubtitleSprite && settings.subtitleUseApi) {
      subtitleGen += 1;
      fetchSubtitleCues(id, currentCid, subtitleGen);
    }

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
    const launcher = createConsole(); // 先出启动器，配置好了再点「启动跟跑」
    launcher.on('close', event => {
      if (updates?.isPreparing()) event.preventDefault();
    });
    registerHotkeys();
    // Windows 手柄输入由独立子进程处理，关闭手柄快捷键时无需启动它。
    if (settings.gamepad.enabled) gamepad.start(handleGamepadFrame);

    // 字幕层：设置里开着就启动时建好
    if (settings.enableSubtitleSprite) createSubtitleWindow();

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
