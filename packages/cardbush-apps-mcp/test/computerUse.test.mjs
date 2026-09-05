import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import {
  createCardbushAppsServer,
  defaultAppsRuntimeConfig,
  readAppsRuntimeConfig,
} from '../dist/index.js';
import {
  ComputerUseSafetyGuard,
  executeComputerUse,
  selectWindowTarget,
} from '../dist/plugins/computerUseRuntime.js';

test('creates an independent MCP server with standard MCP annotations', () => {
  const server = createCardbushAppsServer();
  assert.ok(server);
  assert.deepEqual(Object.keys(server._registeredTools), ['computer_use']);
  const tool = server._registeredTools.computer_use;
  assert.match(tool.description, /Observe and interact with the user's current desktop/);
  assert.doesNotMatch(tool.description, /last-resort|prefer|primary route|fallback/i);
  assert.equal(tool.annotations.title, 'Computer Use');
  assert.equal(tool.annotations.destructiveHint, true);
});

test('rejects incomplete input actions before desktop execution', () => {
  const tool = createCardbushAppsServer()._registeredTools.computer_use;
  const schema = tool.inputSchema;
  assert.equal(schema.safeParse({ action: 'click' }).success, false);
  assert.equal(schema.safeParse({ action: 'drag', x: 1, y: 2 }).success, false);
  assert.equal(schema.safeParse({ action: 'type' }).success, false);
  assert.equal(schema.safeParse({ action: 'key' }).success, false);
  assert.equal(schema.safeParse({ action: 'scroll' }).success, false);
  assert.equal(schema.safeParse({ action: 'window', app: 'chrome', operation: 'move' }).success, false);
  assert.equal(schema.safeParse({ action: 'click', x: 0, y: 0 }).success, false);
  assert.equal(schema.safeParse({
    action: 'click',
    x: 0,
    y: 0,
    hwnd: 100,
    state_id: 'desktop_state_1',
  }).success, true);
  assert.equal(schema.safeParse({
    action: 'click',
    element_index: 3,
    x: 10,
    y: 20,
    hwnd: 100,
    state_id: 'desktop_state_1',
  }).success, false);
  assert.equal(schema.safeParse({
    action: 'click',
    element_index: 3,
    hwnd: 100,
    state_id: 'desktop_state_1',
  }).success, true);
  assert.equal(schema.safeParse({
    action: 'click',
    element_index: 3,
    button: 'right',
    hwnd: 100,
    state_id: 'desktop_state_1',
  }).success, false);
  assert.equal(schema.safeParse({
    action: 'scroll',
    x: 10,
    y: 20,
    delta: -3,
    hwnd: 100,
    state_id: 'desktop_state_1',
  }).success, true);
  assert.equal(schema.safeParse({
    action: 'set_value',
    element_index: 3,
    value: '',
    hwnd: 100,
    state_id: 'desktop_state_1',
  }).success, true);
  assert.equal(schema.safeParse({
    action: 'type',
    text: '中文 + ^ % { }',
    hwnd: 100,
    state_id: 'desktop_state_1',
  }).success, true);
  assert.equal(schema.safeParse({
    action: 'type',
    text: 'x'.repeat(8193),
    hwnd: 100,
    state_id: 'desktop_state_1',
  }).success, false);
  assert.equal(schema.safeParse({
    action: 'key',
    keys: Array.from({ length: 9 }, () => 'ctrl'),
    hwnd: 100,
    state_id: 'desktop_state_1',
  }).success, false);
  assert.equal(schema.safeParse({ action: 'observe', hwnd: 100 }).success, true);
});

test('does not register an uninstalled or disabled plugin', () => {
  const disabled = defaultAppsRuntimeConfig();
  disabled.computerUse.enabled = false;
  assert.deepEqual(Object.keys(createCardbushAppsServer(disabled)._registeredTools), []);
  const uninstalled = defaultAppsRuntimeConfig();
  uninstalled.computerUse.installed = false;
  assert.deepEqual(Object.keys(createCardbushAppsServer(uninstalled)._registeredTools), []);
});

test('honors Runtime cancellation before issuing desktop input', async () => {
  const controller = new AbortController();
  controller.abort(new DOMException('Turn stopped', 'AbortError'));
  await assert.rejects(
    executeComputerUse(
      { action: 'click', x: 10, y: 10 },
      defaultAppsRuntimeConfig().computerUse.config,
      controller.signal,
    ),
    (error) => error?.name === 'AbortError',
  );
});

test('preserves Unicode in generic application resolution failures', {
  skip: process.platform !== 'win32',
}, async () => {
  const config = defaultAppsRuntimeConfig().computerUse.config;
  await assert.rejects(
    executeComputerUse({
      action: 'open_app',
      app: 'CardBush-不存在的应用-测试',
    }, config),
    (error) => {
      assert.match(error.message, /CardBush-不存在的应用-测试/);
      assert.doesNotMatch(error.message, /�/);
      return true;
    },
  );
});

test('reads the Product Host lifecycle and Computer Use policy snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-apps-runtime-'));
  try {
    const path = join(root, 'apps.json');
    await writeFile(path, JSON.stringify({
      protocol: 'cardbush.apps_config.v1',
      revision: 4,
      serviceEnabled: false,
      plugins: [{
        id: 'computer-use',
        installed: false,
        enabled: false,
        config: {
          screenshotDirectory: root,
          allowOpenApp: false,
          allowWindowClose: false,
        },
      }],
    }));
    const config = readAppsRuntimeConfig(path);
    assert.equal(config.serviceEnabled, false);
    assert.equal(config.computerUse.installed, false);
    assert.equal(config.computerUse.config.allowOpenApp, false);
    assert.equal(config.computerUse.config.yieldToUser, true);
    assert.equal(config.computerUse.config.restorePointer, true);
    assert.ok(createCardbushAppsServer(config));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('selects a window by application process name', () => {
  const windows = [
    { process_id: 10, hwnd: 100, title: 'CardBush', process_name: 'cardbush' },
    { process_id: 20, hwnd: 200, title: '抖店 - Google Chrome', process_name: 'chrome' },
  ];
  assert.deepEqual(
    selectWindowTarget(windows, { app: 'chrome' }),
    windows[1],
  );
  assert.deepEqual(
    selectWindowTarget(windows, { app: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' }),
    windows[1],
  );
  assert.deepEqual(
    selectWindowTarget(windows, { app: 'Google Chrome' }),
    windows[1],
  );
});

test('combines app and title selectors and reports actionable ambiguity', () => {
  const windows = [
    { process_id: 20, hwnd: 200, title: '抖店 - Google Chrome', process_name: 'chrome' },
    { process_id: 21, hwnd: 201, title: '文档 - Google Chrome', process_name: 'chrome.exe' },
  ];
  assert.deepEqual(
    selectWindowTarget(windows, { app: 'chrome', title_pattern: '抖店' }),
    windows[0],
  );
  assert.throws(
    () => selectWindowTarget(windows, { app: 'chrome' }),
    /matched 2 windows:.*hwnd=200.*hwnd=201.*Retry with hwnd/,
  );
  assert.deepEqual(
    selectWindowTarget(windows, { hwnd: 201 }),
    windows[1],
  );
});

test('rejects missing and unmatched window selectors with recovery guidance', () => {
  assert.throws(
    () => selectWindowTarget([], {}),
    /requires app, title_pattern, or hwnd/,
  );
  assert.throws(
    () => selectWindowTarget([], { app: 'chrome' }),
    /Window was not found for app="chrome".*action="observe"/,
  );
});

test('stops unchanged repeated-action loops per turn scope', () => {
  const guard = new ComputerUseSafetyGuard();
  const scope = 'session-1:turn-1';
  const click = { action: 'click', x: 100, y: 120 };
  const observe = (brightness) => {
    const release = guard.begin(scope, { action: 'observe' });
    guard.recordObservation(scope, Buffer.alloc(256, brightness).toString('base64'));
    release();
  };
  const act = () => {
    const release = guard.begin(scope, click);
    guard.recordAction(scope, click);
    release();
  };

  observe(20);
  act();
  observe(21);
  act();
  observe(20);
  assert.throws(() => guard.begin(scope, click), /repeated action loop/);

  observe(90);
  assert.doesNotThrow(() => guard.begin(scope, click)());
});

test('requires observation after bounded action chains and user activity', () => {
  const guard = new ComputerUseSafetyGuard();
  const scope = 'session-2:turn-4';
  for (const key of ['a', 'b', 'c']) {
    const input = { action: 'key', key };
    const release = guard.begin(scope, input);
    guard.recordAction(scope, input);
    release();
  }
  assert.throws(
    () => guard.begin(scope, { action: 'key', key: 'd' }),
    /without observation/,
  );

  const observeRelease = guard.begin(scope, { action: 'observe' });
  guard.recordObservation(scope, Buffer.alloc(256, 30).toString('base64'));
  observeRelease();
  guard.recordUserYield(scope);
  assert.throws(
    () => guard.begin(scope, { action: 'click', x: 1, y: 1 }),
    /yielded to user input/,
  );
});

test('stops alternating actions when observations show no progress', () => {
  const guard = new ComputerUseSafetyGuard();
  const scope = 'session-3:turn-8';
  const visual = Buffer.alloc(256, 44).toString('base64');
  const observe = () => {
    const release = guard.begin(scope, { action: 'observe' });
    guard.recordObservation(scope, visual);
    release();
  };
  const act = (input) => {
    const release = guard.begin(scope, input);
    guard.recordAction(scope, input);
    release();
  };

  observe();
  act({ action: 'click', x: 10, y: 10 });
  observe();
  act({ action: 'scroll', delta: -2 });
  observe();
  assert.throws(
    () => guard.begin(scope, { action: 'key', key: 'enter' }),
    /without visible progress/,
  );
});

test('counts failed attempts so identical errors cannot retry forever', () => {
  const guard = new ComputerUseSafetyGuard();
  const scope = 'session-4:turn-9';
  const input = { action: 'click', x: 70, y: 80, hwnd: 999 };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const release = guard.begin(scope, input);
    guard.recordAction(scope, input, false);
    release();
  }
  assert.throws(() => guard.begin(scope, input), /repeated action loop/);
});

test('ends repeated user-yield and passive-observation loops', () => {
  const guard = new ComputerUseSafetyGuard();
  const scope = 'session-5:turn-10';
  const visual = Buffer.alloc(256, 60).toString('base64');
  const observe = () => {
    const release = guard.begin(scope, { action: 'observe' });
    guard.recordObservation(scope, visual);
    release();
  };

  observe();
  guard.recordUserYield(scope);
  observe();
  guard.recordUserYield(scope);
  observe();
  assert.throws(
    () => guard.begin(scope, { action: 'key', key: 'enter' }),
    /ended desktop control for this turn/,
  );
  assert.throws(
    () => guard.begin(scope, { action: 'observe' }),
    /repeated observation loop/,
  );
});

test('serializes physical desktop access across turn scopes', () => {
  const guard = new ComputerUseSafetyGuard();
  const release = guard.begin('scope-a', { action: 'observe' });
  assert.throws(
    () => guard.begin('scope-a', { action: 'observe' }),
    /already using the desktop/,
  );
  assert.throws(
    () => guard.begin('scope-b', { action: 'observe' }),
    /already using the desktop/,
  );
  release();
  assert.doesNotThrow(() => guard.begin('scope-b', { action: 'observe' })());
});

test('binds each target observation to one exact window and one action', () => {
  const guard = new ComputerUseSafetyGuard();
  const scope = 'session-state:turn-state';
  const binding = {
    hwnd: 901,
    processId: 44,
    processName: 'notepad',
    title: 'notes.txt - Notepad',
    bounds: { x: 10, y: 20, width: 800, height: 600 },
    elements: [],
  };
  guard.recordObservation(scope, Buffer.alloc(256, 30).toString('base64'));
  const stateId = guard.bindObservation(scope, binding);
  assert.match(stateId, /^desktop_state_/);
  const claimed = guard.claimObservation(scope, { state_id: stateId, hwnd: 901 });
  assert.deepEqual(
    { ...claimed, createdAt: 0 },
    { ...binding, stateId, generation: 0, createdAt: 0 },
  );
  assert.throws(
    () => guard.claimObservation(scope, { state_id: stateId, hwnd: 901 }),
    /fresh target-specific observe/,
  );
});

test('invalidates observed state after another session changes the desktop', () => {
  const guard = new ComputerUseSafetyGuard();
  const scopeA = 'session-a:turn-a';
  const scopeB = 'session-b:turn-b';
  guard.recordObservation(scopeA, Buffer.alloc(256, 30).toString('base64'));
  const stateId = guard.bindObservation(scopeA, {
    hwnd: 901,
    processName: 'notepad',
    title: 'notes.txt - Notepad',
    bounds: { x: 10, y: 20, width: 800, height: 600 },
    elements: [],
  });
  guard.recordAction(scopeB, { action: 'open_app', app: 'calc' });
  assert.throws(
    () => guard.claimObservation(scopeA, { state_id: stateId, hwnd: 901 }),
    /possibly in another session/,
  );
});

test('rejects a state token paired with another window', () => {
  const guard = new ComputerUseSafetyGuard();
  const scope = 'session-window:turn-window';
  guard.recordObservation(scope, Buffer.alloc(256, 30).toString('base64'));
  const stateId = guard.bindObservation(scope, {
    hwnd: 901,
    processName: 'notepad',
    title: 'notes.txt - Notepad',
    bounds: { x: 10, y: 20, width: 800, height: 600 },
    elements: [],
  });
  assert.throws(
    () => guard.claimObservation(scope, { state_id: stateId, hwnd: 902 }),
    /targets hwnd=901/,
  );
});

test('does not let one-use state ids hide repeated actions', () => {
  const guard = new ComputerUseSafetyGuard();
  const scope = 'session-repeat:turn-repeat';
  const visual = Buffer.alloc(256, 42).toString('base64');
  const binding = {
    hwnd: 901,
    processName: 'notepad',
    title: 'notes.txt - Notepad',
    bounds: { x: 10, y: 20, width: 800, height: 600 },
    elements: [],
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    guard.recordObservation(scope, visual);
    const stateId = guard.bindObservation(scope, binding);
    const input = { action: 'click', x: 20, y: 30, hwnd: 901, state_id: stateId };
    const release = guard.begin(scope, input);
    guard.claimObservation(scope, input);
    guard.recordAction(scope, input);
    release();
  }
  guard.recordObservation(scope, visual);
  const stateId = guard.bindObservation(scope, binding);
  assert.throws(
    () => guard.begin(scope, { action: 'click', x: 20, y: 30, hwnd: 901, state_id: stateId }),
    /repeated action loop/,
  );
});

test('treats semantic accessibility changes as visible progress', () => {
  const guard = new ComputerUseSafetyGuard();
  const scope = 'session-semantic:turn-semantic';
  const visual = Buffer.alloc(256, 42).toString('base64');
  const click = { action: 'click', element_index: 2, hwnd: 901 };

  guard.recordObservation(scope, visual, 'semantic-before');
  let release = guard.begin(scope, click);
  guard.recordAction(scope, click);
  release();
  guard.recordObservation(scope, visual, 'semantic-after');

  release = guard.begin(scope, click);
  release();
});

test('explicit finish invalidates a target observation without recording user activity', () => {
  const guard = new ComputerUseSafetyGuard();
  const scope = 'finished-session:turn';
  const stateId = guard.bindObservation(scope, {
    hwnd: 901, processName: 'fixture', title: 'fixture',
    bounds: { x: 0, y: 0, width: 800, height: 600 }, elements: [],
  });
  guard.releaseObservation(scope);
  assert.throws(() => guard.claimObservation(scope, { state_id: stateId, hwnd: 901 }), /fresh target-specific observe/);
  const release = guard.begin(scope, { action: 'observe', hwnd: 901 });
  release();
});

test('expires unused target observations after the short action window', () => {
  const originalNow = Date.now;
  let now = 10_000;
  Date.now = () => now;
  try {
    const guard = new ComputerUseSafetyGuard();
    const scope = 'session-expiry:turn-expiry';
    guard.recordObservation(scope, Buffer.alloc(256, 30).toString('base64'));
    const stateId = guard.bindObservation(scope, {
      hwnd: 901,
      processName: 'notepad',
      title: 'notes.txt - Notepad',
      bounds: { x: 10, y: 20, width: 800, height: 600 },
      elements: [],
    });
    now += 30_001;
    assert.throws(
      () => guard.claimObservation(scope, { state_id: stateId, hwnd: 901 }),
      /expired before it was used/,
    );
  } finally {
    Date.now = originalNow;
  }
});
