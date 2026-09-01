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
import { computerUseManifest } from '../dist/plugins/computerUse.js';
import {
  executeComputerUse,
  selectWindowTarget,
} from '../dist/plugins/computerUseRuntime.js';

test('creates an independent MCP server with an explicit computer-use manifest', () => {
  const server = createCardbushAppsServer();
  assert.ok(server);
  assert.equal(computerUseManifest.owner, 'cardbush_apps');
  assert.equal(computerUseManifest.dispatch_source, 'mcp_tool');
  assert.equal(computerUseManifest.operation, 'desktop.control');
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
  assert.equal(schema.safeParse({ action: 'click', x: 0, y: 0 }).success, true);
  assert.equal(schema.safeParse({ action: 'type', text: '中文 + ^ % { }' }).success, true);
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
