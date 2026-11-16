'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const hookSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'hook-hotkeys.js'), 'utf8');
const keycodes = {
  J: 36, K: 37, A: 30, S: 31, Space: 57, F8: 66, F9: 67, Enter: 28, Escape: 1,
  ArrowLeft: 57419, Minus: 12, Numpad1: 79, 1: 2,
  ScrollLock: 70, CapsLock: 58, NumLock: 69, PrintScreen: 3639,
  Ctrl: 29, CtrlRight: 3613, Alt: 56, AltRight: 3640,
  Shift: 42, ShiftRight: 54, Meta: 3675, MetaRight: 3676
};
const modifierCases = [
  ['Ctrl', 'ctrlKey', 'Ctrl'], ['Ctrl', 'ctrlKey', 'CtrlRight'],
  ['Alt', 'altKey', 'Alt'], ['Alt', 'altKey', 'AltRight'],
  ['Shift', 'shiftKey', 'Shift'], ['Shift', 'shiftKey', 'ShiftRight'],
  ['Super', 'metaKey', 'Meta'], ['Super', 'metaKey', 'MetaRight']
];
const eventNames = ['keydown', 'keyup', 'mousedown', 'mouseup'];
let passed = 0;
let failed = 0;

function check(label, callback) {
  try {
    callback();
    passed += 1;
    console.log('PASS  ' + label);
  } catch (error) {
    failed += 1;
    console.error('FAIL  ' + label + '\n' + error.stack);
  }
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function createHarness(options = {}) {
  const native = new EventEmitter();
  const calls = [];
  const warnings = [];
  const state = {
    ignore: false, ignoreCalls: 0, elapsed: 1000,
    startCalls: 0, stopCalls: 0, nativeRunning: false,
    startError: options.startError, startFalse: options.startFalse,
    stopError: options.stopError, onError: options.onError
  };
  const originalOn = native.on;
  native.on = function (event, listener) {
    originalOn.call(this, event, listener);
    if (state.onError === event) throw new Error('listener failure');
    return this;
  };
  native.start = () => {
    state.startCalls += 1;
    if (state.startError) throw new Error('start failure');
    if (state.startFalse) return false;
    state.nativeRunning = true;
  };
  native.stop = () => {
    state.stopCalls += 1;
    state.nativeRunning = false;
    if (state.stopError) throw new Error('stop failure');
  };
  class ClockDate extends Date {
    static now() { return state.elapsed; }
  }
  const context = vm.createContext({
    module: { exports: {} },
    require(name) {
      assert.equal(name, 'uiohook-napi');
      if (options.unavailable) throw new Error('native unavailable');
      return options.nativeModule || { uIOhook: native, UiohookKey: keycodes };
    },
    Date: ClockDate,
    console: { log() {}, warn: (...messages) => warnings.push(messages) }
  });
  vm.runInContext(hookSource, context, { filename: 'hook-hotkeys.js' });
  const api = context.module.exports;
  const trigger = (...args) => calls.push(args);
  return {
    api, native, calls, warnings, state,
    apply(hotkeys, callback = trigger) {
      return plain(api.apply(hotkeys, callback, () => {
        state.ignoreCalls += 1;
        return typeof state.ignore === 'function' ? state.ignore() : !!state.ignore;
      }));
    },
    key(phase, name, modifiers = {}) {
      assert.ok(keycodes[name], '未知测试键位：' + name);
      native.emit(phase, {
        ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
        ...modifiers, keycode: keycodes[name]
      });
    },
    mouse(phase, button, modifiers = {}) {
      native.emit(phase, {
        ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
        ...modifiers, button
      });
    },
    stop: () => vm.runInContext('stop()', context),
    advance(milliseconds) { state.elapsed += milliseconds; },
    listeners(count) {
      for (const event of eventNames) assert.equal(native.listenerCount(event), count, event);
    }
  };
}

check('动作路由：所有 holdSpeed/cycleSpeed 绑定走钩子，普通组合保留 globalShortcut', () => {
  const { api } = createHarness();
  for (const action of ['holdSpeed', 'cycleSpeed']) {
    for (const accelerator of ['J', 'Ctrl+J', 'Alt+J', 'Shift+J', 'Super+J', 'Ctrl+Alt+Shift+Super+J', 'Mouse4', 'Ctrl+Mouse5']) {
      assert.equal(api.isHookAccelerator(accelerator, action), true, action + ': ' + accelerator);
    }
    assert.equal(api.isHookAccelerator('', action), false);
  }
  for (const accelerator of ['Ctrl+J', 'Alt+Space', 'Shift+F9', 'Super+J']) {
    assert.equal(api.isHookAccelerator(accelerator, 'togglePlay'), false, accelerator);
  }
  for (const accelerator of ['J', 'Space', 'Mouse4', 'mouse5']) assert.equal(api.isHookAccelerator(accelerator), true);
  assert.equal(api.isHookAccelerator('', 'holdSpeed'), false);
  assert.equal(api.isHookAccelerator('  '), false);
  assert.equal(api.describe('Mouse4'), '鼠标侧键（后退）');
  assert.equal(api.describe('Mouse5'), '鼠标侧键（前进）');
});

check('单键 holdSpeed：重复 keydown 超过 200ms 仍只触发一次，快速重按可再触发', () => {
  const harness = createHarness();
  assert.deepEqual(harness.apply({ holdSpeed: 'Space' }), { needed: true, ok: true, keys: [] });
  harness.listeners(1);
  harness.key('keydown', 'Space');
  harness.advance(1000);
  harness.key('keydown', 'Space');
  harness.key('keydown', 'Space', { repeat: true });
  assert.deepEqual(harness.calls, [['holdSpeed', 'down']]);
  harness.key('keyup', 'Space');
  harness.key('keyup', 'Space');
  harness.key('keydown', 'Space');
  harness.key('keyup', 'Space');
  assert.deepEqual(harness.calls, [['holdSpeed', 'down'], ['holdSpeed', 'up'], ['holdSpeed', 'down'], ['holdSpeed', 'up']]);
});

for (const [accelerator, flag, key] of modifierCases) {
  check(`${accelerator}+J：${key} 先松、ignore 开启、主键连发不丢 up 或重启 hold`, () => {
    const harness = createHarness();
    harness.apply({ holdSpeed: accelerator + '+J' });
    harness.key('keydown', key, { [flag]: true });
    harness.key('keydown', 'J', { [flag]: true });
    harness.advance(1000);
    harness.key('keydown', 'J', { [flag]: true });
    harness.state.ignore = () => { throw new Error('keyup must not consult ignore'); };
    harness.key('keyup', key);
    harness.key('keydown', 'J');
    harness.key('keyup', 'J');
    assert.deepEqual(harness.calls, [['holdSpeed', 'down'], ['holdSpeed', 'up']]);
    harness.state.ignore = false;
    harness.key('keydown', 'J');
    harness.key('keyup', 'J');
    assert.equal(harness.calls.length, 2);
    harness.key('keydown', key, { [flag]: true });
    harness.key('keydown', 'J', { [flag]: true });
    harness.key('keyup', 'J', { [flag]: true });
    harness.key('keyup', key);
    assert.deepEqual(harness.calls.slice(2), [['holdSpeed', 'down'], ['holdSpeed', 'up']]);
  });
}

check('多修饰键精确匹配，任一所需 modifier 松开即释放，其他键松开不影响', () => {
  const harness = createHarness();
  harness.apply({ holdSpeed: 'Ctrl+Alt+Shift+Super+J' });
  harness.key('keydown', 'J', { ctrlKey: true, altKey: true, shiftKey: true });
  harness.key('keyup', 'J');
  assert.deepEqual(harness.calls, []);
  const modifiers = { ctrlKey: true, altKey: true, shiftKey: true, metaKey: true };
  harness.key('keydown', 'J', modifiers);
  harness.key('keyup', 'K', modifiers);
  assert.deepEqual(harness.calls, [['holdSpeed', 'down']]);
  harness.key('keyup', 'AltRight', { ...modifiers, altKey: false });
  harness.key('keyup', 'J');
  assert.deepEqual(harness.calls, [['holdSpeed', 'down'], ['holdSpeed', 'up']]);
});

check('单独 Ctrl/Alt/Shift/Super 也可作为长按键', () => {
  for (const [accelerator, flag, key] of modifierCases.filter(([, , key]) => !key.endsWith('Right'))) {
    const harness = createHarness();
    harness.apply({ holdSpeed: accelerator });
    harness.key('keydown', key, { [flag]: true });
    harness.key('keyup', key);
    assert.deepEqual(harness.calls, [['holdSpeed', 'down'], ['holdSpeed', 'up']], accelerator);
  }
});

check('CommandOrControl/CmdOrCtrl 在 Windows 映射 Ctrl，单键和组合均可用于 hold/cycle', () => {
  for (const alias of ['CommandOrControl', 'CmdOrCtrl']) {
    for (const action of ['holdSpeed', 'cycleSpeed']) {
      const harness = createHarness();
      assert.deepEqual(harness.apply({ [action]: alias }), { needed: true, ok: true, keys: [] });
      harness.key('keydown', 'Ctrl', { ctrlKey: true });
      harness.key('keyup', 'Ctrl');
      const expected = action === 'holdSpeed' ? [['holdSpeed', 'down'], ['holdSpeed', 'up']] : [['cycleSpeed']];
      assert.deepEqual(harness.calls, expected, alias + ': ' + action);
      harness.calls.length = 0;
      harness.apply({ [action]: alias + '+J' });
      harness.key('keydown', 'J', { ctrlKey: true });
      harness.key('keyup', 'Ctrl');
      harness.key('keyup', 'J');
      assert.deepEqual(harness.calls, expected, alias + '+J: ' + action);
    }
  }
});

check('左右 modifier 同时按住时松一侧不释放，最后一侧松开才 up', () => {
  const pairs = [
    ['Ctrl', 'Ctrl', 'CtrlRight', 'ctrlKey'],
    ['Alt', 'Alt', 'AltRight', 'altKey'],
    ['Shift', 'Shift', 'ShiftRight', 'shiftKey'],
    ['Super', 'Meta', 'MetaRight', 'metaKey']
  ];
  for (const [accelerator, left, right, flag] of pairs) {
    const harness = createHarness();
    harness.apply({ holdSpeed: accelerator + '+J' });
    harness.key('keydown', left, { [flag]: true });
    harness.key('keydown', right, { [flag]: true });
    harness.key('keydown', 'J', { [flag]: true });
    harness.key('keyup', left, { [flag]: true });
    assert.deepEqual(harness.calls, [['holdSpeed', 'down']], accelerator);
    harness.key('keyup', right);
    harness.key('keyup', 'J');
    assert.deepEqual(harness.calls, [['holdSpeed', 'down'], ['holdSpeed', 'up']], accelerator);
  }
});

check('未观察到 modifier down 时依赖原生 keyup flags，不受重挂前按下影响', () => {
  const harness = createHarness();
  harness.apply({ holdSpeed: 'Ctrl+J' });
  harness.key('keydown', 'J', { ctrlKey: true });
  harness.key('keyup', 'Ctrl', { ctrlKey: true });
  assert.deepEqual(harness.calls, [['holdSpeed', 'down']]);
  harness.key('keyup', 'CtrlRight');
  harness.key('keyup', 'J');
  assert.deepEqual(harness.calls, [['holdSpeed', 'down'], ['holdSpeed', 'up']]);
});

for (const reason of ['打字', '录制热键', '登录窗口']) {
  check(`${reason}：阻止新 down，解除 ignore 后物理长按不能补触发，up 正常清理`, () => {
    const harness = createHarness();
    harness.apply({ holdSpeed: 'J', togglePlay: 'K' });
    harness.state.ignore = true;
    harness.key('keydown', 'J');
    harness.key('keydown', 'K');
    harness.state.ignore = false;
    harness.advance(1000);
    harness.key('keydown', 'J');
    harness.key('keydown', 'K');
    assert.deepEqual(harness.calls, []);
    harness.state.ignore = true;
    harness.key('keyup', 'J');
    harness.key('keyup', 'K');
    harness.state.ignore = false;
    harness.key('keydown', 'J');
    harness.state.ignore = true;
    harness.key('keyup', 'J');
    harness.state.ignore = false;
    harness.key('keydown', 'K');
    harness.key('keyup', 'K');
    assert.deepEqual(harness.calls, [['holdSpeed', 'down'], ['holdSpeed', 'up'], ['togglePlay']]);
  });
}

check('重绑先给旧回调补 up，再启用新回调，并清理物理 pressed', () => {
  const harness = createHarness();
  const nextCalls = [];
  harness.apply({ holdSpeed: 'J' });
  harness.key('keydown', 'J');
  harness.apply({ holdSpeed: 'J' }, (...args) => nextCalls.push(args));
  assert.deepEqual(harness.calls, [['holdSpeed', 'down'], ['holdSpeed', 'up']]);
  assert.deepEqual(nextCalls, []);
  harness.key('keydown', 'J');
  harness.key('keyup', 'J');
  assert.deepEqual(nextCalls, [['holdSpeed', 'down'], ['holdSpeed', 'up']]);
  harness.listeners(1);
});

check('改绑到其他主键后，旧主键释放不能结束新 hold', () => {
  const harness = createHarness();
  harness.apply({ holdSpeed: 'J' });
  harness.key('keydown', 'J');
  harness.apply({ holdSpeed: 'K' });
  harness.key('keydown', 'K');
  harness.key('keyup', 'J');
  assert.equal(harness.calls.length, 3);
  harness.key('keyup', 'K');
  assert.deepEqual(harness.calls, [['holdSpeed', 'down'], ['holdSpeed', 'up'], ['holdSpeed', 'down'], ['holdSpeed', 'up']]);
});

check('映射清空、仅剩普通组合、全为未知绑定均取消 hold 并停止原生监听', () => {
  for (const hotkeys of [{}, { togglePlay: 'Alt+Space' }, { holdSpeed: 'Unknown+J' }]) {
    const harness = createHarness();
    harness.apply({ holdSpeed: 'J' });
    harness.key('keydown', 'J');
    const result = harness.apply(hotkeys);
    assert.deepEqual(harness.calls, [['holdSpeed', 'down'], ['holdSpeed', 'up']]);
    assert.equal(harness.api.isRunning(), false);
    assert.equal(harness.state.nativeRunning, false);
    harness.listeners(0);
    if (hotkeys.holdSpeed) assert.deepEqual(result.keys, ['Unknown+J']);
    else assert.deepEqual(result, { needed: false, ok: true, keys: [] });
  }
});

check('stop 取消 hold、移除所有监听；重复停止幂等且再次 apply 可用', () => {
  const harness = createHarness();
  harness.apply({ holdSpeed: 'J' });
  harness.key('keydown', 'J');
  harness.stop();
  harness.stop();
  harness.key('keyup', 'J');
  assert.deepEqual(harness.calls, [['holdSpeed', 'down'], ['holdSpeed', 'up']]);
  assert.equal(harness.api.isRunning(), false);
  assert.equal(harness.state.stopCalls, 1);
  harness.listeners(0);
  harness.apply({ holdSpeed: 'J' });
  harness.key('keydown', 'J');
  harness.key('keyup', 'J');
  assert.equal(harness.calls.length, 4);
});

check('F8 hold 在 restore/rearm 后取消，连续重挂与按键连发需等真实 up 才解锁', () => {
  const harness = createHarness();
  harness.apply({ holdSpeed: 'F8' });
  harness.key('keydown', 'F8');
  assert.equal(harness.api.rearm(), true);
  assert.deepEqual(harness.calls, [['holdSpeed', 'down'], ['holdSpeed', 'up']]);
  harness.listeners(1);
  assert.equal(harness.state.startCalls, 2);
  assert.equal(harness.state.stopCalls, 1);
  harness.advance(1000);
  harness.key('keydown', 'F8', { repeat: true });
  assert.equal(harness.api.rearm(), true);
  harness.key('keydown', 'F8');
  assert.equal(harness.calls.length, 2);
  harness.state.ignore = () => { throw new Error('blocked keyup must not consult ignore'); };
  harness.key('keyup', 'F8');
  harness.state.ignore = false;
  harness.key('keydown', 'F8');
  harness.key('keyup', 'F8');
  assert.deepEqual(harness.calls, [['holdSpeed', 'down'], ['holdSpeed', 'up'], ['holdSpeed', 'down'], ['holdSpeed', 'up']]);
  harness.listeners(1);
});

check('rearm 启动失败返回 false、释放 hold、移除监听，后续 apply 可恢复', () => {
  const harness = createHarness();
  harness.apply({ holdSpeed: 'J' });
  harness.key('keydown', 'J');
  harness.state.startError = true;
  assert.equal(harness.api.rearm(), false);
  assert.deepEqual(harness.calls, [['holdSpeed', 'down'], ['holdSpeed', 'up']]);
  assert.equal(harness.api.isRunning(), false);
  harness.listeners(0);
  harness.state.startError = false;
  assert.equal(harness.apply({ holdSpeed: 'J' }).ok, true);
  harness.key('keydown', 'J');
  assert.equal(harness.calls.length, 2);
  harness.key('keyup', 'J');
  harness.key('keydown', 'J');
  harness.key('keyup', 'J');
  assert.equal(harness.calls.length, 4);
});

check('rearm 无 active hold 时也保留普通按键、被 ignore 的键与鼠标的物理屏障', () => {
  const harness = createHarness();
  harness.apply({ togglePlay: 'J', holdSpeed: 'K', seekFwd: 'Mouse4' });
  harness.key('keydown', 'J');
  harness.mouse('mousedown', 4);
  harness.state.ignore = true;
  harness.key('keydown', 'K');
  assert.equal(harness.api.rearm(), true);
  harness.state.ignore = false;
  harness.key('keydown', 'J');
  harness.key('keydown', 'K');
  harness.mouse('mousedown', 4);
  assert.deepEqual(harness.calls, [['togglePlay'], ['seekFwd']]);
  harness.key('keyup', 'J');
  harness.key('keyup', 'K');
  harness.mouse('mouseup', 4);
  harness.key('keydown', 'J');
  harness.key('keydown', 'K');
  harness.mouse('mousedown', 4);
  assert.deepEqual(harness.calls, [['togglePlay'], ['seekFwd'], ['togglePlay'], ['holdSpeed', 'down'], ['seekFwd']]);
  harness.key('keyup', 'J');
  harness.key('keyup', 'K');
  harness.mouse('mouseup', 4);
  assert.deepEqual(harness.calls.at(-1), ['holdSpeed', 'up']);
});

check('Mouse5 hold 重挂后释放不受 ignore 阻挡，mouseup 解锁下一次点击', () => {
  const harness = createHarness();
  harness.apply({ holdSpeed: 'Mouse5' });
  harness.mouse('mousedown', 5);
  harness.api.rearm();
  harness.mouse('mousedown', 5);
  assert.deepEqual(harness.calls, [['holdSpeed', 'down'], ['holdSpeed', 'up']]);
  harness.state.ignore = () => { throw new Error('blocked mouseup must not consult ignore'); };
  harness.mouse('mouseup', 5);
  harness.state.ignore = false;
  harness.mouse('mousedown', 5);
  harness.mouse('mouseup', 5);
  assert.equal(harness.calls.length, 4);
});

check('rearm 后左右 modifier 的屏障也参与组合释放判断', () => {
  const harness = createHarness();
  harness.apply({ holdSpeed: 'Ctrl+J' });
  harness.key('keydown', 'Ctrl', { ctrlKey: true });
  harness.key('keydown', 'CtrlRight', { ctrlKey: true });
  harness.api.rearm();
  harness.key('keydown', 'J', { ctrlKey: true });
  harness.key('keyup', 'Ctrl');
  assert.deepEqual(harness.calls, [['holdSpeed', 'down']]);
  harness.key('keyup', 'CtrlRight');
  harness.key('keyup', 'J');
  assert.deepEqual(harness.calls, [['holdSpeed', 'down'], ['holdSpeed', 'up']]);
});

check('cancelHeld 主动发 up 且幂等，物理键尚未松开时不因连发重新 down', () => {
  const harness = createHarness();
  harness.apply({ holdSpeed: 'J' });
  harness.key('keydown', 'J');
  assert.equal(harness.api.cancelHeld(), true);
  assert.equal(harness.api.cancelHeld(), false);
  harness.advance(1000);
  harness.key('keydown', 'J');
  harness.key('keyup', 'J');
  assert.deepEqual(harness.calls, [['holdSpeed', 'down'], ['holdSpeed', 'up']]);
  harness.key('keydown', 'J');
  harness.key('keyup', 'J');
  assert.equal(harness.calls.length, 4);
});

for (const button of [4, 5]) {
  check(`Mouse${button} 长按、重复 mousedown、ignore 下释放和再次点击`, () => {
    const harness = createHarness();
    harness.apply({ holdSpeed: 'Mouse' + button });
    harness.mouse('mousedown', button);
    harness.advance(1000);
    harness.mouse('mousedown', button);
    harness.state.ignore = () => { throw new Error('mouseup must not consult ignore'); };
    harness.mouse('mouseup', button);
    harness.mouse('mouseup', button);
    assert.deepEqual(harness.calls, [['holdSpeed', 'down'], ['holdSpeed', 'up']]);
    harness.state.ignore = true;
    harness.mouse('mousedown', button);
    harness.state.ignore = false;
    harness.mouse('mousedown', button);
    assert.equal(harness.calls.length, 2);
    harness.mouse('mouseup', button);
    harness.mouse('mousedown', button);
    harness.mouse('mouseup', button);
    assert.equal(harness.calls.length, 4);
  });
}

check('Ctrl+Mouse5 modifier 先松即结束，鼠标主键继续按住不会重新触发', () => {
  const harness = createHarness();
  harness.apply({ holdSpeed: 'Ctrl+Mouse5' });
  harness.key('keydown', 'Ctrl', { ctrlKey: true });
  harness.mouse('mousedown', 5, { ctrlKey: true });
  harness.key('keyup', 'Ctrl');
  harness.mouse('mousedown', 5, { ctrlKey: true });
  harness.mouse('mouseup', 5);
  assert.deepEqual(harness.calls, [['holdSpeed', 'down'], ['holdSpeed', 'up']]);
});

check('cycleSpeed 默认 Alt+S 被动监听：一次物理按下仅一个单参数回调', () => {
  const harness = createHarness();
  assert.deepEqual(harness.apply({ cycleSpeed: 'Alt+S', togglePlay: 'Ctrl+K' }), { needed: true, ok: true, keys: [] });
  harness.key('keydown', 'S');
  harness.key('keyup', 'S');
  harness.key('keydown', 'S', { altKey: true, shiftKey: true });
  harness.key('keyup', 'S');
  assert.deepEqual(harness.calls, []);
  harness.key('keydown', 'Alt', { altKey: true });
  harness.key('keydown', 'S', { altKey: true });
  harness.advance(1000);
  harness.key('keydown', 'S', { altKey: true, repeat: true });
  harness.key('keyup', 'Alt');
  harness.key('keydown', 'S', { altKey: true });
  assert.deepEqual(harness.calls, [['cycleSpeed']]);
  harness.state.ignore = () => { throw new Error('cycle keyup must not consult ignore'); };
  harness.key('keyup', 'S');
  harness.state.ignore = false;
  harness.key('keydown', 'S', { altKey: true });
  harness.key('keyup', 'S', { altKey: true });
  harness.key('keydown', 'K', { ctrlKey: true });
  harness.key('keyup', 'K');
  assert.deepEqual(harness.calls, [['cycleSpeed'], ['cycleSpeed']]);
});

check('cycleSpeed 全部 modifier 组合、普通单键与鼠标侧键均按物理去重', () => {
  for (const [accelerator, flag] of modifierCases) {
    const harness = createHarness();
    harness.apply({ cycleSpeed: accelerator + '+J' });
    harness.key('keydown', 'J', { [flag]: true });
    harness.advance(1000);
    harness.key('keydown', 'J', { [flag]: true });
    harness.key('keyup', 'J');
    assert.deepEqual(harness.calls, [['cycleSpeed']], accelerator);
  }
  for (const button of [4, 5]) {
    const harness = createHarness();
    harness.apply({ cycleSpeed: 'Ctrl+Mouse' + button });
    harness.mouse('mousedown', button);
    harness.mouse('mouseup', button);
    harness.mouse('mousedown', button, { ctrlKey: true });
    harness.advance(1000);
    harness.mouse('mousedown', button, { ctrlKey: true });
    harness.mouse('mouseup', button);
    assert.deepEqual(harness.calls, [['cycleSpeed']]);
  }
  const harness = createHarness();
  harness.apply({ cycleSpeed: 'J' });
  harness.key('keydown', 'J');
  harness.key('keydown', 'J');
  harness.key('keyup', 'J');
  assert.deepEqual(harness.calls, [['cycleSpeed']]);
});

check('cycleSpeed ignore 不补触发，重挂仍需物理 up 解锁，keyup 不触发动作', () => {
  const harness = createHarness();
  harness.apply({ cycleSpeed: 'Alt+S' });
  harness.state.ignore = true;
  harness.key('keydown', 'S', { altKey: true });
  harness.state.ignore = false;
  harness.key('keydown', 'S', { altKey: true });
  harness.key('keyup', 'S');
  assert.deepEqual(harness.calls, []);
  harness.key('keydown', 'S', { altKey: true });
  harness.api.rearm();
  harness.advance(1000);
  harness.key('keydown', 'S', { altKey: true });
  assert.deepEqual(harness.calls, [['cycleSpeed']]);
  harness.key('keyup', 'S');
  harness.key('keydown', 'S', { altKey: true });
  harness.key('keyup', 'S');
  assert.deepEqual(harness.calls, [['cycleSpeed'], ['cycleSpeed']]);
});

check('普通单键：超过 200ms 仍不连发，keyup 不受 ignore 阻挡，快速重按单参数触发', () => {
  const harness = createHarness();
  harness.apply({ togglePlay: 'J', seekFwd: 'Ctrl+K' });
  harness.key('keydown', 'J');
  harness.advance(1000);
  harness.key('keydown', 'J');
  assert.deepEqual(harness.calls, [['togglePlay']]);
  harness.state.ignore = true;
  harness.key('keyup', 'J');
  harness.state.ignore = false;
  harness.key('keydown', 'J');
  harness.key('keyup', 'J');
  harness.key('keydown', 'K', { ctrlKey: true });
  harness.key('keyup', 'K');
  assert.deepEqual(harness.calls, [['togglePlay'], ['togglePlay']]);
});

check('普通按键在带 modifier 时不触发，松 modifier 后主键连发也不补触发', () => {
  const harness = createHarness();
  harness.apply({ togglePlay: 'J' });
  harness.key('keydown', 'J', { altKey: true });
  harness.key('keyup', 'Alt');
  harness.advance(1000);
  harness.key('keydown', 'J');
  harness.key('keyup', 'J');
  assert.deepEqual(harness.calls, []);
  harness.key('keydown', 'J');
  harness.key('keyup', 'J');
  assert.deepEqual(harness.calls, [['togglePlay']]);
});

check('普通键盘别名、字母大小写、F键、数字、Numpad 回归及未知键报告', () => {
  const harness = createHarness();
  const cases = [['j', 'J'], ['Space', 'Space'], ['F9', 'F9'], ['Return', 'Enter'], ['Esc', 'Escape'], ['Left', 'ArrowLeft'], ['-', 'Minus'], ['1', '1'], ['Numpad1', 'Numpad1']];
  const hotkeys = Object.fromEntries(cases.map(([accelerator], index) => ['action' + index, accelerator]));
  hotkeys.unsupported = 'Unsupported';
  assert.deepEqual(harness.apply(hotkeys), { needed: true, ok: true, keys: ['Unsupported'] });
  for (const [, key] of cases) {
    harness.key('keydown', key);
    harness.key('keyup', key);
  }
  assert.deepEqual(harness.calls, cases.map((_, index) => ['action' + index]));
});

check('规范化锁定键及 PrintScreen 名称能映射到原生键，ScrollLock 半透明绑定不丢失', () => {
  const cases = [['Scrolllock', 'ScrollLock'], ['Capslock', 'CapsLock'], ['Numlock', 'NumLock'], ['PrintScreen', 'PrintScreen']];
  for (const [accelerator, nativeKey] of cases) {
    const harness = createHarness();
    assert.deepEqual(harness.apply({ toggleOpacity: accelerator }), { needed: true, ok: true, keys: [] });
    harness.key('keydown', nativeKey);
    harness.key('keyup', nativeKey);
    assert.deepEqual(harness.calls, [['toggleOpacity']], accelerator);
    harness.calls.length = 0;
    assert.deepEqual(harness.apply({ holdSpeed: 'Ctrl+' + accelerator }), { needed: true, ok: true, keys: [] });
    harness.key('keydown', nativeKey, { ctrlKey: true });
    harness.key('keyup', nativeKey);
    assert.deepEqual(harness.calls, [['holdSpeed', 'down'], ['holdSpeed', 'up']], accelerator);
  }
});

check('无效组合和特殊对象属性名报告未知键，不抛异常', () => {
  for (const accelerator of ['Ctrl+', '+J', 'Ctrl+Ctrl+J', 'Mouse6', 'constructor', '__proto__', 'constructor+J', 'Ctrl+constructor']) {
    const harness = createHarness();
    assert.deepEqual(harness.apply({ holdSpeed: accelerator }), { needed: true, ok: true, keys: [accelerator] });
    assert.equal(harness.api.isRunning(), false);
    harness.listeners(0);
  }
});

check('普通 Mouse4/5 保持单参数动作及 modifier 容忍，改用物理按键去重', () => {
  const harness = createHarness();
  harness.apply({ togglePlay: 'Mouse4', seekFwd: 'Mouse5' });
  for (const button of [4, 5]) {
    harness.mouse('mousedown', button, { ctrlKey: true });
    harness.advance(1000);
    harness.mouse('mousedown', button);
    harness.mouse('mouseup', button);
    harness.mouse('mousedown', button);
    harness.mouse('mouseup', button);
  }
  assert.deepEqual(harness.calls, [['togglePlay'], ['togglePlay'], ['seekFwd'], ['seekFwd']]);
});

check('同一主键的普通单键和 hold 组合可以同时映射', () => {
  const harness = createHarness();
  harness.apply({ togglePlay: 'J', holdSpeed: 'Ctrl+J' });
  harness.key('keydown', 'J');
  harness.key('keyup', 'J');
  harness.key('keydown', 'J', { ctrlKey: true });
  harness.key('keyup', 'Ctrl');
  harness.key('keyup', 'J');
  assert.deepEqual(harness.calls, [['togglePlay'], ['holdSpeed', 'down'], ['holdSpeed', 'up']]);
});

check('原生模块不可用准确返回失败，不误报键位不支持；普通组合及空映射仍成功', () => {
  const harness = createHarness({ unavailable: true });
  assert.deepEqual(harness.apply({ holdSpeed: 'Ctrl+J', togglePlay: 'K', seekFwd: 'Mouse4' }), { needed: true, ok: false, keys: [] });
  assert.deepEqual(harness.apply({ cycleSpeed: 'Alt+S' }), { needed: true, ok: false, keys: [] });
  assert.equal(harness.api.isRunning(), false);
  assert.equal(harness.api.rearm(), false);
  assert.deepEqual(harness.apply({ togglePlay: 'Alt+Space' }), { needed: false, ok: true, keys: [] });
  assert.deepEqual(harness.apply({}), { needed: false, ok: true, keys: [] });
  harness.listeners(0);
});

check('不完整原生接口或缺失键码表不会冒充启动成功', () => {
  for (const nativeModule of [
    { uIOhook: { start() {}, stop() {}, on() {} }, UiohookKey: keycodes },
    { uIOhook: { start() {}, stop() {}, on() {}, off() {} } }
  ]) {
    const harness = createHarness({ nativeModule });
    assert.deepEqual(harness.apply({ holdSpeed: 'Mouse4' }), { needed: true, ok: false, keys: [] });
    assert.equal(harness.api.isRunning(), false);
  }
});

for (const [label, options] of [['抛错', { startError: true }], ['返回 false', { startFalse: true }], ['监听注册失败', { onError: 'keyup' }]]) {
  check(`start ${label} 被捕获并清监听，恢复后可再次 apply`, () => {
    const harness = createHarness(options);
    assert.deepEqual(harness.apply({ holdSpeed: 'J' }), { needed: true, ok: false, keys: [] });
    assert.equal(harness.api.isRunning(), false);
    harness.listeners(0);
    harness.state.startError = false;
    harness.state.startFalse = false;
    harness.state.onError = false;
    assert.equal(harness.apply({ holdSpeed: 'J' }).ok, true);
    harness.listeners(1);
    harness.key('keydown', 'J');
    harness.key('keyup', 'J');
    assert.deepEqual(harness.calls, [['holdSpeed', 'down'], ['holdSpeed', 'up']]);
  });
}

check('触发回调和原生 stop 抛错仍清理 hold、pressed 和运行状态', () => {
  const harness = createHarness({ stopError: true });
  const attempts = [];
  harness.apply({ holdSpeed: 'J' }, (...args) => {
    attempts.push(args);
    throw new Error('trigger failure');
  });
  harness.key('keydown', 'J');
  harness.stop();
  assert.deepEqual(attempts, [['holdSpeed', 'down'], ['holdSpeed', 'up']]);
  assert.equal(harness.api.cancelHeld(), false);
  assert.equal(harness.api.isRunning(), false);
  harness.listeners(0);
  assert.equal(harness.warnings.length, 3);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
