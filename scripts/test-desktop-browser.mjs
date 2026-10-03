import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolRegistry } from '../packages/bush-runtime/dist/index.js';
import { registerDesktopBrowserTools } from '../dist-electron/desktopBrowserTools.mjs';
import { McpDesktopHost, checkedMcpUrl } from '../dist-electron/mcpDesktopHost.js';
import { McpHostBridge, handleMcpHostRequest } from '../dist-electron/mcpHostBridge.js';
import { checkedExternalWebUrl } from '../dist-electron/externalWebUrl.js';

function fixture(openUrl) {
  const desktop = new McpDesktopHost({ path: 'unused', openUrl, changed() {},
    encrypt() { throw Error('must not use credentials'); }, decrypt() { throw Error('must not use credentials'); } });
  const bridge = new McpHostBridge(message => {
    if (message.type === 'request') void handleMcpHostRequest(message, new AbortController().signal,
      (operation, payload, signal) => desktop.handle(operation, payload, signal)).then(reply => bridge.receive(reply));
  });
  const registry = new ToolRegistry();
  registerDesktopBrowserTools(registry, bridge);
  const tool = registry.resolve('open_external_url');
  return { desktop, registry, tool, call: (input, signal) => tool.execute({ input: tool.decodeInput(input), signal }) };
}

test('desktop browser tool uses private host navigation and reports dispatch without claiming page load', async () => {
  const opened = [];
  const { call, registry, tool } = fixture(async url => opened.push(url));
  assert.equal(registry.definitions().some(tool => tool.name === 'open_external_url'), true);
  assert.equal(tool.manifest.mutating, true);
  assert.equal(tool.parallelSafe, false);
  const result = await call({ url: 'https://example.com/live?room=123#player' });
  assert.deepEqual(opened, ['https://example.com/live?room=123#player']);
  assert.deepEqual(result, { status: 'dispatched', url: opened[0], browser: 'system_default', pageLoadVerified: false });
});

test('both boundaries reject non-web URLs, credentials, control characters and command-shaped input', async () => {
  let opened = 0;
  const { call, desktop } = fixture(async () => { opened++; });
  for (const url of ['', null, 123, 'https://', '//example.com', 'file:///C:/Windows/notepad.exe',
    'javascript:alert(1)', 'data:text/html,test', 'mailto:test@example.com', 'ms-settings:',
    'https://user:password@example.com', 'http://user@example.com', 'https://example.com/\nnext',
    'https://example.com/\0next', "https://example.com/'; Start-Process calc", 'https://example.com/' + 'a'.repeat(8192)]) {
    assert.throws(() => call({ url }));
    await assert.rejects(desktop.handle('browser.open-external', { url }, new AbortController().signal));
  }
  assert.throws(() => call({ url: 'https://example.com', executable: 'calc.exe' }));
  assert.equal(opened, 0);
  assert.equal(checkedExternalWebUrl(' https://example.com/测试 '), 'https://example.com/%E6%B5%8B%E8%AF%95');
  assert.equal(checkedExternalWebUrl('http://example.com'), 'http://example.com/');
  assert.equal(checkedExternalWebUrl('http://127.0.0.1:1234/test'), 'http://127.0.0.1:1234/test');
  assert.throws(() => checkedMcpUrl('http://example.com'), /HTTPS/, 'web navigation must not weaken the OAuth URL policy');
});

test('cancellation before dispatch never opens a browser at either boundary', async () => {
  let opened = 0;
  const { call, desktop } = fixture(async () => { opened++; });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(call({ url: 'https://example.com' }, controller.signal), { name: 'AbortError' });
  await assert.rejects(desktop.handle('browser.open-external', { url: 'https://example.com' }, controller.signal), { name: 'AbortError' });
  assert.equal(opened, 0);
});

test('OS launch failures propagate without success receipts or automatic retry', async () => {
  let attempts = 0;
  const { call } = fixture(async () => { attempts++; throw Error('fixture OS launch failed'); });
  await assert.rejects(call({ url: 'https://example.com' }), /fixture OS launch failed/);
  assert.equal(attempts, 1);
});
