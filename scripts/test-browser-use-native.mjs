// Real Chrome/Edge extensions, isolated headless profiles, local fixture pages only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { ChromeConnectorBroker } from '../dist-electron/chromeConnectorBroker.js';
import { createCardbushChromeServer } from '../packages/cardbush-chrome-mcp/dist/index.js';
import { requestChromeConnector } from '../packages/cardbush-chrome-mcp/dist/bridgeClient.js';

if (process.platform !== 'win32') throw new Error('This regression targets Windows 11.');
const workspaceTmp = path.resolve('tmp');
await fs.mkdir(workspaceTmp, { recursive: true });
const root = await fs.mkdtemp(path.join(workspaceTmp, 'browser-use-native-'));
const report = { startedAt: new Date().toISOString(), success: false, browsers: [], checks: [] };
const children = [];
const broker = new ChromeConnectorBroker(root, { nativeHostPath: path.resolve('dist-native/chrome-connector-validation/CardBushBrowserHost.exe') });
const pageServer = http.createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end('<!doctype html><title>Browser Use fixture</title><h1>Isolated browser validation</h1><label>Name <input id="name"></label><button onclick="document.querySelector(\'#proof\').textContent=document.querySelector(\'#name\').value">Apply</button><p id="proof">Ready</p>');
});
async function until(fn, description, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await delay(80); }
  throw new Error('Timed out: ' + description);
}
async function startBrowser(browser, executable) {
  await fs.access(executable);
  const child = spawn(executable, [`--user-data-dir=${path.join(root, browser)}`, '--headless=new', '--no-first-run',
    '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', 'about:blank'],
  { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let sequence = 0, buffer = '';
  const item = { child, send: null, closed: false }; children.push(item);
  child.stderr.resume();
  const fail = error => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); } pending.clear(); };
  child.on('error', fail); child.on('exit', code => { item.closed = true; fail(new Error(`${browser} exited (${code})`)); });
  child.stdio[3].on('error', fail); child.stdio[4].on('error', fail);
  child.stdio[4].on('data', data => {
    buffer += data.toString(); let boundary;
    while ((boundary = buffer.indexOf('\0')) >= 0) {
      const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1); if (!line) continue;
      const value = JSON.parse(line), request = pending.get(value.id); if (!request) continue;
      pending.delete(value.id); clearTimeout(request.timer);
      value.error ? request.reject(new Error(value.error.message)) : request.resolve(value.result);
    }
  });
  const send = item.send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${browser}: ${method} timed out`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    child.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
  const version = await send('Browser.getVersion');
  const extension = await send('Extensions.loadUnpacked', { path: path.resolve('assets/plugins/chrome/extension') });
  assert.equal(extension.id, 'iibaamkfgackofhhpadgnmgcjkhckeln');
  const target = await send('Target.createTarget', { url: `chrome-extension://${extension.id}/popup.html` });
  const { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  await until(() => evaluate('Boolean(document.querySelector("#pairing-code"))'), 'extension popup');
  const pairing = broker.createPairing({ browser, label: `${browser} native test` });
  const result = await evaluate(`chrome.runtime.sendMessage(${JSON.stringify({ action: 'pair', code: pairing.code })})`);
  assert.equal(result.ok, true, JSON.stringify(result));
  await until(() => broker.status().connections.some(connection => connection.id === pairing.id && connection.connected), `${browser} pairing`);
  report.browsers.push({ browser, version: version.product, userAgent: version.userAgent, extension: '1.2.0' });
  return { id: pairing.id, item, evaluate };
}

