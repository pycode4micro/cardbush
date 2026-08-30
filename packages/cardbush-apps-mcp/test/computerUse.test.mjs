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

test('creates an independent MCP server with an explicit computer-use manifest', () => {
  const server = createCardbushAppsServer();
  assert.ok(server);
  assert.equal(computerUseManifest.owner, 'cardbush_apps');
  assert.equal(computerUseManifest.dispatch_source, 'mcp_tool');
  assert.equal(computerUseManifest.operation, 'desktop.control');
  assert.deepEqual(Object.keys(server._registeredTools), ['computer_use']);
});

test('does not register an uninstalled or disabled plugin', () => {
  const disabled = defaultAppsRuntimeConfig();
  disabled.computerUse.enabled = false;
  assert.deepEqual(Object.keys(createCardbushAppsServer(disabled)._registeredTools), []);
  const uninstalled = defaultAppsRuntimeConfig();
  uninstalled.computerUse.installed = false;
  assert.deepEqual(Object.keys(createCardbushAppsServer(uninstalled)._registeredTools), []);
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
