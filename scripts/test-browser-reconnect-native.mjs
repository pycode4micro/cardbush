// Real Chromium network throttling with isolated App/extension profiles only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { BrowserTestCdp, until } from './helpers/browser-test-cdp.mjs';

const parent = path.resolve('tmp');
await fs.mkdir(parent, { recursive: true });
const root = await fs.mkdtemp(path.join(parent, 'browser-reconnect-native-'));
const report = { success: false, checks: [] };
const browserKind = process.argv.includes('--edge') ? 'edge' : 'chrome';
const repo = process.cwd();
const profile = path.join(root, 'userData');
const appsConfigPath = path.join(profile, 'product-host', 'config', 'apps.json');
const pairingFile = path.join(profile, 'browser-connector', 'pairing.json');
const handles = [], browserCdp = new BrowserTestCdp();
const send = (...args) => browserCdp.send(...args);
let browser, browserOwnerPid, exited = false, activeApp, inspectExtension;
const running = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function appStart(restore = false) {
  const environment = { ...process.env, CARDBUSH_BROWSER_TEST_ROOT: root };
  for (const name of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'CARDBUSH_PACKAGED_SMOKE_RESULT',
    'CARDBUSH_ELECTRON_DEV_SERVER_URL', 'CARDBUSH_DEVELOPMENT_RUNTIME']) delete environment[name];
  for (const name of ['APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOME', 'CODEX_HOME', 'TEMP', 'TMP']) {
    environment[name] = path.join(root, 'environment', name); await fs.mkdir(environment[name], {recursive:true});
  }
  const child = spawn(createRequire(import.meta.url)('electron'), [path.join(repo, 'scripts/helpers/browser-app-fixture.cjs'),
    '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'],
    { windowsHide: true, env: environment, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const cdp = new BrowserTestCdp();
  let stopped = false;
  child.once('exit', () => { stopped = true; });
  const handle = { child, cdp, get stopped() { return stopped; }, async dispose(crash = false) {
    if (stopped) return;
    if (crash) child.kill(); else child.send('quit');
    await until(() => stopped, 'desktop process exit', 20000).catch(async error => {
      child.kill(); await until(() => stopped, 'forced fixture cleanup', 5000); throw error;
    });
    cdp.close();
  } };
  handles.push(handle);
  activeApp = handle;
  await cdp.connect(child);
  const target = await until(async () => (await cdp.send('Target.getTargets')).targetInfos
    .find(target => target.type === 'page' && /index\.html/.test(target.url)), 'real desktop renderer');
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  await until(() => cdp.evaluate('Boolean(window.cardbushDesktop)', sessionId), 'desktop preload');
  const invoke = (name, ...args) => cdp.evaluate(`window.cardbushDesktop[${JSON.stringify(name)}](...${JSON.stringify(args)})`, sessionId);
  handle.broker = { status: () => invoke('browserConnectorStatus'), createPairing: input => invoke('pairBrowserConnector', input) };
  if (!restore) await invoke('setupBrowserConnector');
  await until(async () => (await handle.broker.status()).bridgeRunning, 'desktop restores saved connector');
  assert.deepEqual(await invoke('chromeConnectorStatus'), await invoke('browserConnectorStatus'), 'legacy API alias stays compatible');
  return handle;
}
try {
  await fs.mkdir(path.dirname(appsConfigPath), {recursive:true});
  await fs.writeFile(appsConfigPath, JSON.stringify({ serviceEnabled: true, plugins: [{ id: 'chrome', installed: true, enabled: true }] }));
  let app = await appStart();
  const pairing = await app.broker.createPairing({ browser: browserKind, label: 'Isolated restart regression' });
  const port = Number(pairing.code.split('.')[1]);
  const extensionPath = path.join(root, 'extension');
  await fs.cp(path.resolve('assets/plugins/browser/extension'), extensionPath, { recursive: true });
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
      '--disable-background-networking', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--enable-unsafe-extension-debugging', 'about:blank'],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  browserOwnerPid = browser.pid;
  browser.once('exit', () => { if (browserOwnerPid === browser.pid) exited = true; });
  await browserCdp.connect(browser, {profilePath:path.join(root,browserKind), allowRelaunch:browserKind==='edge'});
  browserOwnerPid = Number((await send('SystemInfo.getProcessInfo')).processInfo.find(p => p.type === 'browser').id);
  exited = !running(browserOwnerPid);
  report.browser = (await send('Browser.getVersion')).product;
  const { id } = await send('Extensions.loadUnpacked', { path: extensionPath });
  let target = await send('Target.createTarget', { url: `chrome-extension://${id}/popup.html` });
  let { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  inspectExtension = () => evaluate('chrome.runtime.sendMessage({action:"status"})');
  await until(() => evaluate('Boolean(document.querySelector("#pairing-code"))'), 'extension popup');
  await evaluate(`chrome.runtime.sendMessage(${JSON.stringify({ action: 'pair', code: pairing.code })})`);
  await until(async () => (await app.broker.status()).extensionConnected, 'initial authorized connection');
  await evaluate('chrome.storage.local.set({allowedOrigins:["https://example.test"]})');
  const saved = await fs.readFile(pairingFile, 'utf8');
  await app.dispose();
  await until(async () => !(await evaluate('chrome.runtime.sendMessage({action:"status"})')).nativeConnected, 'GUI lifecycle exit');
  await send('Emulation.setDeviceMetricsOverride', {width:340,height:760,deviceScaleFactor:1,mobile:false}, sessionId);
  await evaluate('refresh()');
  const screenshot = await send('Page.captureScreenshot', {clip:{x:0,y:0,width:340,height:760,scale:1}}, sessionId);
  await fs.writeFile(path.join(parent, `browser-reconnect-${browserKind}-popup.png`), Buffer.from(screenshot.data,'base64'));
  // Failed WebSockets accumulate inside Chromium, which a Node ws fixture does
  // not implement. Force the same bounded 1–5 s connection delay after an outage.
  await evaluate(`Promise.all(Array.from({length:80},()=>new Promise(resolve=>{
    const socket=new WebSocket('ws://127.0.0.1:${port}/connect');
    socket.onerror=socket.onclose=()=>resolve();
  })))`);
  console.log('Real Chromium outage established; restarting the full desktop process without restarting the browser.');
  app = await appStart(true);
  const start = Date.now();
  await until(async () => (await app.broker.status()).extensionConnected, 'automatic saved connection after GUI restart');
  report.recoveryMs = Date.now() - start;
  await until(async () => (await inspectExtension()).nativeConnected
    && await evaluate('chrome.storage.local.get("cardbushNativeReconnect").then(x=>x.cardbushNativeReconnect?.failures===0)'),
    'extension records the completed handshake before the next outage');
  const current = JSON.parse(await fs.readFile(pairingFile, 'utf8'));
  assert.deepEqual(current.credentials, JSON.parse(saved).credentials);
  assert.deepEqual(await evaluate('chrome.storage.local.get("allowedOrigins").then(x=>x.allowedOrigins)'), ['https://example.test']);
  assert.equal((await send('Target.getTargets')).targetInfos.some(t => t.url.includes('/connection.html')), false);
  report.checks.push('Full desktop process exit/restore reconnects in the same browser process despite network throttling');
  report.checks.push('Exact credential and site grant preserved; no new pairing, consent click or extension reload');
  // A longer GUI outage must recover from the alarm, after all fast retries
  // have finished, without the popup's status call triggering reconnection.
  await app.dispose();
  await until(() => evaluate('chrome.storage.local.get("cardbushNativeReconnect").then(x=>x.cardbushNativeReconnect?.failures===3)'),
    'all three fast retries exhausted', 45000);
  app = await appStart(true);
  const slowStart = Date.now();
  await until(async () => (await app.broker.status()).extensionConnected, 'alarm recovery after longer GUI outage');
  report.alarmRecoveryMs = Date.now() - slowStart;
  assert.deepEqual(JSON.parse(await fs.readFile(pairingFile, 'utf8')).credentials, JSON.parse(saved).credentials);
  assert.equal((await send('Target.getTargets')).targetInfos.some(t => t.url.includes('/connection.html')), false);
  report.checks.push('A later GUI restart recovers on the background alarm after all fast retries have failed');
  for (const crash of [true, false]) {
    await app.dispose(crash);
    app = await appStart(true);
    app.child.send('resume'); // Simulate the OS resume notification, not physical sleep.
    await until(async () => (await app.broker.status()).extensionConnected, 'crash/repeated restart recovery');
    assert.deepEqual(JSON.parse(await fs.readFile(pairingFile, 'utf8')).credentials, JSON.parse(saved).credentials);
    assert.deepEqual(await evaluate('chrome.storage.local.get("allowedOrigins").then(x=>x.allowedOrigins)'), ['https://example.test']);
    assert.equal((await send('Target.getTargets')).targetInfos.some(t => t.url.includes('/connection.html')), false);
  }
  report.checks.push('Abrupt desktop termination, another normal exit and simulated OS resume preserve pairing and grants');
  let workerVersion;
  browserCdp.onEvent = message => {
    if (message.method === 'ServiceWorker.workerVersionUpdated') workerVersion = message.params.versions
      .find(version => version.scriptURL === `chrome-extension://${id}/background.js` && version.runningStatus === 'running') ?? workerVersion;
  };
  await send('ServiceWorker.enable', {}, sessionId);
  await until(() => workerVersion, 'extension worker version');
  const oldWorkerId = workerVersion.targetId;
  // Terminate the actual MV3 worker. The next ordinary extension event may wake
  // it; no Connect/Pair/consent action is sent. Runtime.reload is not supported
  // reliably for temporary extensions installed through this DevTools API.
  await send('ServiceWorker.stopWorker', {versionId:workerVersion.versionId}, sessionId);
  await until(async () => (await send('Target.getTargets')).targetInfos.some(t =>
    t.type === 'service_worker' && t.url === `chrome-extension://${id}/background.js` && t.targetId !== oldWorkerId),
    'new extension worker is ready');
  await until(async () => (await app.broker.status()).extensionConnected && (await inspectExtension()).nativeConnected, 'new extension worker restores saved connection');
  assert.deepEqual(JSON.parse(await fs.readFile(pairingFile, 'utf8')).credentials, JSON.parse(saved).credentials);
  assert.deepEqual(await evaluate('chrome.storage.local.get("allowedOrigins").then(x=>x.allowedOrigins)'), ['https://example.test']);
  assert.equal((await send('Target.getTargets')).targetInfos.some(t => t.url.includes('/connection.html')), false);
  report.checks.push('Terminated MV3 worker restores pairing and site grants on the next ordinary extension event');
  report.success = true;
} catch (error) {
  report.error = error.stack; process.exitCode = 1;
  const status = await activeApp?.broker?.status().catch(() => null);
  if (status) report.desktop = Object.fromEntries(['bridgeRunning','connectorEnabled','lifecycleState','lastError','portRecovery'].map(key => [key,status[key]]));
  const extension = await inspectExtension?.().catch(() => null);
  if (extension) report.extension = Object.fromEntries(['nativeConnected','nativeConnecting','connectorEnabled','hasPairing','reconnectPaused','reconnectWaiting','nextRetryAt','connectionDiagnostic','lastError'].map(key => [key,extension[key]]));
  const pairingState = await fs.readFile(pairingFile, 'utf8').then(JSON.parse).catch(() => null);
  report.hostPort = pairingState?.port;
}
finally {
  for (const app of handles) await app.dispose().catch(error => { report.cleanupError = error.message; process.exitCode = 1; });
  if (browser && !exited) {
    if (browserCdp.socket) await send('Browser.close').catch(() => {}); else browser.kill();
    await until(() => !running(browserOwnerPid), 'fixture browser exit', 10000).catch(() => process.kill(browserOwnerPid));
    exited = !running(browserOwnerPid);
  }
  browserCdp.close();
  console.log(JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(parent, `browser-reconnect-native-${browserKind}-result.json`), JSON.stringify(report, null, 2));
  const resolved = path.resolve(root);
  if (!resolved.startsWith(parent + path.sep) || !path.basename(resolved).startsWith('browser-reconnect-native-')) throw new Error('Unsafe fixture path');
  if (report.success && exited && handles.every(app => app.stopped)) await fs.rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}