try {
  await broker.start();
  await new Promise(resolve => pageServer.listen(0, '127.0.0.1', resolve));
  const chrome = await startBrowser('chrome', process.env.CARDBUSH_TEST_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  const edge = await startBrowser('edge', process.env.CARDBUSH_TEST_EDGE ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
  assert.equal(broker.status().connections.filter(connection => connection.connected).length, 2);
  report.checks.push('Chrome and Edge paired simultaneously with the same signed extension identity');
  const mcp = createCardbushChromeServer({ artifactsDirectory: path.join(root, 'artifacts'),
    connector: (method, params, options) => requestChromeConnector(method, params, { ...options, configPath: broker.configPath }) });
  async function call(scope, name, input = {}) {
    const result = await mcp._registeredTools[name].handler(input, {
      mcpReq: { signal: new AbortController().signal, _meta: { cardbush_session_id: scope, cardbush_session_title: scope } },
    });
    assert.notEqual(result.isError, true, `${name}: ${result.content?.[0]?.text}`); return result;
  }
  for (const [name, connection] of [['chrome', chrome], ['edge', edge]]) {
    await call(name, 'select_browser', { connectionId: connection.id });
    await call(name, 'new_page', { url: `http://127.0.0.1:${pageServer.address().port}/${name}` });
    await call(name, 'wait_for', { text: 'Isolated browser validation', timeout: 5000 });
    const snapshot = await call(name, 'take_snapshot');
    const text = snapshot.content[0].text;
    const input = text.split('\n').find(line => /textbox/.test(line))?.match(/uid=([^\s]+)/)?.[1];
    assert.ok(input, 'Accessibility snapshot exposes the input');
    await call(name, 'fill', { uid: input, value: name });
    const second = await call(name, 'take_snapshot');
    const button = second.content[0].text.split('\n').find(line => /button.*Apply/.test(line))?.match(/uid=([^\s]+)/)?.[1];
    assert.ok(button, 'Accessibility snapshot exposes Apply');
    await call(name, 'click', { uid: button });
    const proof = await call(name, 'evaluate_script', { expression: 'document.querySelector("#proof").textContent' });
    assert.ok(JSON.stringify(proof.structuredContent).includes(name));
    const screenshot = await call(name, 'take_screenshot', { format: 'png' });
    assert.ok(screenshot.content.some(content => content.type === 'image'));
    assert.ok(screenshot.structuredContent.width > 100);
    const other = await call(name, 'list_pages');
    assert.equal(other.structuredContent.pages.length, 1);
    assert.ok(other.structuredContent.pages[0].url.endsWith('/' + name));
    report.checks.push(`${name}: select, create, accessibility snapshot, fill, click, evaluate, screenshot, isolated page listing`);
  }
  broker.setDefaultConnection(edge.id);
  assert.equal((await call('chrome', 'list_browsers')).structuredContent.selectedConnectionId, chrome.id);
  await call('chrome', 'select_browser', { connectionId: edge.id });
  assert.equal((await call('chrome', 'list_pages')).structuredContent.pages.length, 0, 'other session tabs remain hidden after switching');
  await call('edge', 'release_browser');
  await call('chrome', 'release_browser');
  report.checks.push('default changes preserve bindings; explicit switch releases Chrome and preserves Edge session isolation');
  broker.revokeConnection(chrome.id);
  await until(async () => !(await chrome.evaluate('chrome.runtime.sendMessage({action:"status"})')).connectorEnabled, 'revoked extension stays disabled');
  assert.equal(broker.status().connections.find(connection => connection.id === edge.id)?.connected, true);
  await broker.disableExtension();
  await until(() => broker.status().connections.every(connection => !connection.connected), 'disable all browsers');
  report.checks.push('individual revocation and global disable');
  report.success = true;
} catch (error) { report.error = error.stack; process.exitCode = 1; }
finally {
  for (const item of children) {
    if (item.closed) continue;
    await item.send?.('Browser.close').catch(() => {});
    await until(() => item.closed, 'test browser exit', 5000).catch(() => item.child.kill());
  }
  broker.stop(); pageServer.close();
  await fs.writeFile(path.join(workspaceTmp, 'browser-use-native-result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  const resolved = path.resolve(root);
  if (!resolved.startsWith(workspaceTmp + path.sep) || !path.basename(resolved).startsWith('browser-use-native-')) throw new Error('Unsafe test cleanup path.');
  if (children.every(item => item.closed)) await fs.rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}
