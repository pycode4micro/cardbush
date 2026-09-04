import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { createCardbushChromeServer } from '../dist/index.js';

test('keeps the established Chrome DevTools tool vocabulary', () => {
  const tools = Object.keys(createCardbushChromeServer()._registeredTools);
  assert.deepEqual(tools, [
    'list_pages',
    'select_page',
    'new_page',
    'close_page',
    'navigate_page',
    'take_snapshot',
    'click',
    'fill',
    'type_text',
    'press_key',
    'hover',
    'take_screenshot',
    'evaluate_script',
    'wait_for',
    'release_browser',
  ]);
  assert.equal(createCardbushChromeServer()._registeredTools.list_pages.annotations.readOnlyHint, true);
  assert.equal(createCardbushChromeServer()._registeredTools.close_page.annotations.destructiveHint, true);
});

test('ships a stable MV3 extension using debugger and native messaging', async () => {
  const extensionPath = path.resolve(import.meta.dirname, '../../../assets/plugins/chrome/extension');
  const manifestPath = path.join(extensionPath, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.minimum_chrome_version, '102');
  assert.deepEqual(manifest.background, { service_worker: 'background.js' });
  assert.ok(manifest.permissions.includes('debugger'));
  assert.ok(manifest.permissions.includes('nativeMessaging'));
  assert.ok(manifest.permissions.includes('tabGroups'));
  assert.ok(!manifest.permissions.includes('activeTab'));
  assert.ok(manifest.key);
  assert.deepEqual(manifest.icons, {
    16: 'icons/cardbush-16.png',
    32: 'icons/cardbush-32.png',
    48: 'icons/cardbush-48.png',
    128: 'icons/cardbush-128.png',
  });
  assert.deepEqual(manifest.action.default_icon, manifest.icons);

  for (const [size, iconPath] of Object.entries(manifest.icons)) {
    const icon = await readFile(path.join(extensionPath, iconPath));
    assert.deepEqual(icon.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.equal(icon.readUInt32BE(16), Number(size));
    assert.equal(icon.readUInt32BE(20), Number(size));
  }
});
