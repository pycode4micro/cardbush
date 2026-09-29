// Run by the installed-MSIX test-account harness. No model calls or real browser profile.
import assert from 'node:assert/strict';
import { spawn, execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const report = { startedAt: new Date().toISOString(), packageContext: config.packageContext ?? 'unpacked', success: false, checks: [] };
const children = new Set();
const runFile = promisify(execFile);
const exists = file => access(file).then(() => true, error => {
  if (error.code === 'ENOENT') return false;
  throw error;
});
const checkpoint = name => { report.checks.push(name); return save(); };
const save = () => writeFile(config.reportPath, JSON.stringify(report, null, 2));
async function until(fn, description, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await delay(200); }
  throw new Error(`Timed out: ${description}`);
}
class Cdp {
  pending = new Map(); sequence = 0;
  receive = text => {
    const message = JSON.parse(text);
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id); clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
  };
  send(method, params = {}, sessionId) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async evaluate(expression, sessionId) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  async attach(targetId) { return (await this.send('Target.attachToTarget', { targetId, flatten: true })).sessionId; }
  async close() { await this.send('Browser.close').catch(() => {}); this.socket?.close(); }
}
function child(executable, args, options = {}) {
  const environment = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'CARDBUSH_PACKAGED_SMOKE_RESULT', 'CARDBUSH_RUNTIME_PROVIDER_API_KEY', 'CARDBUSH_RUNTIME_PROVIDER_BASE_URL', 'CARDBUSH_ELECTRON_DEV_SERVER_URL', 'CARDBUSH_DEVELOPMENT_RUNTIME']) delete environment[key];
  const childProcess = spawn(executable, args, { windowsHide: true, env: environment, stdio: ['ignore', 'ignore', 'pipe'], ...options });
  children.add(childProcess); childProcess.once('exit', () => children.delete(childProcess));
  return childProcess;
}
async function appStart() {
  const process = child(config.executable, ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', ...(config.userDataDirectory ? [`--user-data-dir=${config.userDataDirectory}`] : [])]);
  if (config.expectedPackageFullName) {
    const identity = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(import.meta.dirname, 'verify-process-package.ps1'), '-ProcessId', String(process.pid)], { encoding: 'utf8', windowsHide: true }).trim();
    assert.equal(identity, config.expectedPackageFullName, 'Application must have the installed package identity');
    report.processPackageIdentity = identity;
  }
  let stderr = '';
  process.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-20000); });
  const endpoint = await until(() => /DevTools listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/.exec(stderr)?.[1], 'application debugging endpoint');
  const cdp = new Cdp(); cdp.socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { cdp.socket.onopen = resolve; cdp.socket.onerror = () => reject(new Error('Application CDP connection failed')); });
  cdp.write = text => cdp.socket.send(text); cdp.socket.onmessage = event => cdp.receive(event.data);
  const target = await until(async () => (await cdp.send('Target.getTargets')).targetInfos.find(target => target.type === 'page' && /index\.html/.test(target.url)), 'application renderer');
  const session = await cdp.attach(target.targetId);
  await until(() => cdp.evaluate('Boolean(window.cardbushDesktop)', session), 'application preload');
  if (config.expectedPackageFullName) {
    report.processDpiAwareness = Number(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(import.meta.dirname, 'verify-process-package.ps1'), '-ProcessId', String(process.pid), '-Dpi'], { encoding: 'utf8', windowsHide: true }).trim());
    assert.equal(report.processDpiAwareness, 2, 'Application should be per-monitor DPI aware');
  }
  const invoke = (name, args = []) => cdp.evaluate(`window.cardbushDesktop[${JSON.stringify(name)}](...${JSON.stringify(args)})`, session);
  return { process, cdp, invoke, status: () => invoke('chromeConnectorStatus') };
}
async function chromeStart(extensionDirectory, browser = 'chrome') {
  const executable = browser === 'edge' ? config.edgeExecutable : config.chromeExecutable;
  const profile = browser === 'edge' ? config.edgeProfile : config.chromeProfile;
  const process = child(executable, [`--user-data-dir=${profile}`, ...(config.headlessBrowsers ? ['--headless=new'] : []), '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  process.stderr.resume();
  const cdp = new Cdp(); cdp.write = text => process.stdio[3].write(text + '\0');
  let buffer = '';
  process.stdio[4].on('data', bytes => {
    buffer += bytes.toString(); let boundary;
    while ((boundary = buffer.indexOf('\0')) >= 0) { const message = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1); if (message) cdp.receive(message); }
  });
  report[`${browser}Version`] = (await cdp.send('Browser.getVersion')).product;
  const loaded = await cdp.send('Extensions.loadUnpacked', { path: extensionDirectory });
  assert.equal(loaded.id, 'iibaamkfgackofhhpadgnmgcjkhckeln');
  const target = await cdp.send('Target.createTarget', { url: `chrome-extension://${loaded.id}/popup.html` });
  const session = await cdp.attach(target.targetId);
  await until(() => cdp.evaluate('Boolean(document.querySelector("#pairing-code"))', session), 'extension popup');
  return { process, cdp, action: (action, extra = {}) => cdp.evaluate(`chrome.runtime.sendMessage(${JSON.stringify({ action, ...extra })})`, session) };
}
async function close(instance) {
  await instance.cdp.close();
  await until(() => instance.process.exitCode !== null, 'owned process exit', 20000);
}
async function bridgeRequest(method, params) {
  const bridge = JSON.parse(await readFile(path.join(config.connectorDirectory, 'bridge.json'), 'utf8'));
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(bridge.endpoint); socket.setEncoding('utf8'); let buffer = '';
    const id = randomUUID(); const clientId = `validation-${randomUUID()}`;
    const timer = setTimeout(() => finish(new Error(`Connector timeout: ${method}`)), 15000);
    const finish = (error, value) => { clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value); };
    socket.on('error', error => finish(error));
    socket.on('connect', () => socket.write(JSON.stringify({ type: 'hello', protocol: 'cardbush.chrome_connector.v1', role: 'mcp', token: bridge.token, clientId }) + '\n'));
    socket.on('data', chunk => {
      buffer += chunk; let boundary;
      while ((boundary = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1); if (!line) continue;
        const message = JSON.parse(line);
        if (message.type === 'hello_ack') socket.write(JSON.stringify({ type: 'request', id, method, params }) + '\n');
        if (message.type === 'response' && message.id === id) finish(message.error ? new Error(`Connector error: ${message.error.code}`) : null, message.result);
      }
    });
  });
}
let app, chrome, edge;
const server = http.createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><title>CardBush isolated validation</title><h1 id="proof">Chrome connector round trip</h1>'); });
try {
  await mkdir(path.dirname(config.reportPath), { recursive: true });
  if (config.expectedPackageFullName) {
    const elevated = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'], { encoding: 'utf8', windowsHide: true }).trim();
    assert.ok(['True', 'False'].includes(elevated), 'Read the actual validation process privilege level');
    report.elevated = elevated === 'True';
    report.ordinaryAccountValidation = !report.elevated;
    if (!config.allowElevatedTest) assert.equal(report.elevated, false, 'Installed validation must run unelevated; explicitly label any developer-only elevated run');
  }
  assert.equal(await exists(config.chromeProfile), false, 'Refuse to reuse any existing Chrome profile');
  if (config.edgeExecutable) {
    assert.ok(config.edgeProfile, 'An independent Edge profile is required');
    assert.notEqual(path.resolve(config.edgeProfile), path.resolve(config.chromeProfile));
    assert.equal(await exists(config.edgeProfile), false, 'Refuse to reuse any existing Edge profile');
  }
  app = await appStart();
  let status = await app.status();
  if (config.expectedCleanupWarning) {
    assert.equal(status.cleanupWarning, config.expectedCleanupWarning);
    await checkpoint('upgrade reports existing external legacy registration');
  }
  if (config.prepareLegacy) {
    status = await app.invoke('setupChromeConnector');
    assert.equal(status.bridgeRegistered, true);
    assert.equal(status.bridgeRunning, true);
    await close(app);
    await checkpoint('legacy installed application registered its actual Native Messaging host');
    report.success = true;
  } else {
  assert.equal(status.connectorEnabled, false); assert.equal(status.bridgeRunning, false);
  await checkpoint('default connector disabled');
  status = await app.invoke('setupChromeConnector');
  assert.equal(status.lifecycleState, 'enabled'); assert.equal(status.bridgeRunning, true);
  report.extensionVersion = JSON.parse(await readFile(path.join(status.extensionDirectory, 'manifest.json'), 'utf8')).version;
  const pair = await app.invoke('pairChromeConnector');
  chrome = await chromeStart(status.extensionDirectory);
  assert.equal((await chrome.action('pair', { code: pair.code })).ok, true);
  await until(async () => (await app.status()).extensionConnected, 'real Chrome pairing');
  await checkpoint('application paired with real Chrome extension');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const scope = { scopeId: `validation-${randomUUID()}`, scopeTitle: 'Isolated MSIX validation' };
  const tab = await bridgeRequest('tabs.create', { ...scope, url: `http://127.0.0.1:${server.address().port}/` });
  await until(async () => {
    const result = await bridgeRequest('debugger.command', { ...scope, tabId: tab.id, command: 'Runtime.evaluate', commandParams: { expression: 'document.querySelector("#proof")?.textContent', returnByValue: true } });
    return result.result?.value === 'Chrome connector round trip';
  }, 'Chrome page text through production broker');
  assert.ok((await bridgeRequest('tabs.list', scope)).some(candidate => candidate.id === tab.id));
  await bridgeRequest('tabs.close', { ...scope, tabId: tab.id });
  await checkpoint('named pipe -> broker -> Chrome: create, list, debug, close');
  if (config.edgeExecutable) {
    const edgePair = await app.invoke('pairChromeConnector', [{ browser: 'edge', label: 'Isolated Edge validation' }]);
    edge = await chromeStart(status.extensionDirectory, 'edge');
    assert.equal((await edge.action('pair', { code: edgePair.code })).ok, true);
    await until(async () => (await app.status()).connections.filter(connection => connection.connected).length === 2, 'simultaneous Chrome and Edge pairing');
    const edgeScope = { scopeId: `edge-validation-${randomUUID()}`, scopeTitle: 'Isolated MSIX Edge validation' };
    await bridgeRequest('browser.select', { ...edgeScope, connectionId: edgePair.id });
    const edgeTab = await bridgeRequest('tabs.create', { ...edgeScope, url: `http://127.0.0.1:${server.address().port}/edge` });
    await until(async () => {
      const result = await bridgeRequest('debugger.command', { ...edgeScope, tabId: edgeTab.id, command: 'Runtime.evaluate', commandParams: { expression: 'document.querySelector("#proof")?.textContent', returnByValue: true } });
      return result.result?.value === 'Chrome connector round trip';
    }, 'Edge page text through installed broker');
    const capture = await bridgeRequest('debugger.command', { ...edgeScope, tabId: edgeTab.id, command: 'Page.captureScreenshot', commandParams: { format: 'png' } });
    assert.ok(Buffer.from(capture.data, 'base64').length > 100, 'Installed Edge screenshot has image bytes');
    await app.invoke('selectDefaultBrowserConnection', [edgePair.id]);
    assert.equal((await bridgeRequest('browser.list', scope)).selectedConnectionId, pair.id, 'Default change must not move the existing Chrome session');
    await bridgeRequest('browser.select', { ...scope, connectionId: edgePair.id });
    assert.equal((await bridgeRequest('tabs.list', scope)).length, 0, 'Another session in Edge remains isolated after switching');
    await bridgeRequest('browser.select', { ...scope, connectionId: pair.id });
    await checkpoint('installed Chrome and Edge coexist; Edge read/screenshot, sticky default, explicit switching and session isolation');
    if (!config.uninstallMode) {
      await app.invoke('revokeBrowserConnection', [edgePair.id]);
      await until(async () => !(await edge.action('status')).connectorEnabled, 'individual Edge revocation');
      assert.equal((await app.status()).connections.find(connection => connection.id === pair.id)?.connected, true);
      await close(edge);
      await checkpoint('individual Edge revocation preserves Chrome');
    }
    await app.invoke('selectDefaultBrowserConnection', [pair.id]);
  }
  if (config.uninstallMode) {
    assert.ok(['normal', 'running', 'crash'].includes(config.uninstallMode));
    assert.ok(config.expectedPackageFullName && config.ownershipPath);
    report.uninstallMode = config.uninstallMode;
    if (config.uninstallMode === 'normal') await close(app);
    if (config.uninstallMode === 'crash') {
      app.process.kill();
      await until(() => app.process.exitCode !== null || app.process.signalCode !== null, 'terminated main process');
    }
    const removalReport = `${config.reportPath}.uninstall.json`;
    await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(import.meta.dirname, 'verify-msix-uninstall.ps1'), '-OwnershipPath', config.ownershipPath, '-ResultPath', removalReport], { windowsHide: true, timeout: 120000 });
    const removal = JSON.parse((await readFile(removalReport, 'utf8')).replace(/^\uFEFF/, ''));
    assert.equal(removal.success, true);
    // Explicitly labeled developer-only runs can inspect removal on UAC-disabled hosts.
    // They must never be recorded as ordinary-account validation.
    if (!config.allowElevatedTest) assert.equal(removal.elevated, false);
    report.ordinaryAccountUninstall = removal.elevated === false;
    report.uninstall = removal;
    assert.equal(await exists(config.connectorDirectory), false);
    await until(async () => !(await chrome.action('status')).nativeConnected, 'Chrome disconnect after uninstall');
    if (edge) await until(async () => !(await edge.action('status')).nativeConnected, 'Edge disconnect after uninstall');
    await checkpoint(`${config.uninstallMode} uninstall: package, connector data and registry absent`);
    report.success = true;
  } else {
  assert.equal((await chrome.action('disable_connector')).connectorEnabled, false);
  await until(async () => !(await app.status()).extensionConnected, 'extension disconnect');
  await delay(32000);
  assert.equal((await app.status()).extensionConnected, false);
  await checkpoint('extension disabled: no reconnect after alarm interval');
  assert.equal((await chrome.action('reconnect')).ok, true);
  await until(async () => (await app.status()).extensionConnected, 'explicit reconnect');
  await close(chrome); chrome = await chromeStart(status.extensionDirectory);
  assert.equal((await chrome.action('status')).connectorEnabled, false);
  assert.equal((await app.status()).extensionConnected, false);
  await checkpoint('fresh Chrome session stays disconnected until explicit action');
  await chrome.action('reconnect');
  await until(async () => (await app.status()).extensionConnected, 'explicit reconnect after browser restart');
  await close(app); app = await appStart();
  await until(async () => (await app.status()).bridgeRunning, 'enabled preference restored');
  await chrome.action('reconnect');
  await until(async () => (await app.status()).extensionConnected, 'pairing survives ordinary application restart', 40000);
  await checkpoint('ordinary application restart preserves explicit enable and pairing');
  status = await app.invoke('disableChromeConnector');
  assert.equal(status.connectorEnabled, false); assert.equal(status.bridgeRunning, false);
  assert.equal(await exists(path.join(config.connectorDirectory, 'pairing.json')), false);
  assert.equal(await exists(path.join(config.connectorDirectory, 'bridge.json')), false);
  await until(async () => !(await chrome.action('status')).connectorEnabled, 'app disable propagated to extension');
  await close(app); app = await appStart();
  assert.equal((await app.status()).connectorEnabled, false);
  await checkpoint('application disable revokes credentials and survives restart');
  await app.invoke('setupChromeConnector');
  await chrome.action('pair', { code: pair.code });
  await delay(1500);
  assert.equal((await app.status()).extensionConnected, false);
  const replacement = await app.invoke('pairChromeConnector');
  await chrome.action('pair', { code: replacement.code });
  await until(async () => (await app.status()).extensionConnected, 'new pairing after revocation');
  await checkpoint('old pairing rejected; fresh explicit pairing succeeds');
  await app.invoke('removeChromeConnector');
  assert.equal(await exists(path.join(config.connectorDirectory, 'pairing.json')), false);
  assert.equal(await exists(path.join(config.connectorDirectory, 'bridge.json')), false);
  assert.equal(JSON.parse(await readFile(path.join(config.connectorDirectory, 'preference.json'), 'utf8')).removed, true);
  await checkpoint('remove clears live bridge and pairing, retains disabled marker');
  report.success = true;
  }
  }
} catch (error) {
  // Redact pairing credentials before storing failure diagnostics.
  report.error = String(error.message).replace(/CB2\.[\w.]+/g, '[redacted pairing]').replace(/[a-f0-9]{64}/gi, '[redacted secret]');
} finally {
  for (const instance of [edge, chrome, app]) if (instance && instance.process.exitCode === null && instance.process.signalCode === null) await close(instance).catch(() => { instance.process.kill(); });
  for (const process of children) process.kill();
  server.close(); report.completedAt = new Date().toISOString(); await save();
}
if (!report.success) process.exitCode = 1;
