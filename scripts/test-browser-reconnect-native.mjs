// Real Chromium network throttling with isolated App/extension profiles only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ChromeConnectorLifecycle } from '../dist-electron/chromeConnectorLifecycle.js';

const parent = path.resolve('tmp');
await fs.mkdir(parent, { recursive: true });
const root = await fs.mkdtemp(path.join(parent, 'browser-reconnect-native-'));
const report = { success: false, checks: [] };
const browserKind = process.argv.includes('--edge') ? 'edge' : 'chrome';
const nativeHostPath = path.resolve('dist-native/chrome-connector-validation/CardBushBrowserHost.exe');
const appsConfigPath = path.join(root, 'apps.json');
const handles = [], pending = new Map();
let browser, sequence = 0, buffer = '', exited = false;
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
  pending.set(id, { resolve, reject, timer });
  browser.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
});
async function until(read, label, timeout = 45000) {
  const end = Date.now() + timeout;
  do { if (await read()) return; await delay(100); } while (Date.now() < end);
  throw new Error(`Timed out: ${label}`);
}
async function appStart(restore = false) {
  const app = new ChromeConnectorLifecycle({ userDataPath: root, nativeHostPath, shared: true, appsConfigPath }, () => {});
  handles.push(app);
  if (restore) await app.restore(); else await app.setEnabled(true);
  assert.equal(app.state, 'enabled');
  return app;
}
try {
  await fs.writeFile(appsConfigPath, JSON.stringify({ serviceEnabled: true, plugins: [{ id: 'chrome', installed: true, enabled: true }] }));
  let app = await appStart();
  const pairing = await app.broker.createPairing({ browser: browserKind, label: 'Isolated restart regression' });
  const port = Number(pairing.code.split('.')[1]);
  const extensionPath = path.join(root, 'extension');
  await fs.cp(path.resolve('assets/plugins/chrome/extension'), extensionPath, { recursive: true });
  // No discovery request from this fixture may contact a user's local broker.
  const transportPath = path.join(extensionPath, 'connector-transport.js');
  const transport = await fs.readFile(transportPath, 'utf8');
  assert.match(transport, /const CONNECTOR_DISCOVERY_PORTS = [^\r\n]+;/);
  await fs.writeFile(transportPath, transport.replace(/const CONNECTOR_DISCOVERY_PORTS = [^\r\n]+;/,
    `const CONNECTOR_DISCOVERY_PORTS = Object.freeze([${port}]);`));
  const executable = browserKind === 'edge'
    ? process.env.CARDBUSH_TEST_EDGE ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    : process.env.CARDBUSH_TEST_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  browser = spawn(executable,
    [`--user-data-dir=${path.join(root, browserKind)}`, '--headless=new', '--no-first-run', '--no-default-browser-check',
      '--disable-background-networking', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', 'about:blank'],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  browser.stderr.resume();
  browser.once('exit', () => { exited = true; });
  browser.stdio[4].on('data', chunk => {
    buffer += chunk.toString(); let end;
    while ((end = buffer.indexOf('\0')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line) continue;
      const message = JSON.parse(line), request = pending.get(message.id); if (!request) continue;
      pending.delete(message.id); clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
    }
  });
  report.browser = (await send('Browser.getVersion')).product;
  const { id } = await send('Extensions.loadUnpacked', { path: extensionPath });
  const target = await send('Target.createTarget', { url: `chrome-extension://${id}/popup.html` });
  const { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  await until(() => evaluate('Boolean(document.querySelector("#pairing-code"))'), 'extension popup');
  await evaluate(`chrome.runtime.sendMessage(${JSON.stringify({ action: 'pair', code: pairing.code })})`);
  await until(() => app.broker.status().extensionConnected, 'initial authorized connection');
  await evaluate('chrome.storage.local.set({allowedOrigins:["https://example.test"]})');
  const saved = await fs.readFile(path.join(root, 'browser-connector/pairing.json'), 'utf8');
  app.dispose();
  await until(async () => !(await evaluate('chrome.runtime.sendMessage({action:"status"})')).nativeConnected, 'GUI lifecycle exit');
  // Failed WebSockets accumulate inside Chromium, which a Node ws fixture does
  // not implement. Force the same bounded 1–5 s connection delay after an outage.
  await evaluate(`Promise.all(Array.from({length:80},()=>new Promise(resolve=>{
    const socket=new WebSocket('ws://127.0.0.1:${port}/connect');
    socket.onerror=socket.onclose=()=>resolve();
  })))`);
  console.log('Real Chromium outage established; restarting the GUI lifecycle without restarting the browser.');
  app = await appStart(true);
  const start = Date.now();
  await until(() => app.broker.status().extensionConnected, 'automatic saved connection after GUI restart');
  report.recoveryMs = Date.now() - start;
  const current = JSON.parse(await fs.readFile(path.join(root, 'browser-connector/pairing.json'), 'utf8'));
  assert.deepEqual(current.credentials, JSON.parse(saved).credentials);
  assert.deepEqual(await evaluate('chrome.storage.local.get("allowedOrigins").then(x=>x.allowedOrigins)'), ['https://example.test']);
  assert.equal((await send('Target.getTargets')).targetInfos.some(t => t.url.includes('/connection.html')), false);
  report.checks.push('GUI lifecycle exit/restore reconnects automatically in the same browser process despite network throttling');
  report.checks.push('Exact credential and site grant preserved; no new pairing, consent click or extension reload');
  // A longer GUI outage must recover from the alarm, after all fast retries
  // have finished, without the popup's status call triggering reconnection.
  app.dispose();
  await until(() => evaluate('chrome.storage.local.get("cardbushNativeReconnect").then(x=>x.cardbushNativeReconnect?.failures===3)'),
    'all three fast retries exhausted', 45000);
  app = await appStart(true);
  const slowStart = Date.now();
  await until(() => app.broker.status().extensionConnected, 'alarm recovery after longer GUI outage');
  report.alarmRecoveryMs = Date.now() - slowStart;
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'browser-connector/pairing.json'), 'utf8')).credentials, JSON.parse(saved).credentials);
  assert.equal((await send('Target.getTargets')).targetInfos.some(t => t.url.includes('/connection.html')), false);
  report.checks.push('A later GUI restart recovers on the background alarm after all fast retries have failed');
  report.success = true;
} catch (error) { report.error = error.stack; process.exitCode = 1; }
finally {
  for (const app of handles) app.dispose();
  if (browser && !exited) {
    await send('Browser.close').catch(() => {});
    await until(() => exited, 'fixture Chrome exit', 10000).catch(() => browser.kill());
  }
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Fixture closed')); }
  console.log(JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(parent, `browser-reconnect-native-${browserKind}-result.json`), JSON.stringify(report, null, 2));
  const resolved = path.resolve(root);
  if (!resolved.startsWith(parent + path.sep) || !path.basename(resolved).startsWith('browser-reconnect-native-')) throw new Error('Unsafe fixture path');
  if (exited) await fs.rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}
