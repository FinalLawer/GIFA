'use strict';

/**
 * 手柄输入源：主进程经 PowerShell 子进程轮询 XInput。
 *
 * 为什么不是渲染进程的 Gamepad API：Chromium 要求文档收到过真实用户手势才启动
 * 手柄监视，而轮询宿主窗必须不抢焦点、鼠标穿透、从不 show —— 它永远拿不到手势，
 * 实机在游戏前台时 getGamepads() 恒空。XInput 是 OS 层轮询，与焦点和手势无关。
 *
 * 帧数据只走 stdout 逐行 JSON，子进程按签名去重，静默时不产行。
 */

const { spawn } = require('node:child_process');
const { xinputToFrame } = require('./gamepad-config');

const SLOT_COUNT = 4;
const POLL_MS = 16;
const RESTART_DELAY_MS = 1000;
const RESTART_LIMIT = 3;

const XINPUT_CSHARP = `
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential, Pack = 4)]
public struct XGamepad {
  public ushort wButtons;
  public byte bLeftTrigger;
  public byte bRightTrigger;
  public short sThumbLX;
  public short sThumbLY;
  public short sThumbRX;
  public short sThumbRY;
  public uint dwPacketNumber;
}

[StructLayout(LayoutKind.Sequential, Pack = 4)]
public struct XState {
  public uint dwPacketNumber;
  public XGamepad Gamepad;
}

public static class Xi {
  delegate int GetStateFn(int user, out XState state);

  [DllImport("kernel32", SetLastError = true)] static extern IntPtr LoadLibrary(string name);
  [DllImport("kernel32", SetLastError = true)] static extern IntPtr GetProcAddress(IntPtr module, string name);

  static GetStateFn fn;

  public static int Probe() {
    if (fn != null) return 0;
    string[] names = { "xinput1_4.dll", "xinput1_3.dll", "xinput9_1_0.dll" };
    for (int i = 0; i < names.Length; i++) {
      IntPtr lib = LoadLibrary(names[i]);
      if (lib == IntPtr.Zero) continue;
      IntPtr addr = GetProcAddress(lib, "XInputGetState");
      if (addr == IntPtr.Zero) continue;
      fn = (GetStateFn)Marshal.GetDelegateForFunctionPointer(addr, typeof(GetStateFn));
      return 0;
    }
    return -1;
  }

  public static int State(int user, out XState state) {
    state = new XState();
    if (fn == null) return -1;
    return fn(user, out state);
  }
}
`;

// PowerShell 的单引号 here-string 结束标记必须顶格，所以下面有两行不能缩进。
const POLL_SCRIPT = `
$ErrorActionPreference = 'Stop'
$code = @'
${XINPUT_CSHARP}
'@
Add-Type -Language CSharp -TypeDefinition $code
if ([Xi]::Probe() -ne 0) {
  [Console]::Out.WriteLine('{"error":"xinput-missing"}')
  [Console]::Out.Flush()
  exit 1
}
$state = New-Object XState
$last = ''
while ($true) {
  $line = '{"none":1}'
  for ($i = 0; $i -lt ${SLOT_COUNT}; $i++) {
    if ([Xi]::State($i, [ref]$state) -eq 0) {
      $g = $state.Gamepad
      $line = '{{"slot":{0},"b":{1},"lt":{2},"rt":{3},"lx":{4},"ly":{5},"rx":{6},"ry":{7}}}' -f $i, [int]$g.wButtons, [int]$g.bLeftTrigger, [int]$g.bRightTrigger, [int]$g.sThumbLX, [int]$g.sThumbLY, [int]$g.sThumbRX, [int]$g.sThumbRY
      break
    }
  }
  if ($line -ne $last) {
    $last = $line
    [Console]::Out.WriteLine($line)
    [Console]::Out.Flush()
  }
  Start-Sleep -Milliseconds ${POLL_MS}
}
`;

let child = null;
let emitFrame = null;
let stopping = false;
let restartTimer = null;
let restarts = 0;
let unavailable = false;
let pendingLine = '';

function powershellPath() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return root + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
}

function handleLine(line) {
  let raw = null;
  try {
    raw = JSON.parse(line);
  } catch {
    return;
  }
  if (raw.error) {
    unavailable = true;
    console.warn('[gamepad] 本机没有可用的 XInput 运行库，手柄功能不可用');
    return;
  }
  if (emitFrame) emitFrame(xinputToFrame(raw));
}

function consumeStdout(chunk) {
  pendingLine += chunk.toString('utf8');
  const lines = pendingLine.split('\n');
  pendingLine = lines.pop();
  for (const line of lines) {
    const text = line.trim();
    if (text) handleLine(text);
  }
}

function spawnPoller() {
  if (child || stopping || unavailable) return;

  const encoded = Buffer.from(POLL_SCRIPT, 'utf16le').toString('base64');
  child = spawn(powershellPath(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    // stderr 不接：PowerShell 的 stderr 一被重定向成管道就先吐一段 CLIXML 框架，
    // 里面并不是错误内容，反而会把日志搞脏。真起不来由退出码和 error 事件报。
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore']
  });

  child.stdout.on('data', consumeStdout);
  child.on('error', (err) => {
    console.warn('[gamepad] 轮询进程起不来：', err.message);
    child = null;
    scheduleRestart();
  });
  child.on('exit', (code) => {
    child = null;
    if (stopping || unavailable) return;
    console.warn('[gamepad] 轮询进程退出（退出码 ' + code + '）');
    scheduleRestart();
  });
}

function scheduleRestart() {
  if (stopping || unavailable || restartTimer) return;
  if (restarts >= RESTART_LIMIT) {
    console.warn('[gamepad] 手柄轮询连续 ' + RESTART_LIMIT + ' 次起不来，本次运行不再重试');
    return;
  }
  restarts += 1;
  restartTimer = setTimeout(() => {
    restartTimer = null;
    spawnPoller();
  }, RESTART_DELAY_MS);
}

/** 起轮询。onFrame 只在手柄状态变化时调一次，参数是 normalizeFrame 后的帧 */
function start(onFrame) {
  emitFrame = typeof onFrame === 'function' ? onFrame : null;
  stopping = false;
  restarts = 0;
  unavailable = false;
  spawnPoller();
}

function stop() {
  stopping = true;
  emitFrame = null;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  if (child) child.kill();
  child = null;
}

module.exports = { start, stop };
