import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import path from 'node:path';
import test from 'node:test';

import { createCardbushChromeServer } from '../dist/index.js';
import { ChromeConnectorError } from '../dist/bridgeClient.js';

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
    'resize_page',
    'take_screenshot',
    'export_image',
    'evaluate_script',
    'download_file',
    'download_status',
    'cancel_download',
    'wait_for',
    'release_browser',
  ]);
  assert.equal(createCardbushChromeServer()._registeredTools.list_pages.annotations.readOnlyHint, true);
  assert.equal(createCardbushChromeServer()._registeredTools.close_page.annotations.destructiveHint, true);
});

test('screenshot failure feedback is scoped, preserves native images, and resets after recovery', async t => {
  const artifactsDirectory = await mkdtemp(path.join(tmpdir(), 'cardbush-capture-test-'));
  t.after(() => rm(artifactsDirectory, { recursive: true, force: true }));
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: 'white' } }).png().toBuffer();
  let succeeds = false;
  let submitted = 0;
  const connector = async (method, params, options) => {
    if (method === 'tabs.list') return [{ id: 42, active: true, title: 'test' }];
    if (method === 'debugger.detachScope') return { detached: true };
    if (params.command === 'Runtime.evaluate') return { result: { value: { width: 1280, height: 800, deviceScaleFactor: 1 } } };
    assert.equal(params.command, 'Page.captureScreenshot');
    submitted++;
    const diagnostics = { requestId: 'sample', method, command: params.command, tabId: 42,
      elapsedMs: 25_000, stage: 'command_pending', stages: [{ stage: 'command_pending', elapsedMs: 1 }] };
    options.onDiagnostics?.(diagnostics);
    if (!succeeds) throw new ChromeConnectorError('screenshot_timeout', 'capture timed out', { diagnostics });
    return { data: png.toString('base64') };
  };
  const server = createCardbushChromeServer({ connector, artifactsDirectory });
  const context = id => ({ mcpReq: { signal: new AbortController().signal, _meta: { cardbush_session_id: id } } });
  const capture = (id, format = 'png') => server._registeredTools.take_screenshot.handler({ format }, context(id));
  const first = await capture('a');
  assert.equal(first.isError, true);
  assert.equal(first.structuredContent.error.details.consecutiveFailures, 1);
  assert.equal(first.structuredContent.error.details.recovery, undefined);
  const repeated = await capture('a', 'jpeg');
  assert.equal(repeated.structuredContent.error.details.consecutiveFailures, 2);
  assert.equal(repeated.structuredContent.error.details.timings.connector.stage, 'command_pending');
  assert.match(repeated.structuredContent.error.details.recovery, /different preview route/);
  assert.equal((await capture('a:child')).structuredContent.error.details.consecutiveFailures, 1);
  succeeds = true;
  const successful = await capture('a');
  assert.equal(successful.content[1].data, png.toString('base64'));
  assert.equal(successful.structuredContent.bytes, png.length);
  assert.ok(successful.structuredContent.timings.elapsedMs >= 0);
  succeeds = false;
  assert.equal((await capture('a')).structuredContent.error.details.consecutiveFailures, 1);
  assert.equal((await capture('a:child')).structuredContent.error.details.consecutiveFailures, 2);
  await server._registeredTools.release_browser.handler({}, context('a'));
  assert.equal((await capture('a')).structuredContent.error.details.consecutiveFailures, 1);
  assert.equal(submitted, 7, 'feedback never silently retries or hard-blocks tool calls');
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
