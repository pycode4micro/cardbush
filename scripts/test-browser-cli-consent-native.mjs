// Real Chrome/Edge; isolated browser and CardBush profiles, no user credentials.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { SharedBrowserConnector } from '../dist-electron/sharedBrowserConnector.js';
import { AgentBrowserConnector } from '../dist-electron/agentBrowserConnector.mjs';
import { requestBrowserConnector } from '../packages/cardbush-chrome-mcp/dist/bridgeClient.js';
import { BrowserTestCdp, until } from './helpers/browser-test-cdp.mjs';

const parent = path.resolve('tmp');
await fs.mkdir(parent, { recursive: true });
const root = await fs.mkdtemp(path.join(parent, 'browser-cli-consent-'));
const kind = process.argv.includes('--edge') ? 'edge' : 'chrome';
const profile = path.join(root, 'app'), apps = path.join(profile, 'product-host/config/apps.json');
const native = path.resolve('dist-native/chrome-connector/CardBushBrowserHost.exe');
const cdp = new BrowserTestCdp(), report = { browser: kind, success: false, checks: [] };
const servers = [];
let browser, app, cli;
const send = (...args) => cdp.send(...args);
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
try {
  await fs.mkdir(path.dirname(apps), { recursive: true });
  await fs.writeFile(apps, JSON.stringify({ serviceEnabled: true, plugins: [{ id: 'chrome', installed: true, enabled: true }] }));
  app = new SharedBrowserConnector(profile, native, apps); await app.start();
  const port = (await read(path.join(profile, 'browser-connector/pairing.json'))).port;
  const extensionPath = path.join(root, 'extension');
  await fs.cp(path.resolve('assets/plugins/browser/extension'), extensionPath, { recursive: true });
  const transportPath = path.join(extensionPath, 'connector-transport.js');
  await fs.writeFile(transportPath, (await fs.readFile(transportPath, 'utf8')).replace(/const CONNECTOR_DISCOVERY_PORTS = [^\r\n]+;/,
    `const CONNECTOR_DISCOVERY_PORTS = Object.freeze([${port}]);`));
  const executable = kind === 'edge' ? process.env.CARDBUSH_TEST_EDGE ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    : process.env.CARDBUSH_TEST_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const browserProfile = path.join(root, kind);
  browser = spawn(executable, [`--user-data-dir=${browserProfile}`, '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--enable-unsafe-extension-debugging', 'about:blank'],
  { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  await cdp.connect(browser, { profilePath: browserProfile, allowRelaunch: kind === 'edge' });
  report.version = (await send('Browser.getVersion')).product;
  const { id: extensionId } = await send('Extensions.loadUnpacked', { path: extensionPath });
  async function attach(targetId) { return (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId; }
  const popup = await attach((await send('Target.createTarget', { url: `chrome-extension://${extensionId}/popup.html` })).targetId);
  const evaluate = expression => cdp.evaluate(expression, popup);
  const status = () => evaluate('chrome.runtime.sendMessage({action:"status"})');
  await until(() => evaluate('Boolean(document.querySelector("button[data-action=reconnect]"))'), 'extension UI');
  await evaluate('document.querySelector("button[data-action=reconnect]").click()');
  async function consent(page, button, screenshot) {
    const target = await until(async () => (await send('Target.getTargets')).targetInfos.find(t => t.url.includes(`/${page}#`)), `${kind} ${page}`);
    const session = await attach(target.targetId);
    await until(() => cdp.evaluate(`document.readyState === 'complete' && document.querySelector(${JSON.stringify(button)})?.disabled === false`, session), 'consent enabled');
    if (screenshot) {
      await send('Emulation.setDeviceMetricsOverride', { width: 340, height: 420, deviceScaleFactor: 1, mobile: false }, session);
      await cdp.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))', session);
      assert.equal(await cdp.evaluate('document.documentElement.scrollWidth <= innerWidth', session), true, 'narrow consent has no horizontal overflow');
      const png = await send('Page.captureScreenshot', { captureBeyondViewport: true, clip: { x: 0, y: 0, width: 340, height: 420, scale: 1 } }, session);
      await fs.writeFile(path.join(parent, `browser-cli-${kind}-${screenshot}.png`), Buffer.from(png.data, 'base64'));
    }
    // A second extension page possessing the URL/nonce still cannot approve.
    const token = new URL(target.url).hash.slice(1);
    const action = 'confirm_connection';
    assert.equal((await evaluate(`chrome.runtime.sendMessage(${JSON.stringify({ action, token, allow: true })})`)).ok, false);
    await cdp.evaluate(`document.querySelector(${JSON.stringify(button)}).click()`, session).catch(error => {
      if (!/closed|destroyed|No session/i.test(error.message)) throw error;
    });
    await until(async () => !(await send('Target.getTargets')).targetInfos.some(t => t.targetId === target.targetId), 'consent closes', 5000).catch(async error => {
      report.consentFailure = await cdp.evaluate('({text:document.body.innerText,buttons:[...document.querySelectorAll("button")].map(b=>({id:b.id,disabled:b.disabled}))})', session).catch(() => null);
      throw error;
    });
  }
  await consent('connection.html', '#allow', 'connection');
  await until(async () => (await status()).nativeConnected, 'approved App connection');
  const saved = await read(path.join(profile, 'browser-connector/pairing.json'));
  assert.equal(saved.credentials.length, 1); assert.equal(saved.credentials[0].browser, kind);
  const connectionId = saved.credentials[0].id;
  cli = new AgentBrowserConnector(profile, path.resolve('assets'), path.join(profile, 'product-host'), true);
  assert.equal((await cli.sync()).state, 'running');
  const request = (method, params = {}, scopeId = 'cli-task') => requestBrowserConnector(method, { scopeId, scopeTitle: scopeId, ...params },
    { configPath: path.join(profile, 'browser-connector/bridge.json'), timeoutMs: 15000 });
  assert.ok((await request('browser.list')).connections.some(c => c.id === connectionId && c.connected));
  await request('browser.select', { connectionId });
  report.checks.push('App-approved profile is available to the local CLI without pairing or another connection dialog');
  for (let i = 0; i < 3; i++) {
    const server = http.createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Isolated browser test</title><p>Fixture only</p>'); });
    servers.push(server); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  }
  const origins = servers.map(server => `http://127.0.0.1:${server.address().port}`);
  // Cookie reuse happens in the existing browser profile. CardBush never copies
  // the cookie database between products, browsers or accounts.
  const personalTarget = await send('Target.createTarget', { url: origins[0] });
  const personal = await attach(personalTarget.targetId);
  await until(() => cdp.evaluate('document.readyState === "complete"', personal), 'personal fixture page');
  await cdp.evaluate(`document.cookie='fixture_login=${kind}; Path=/'`, personal);
  const tab = await request('tabs.create', { url: origins[0] });
  const cookie = await request('debugger.command', { tabId: tab.id, command: 'Runtime.evaluate', commandParams: { expression: 'document.cookie', returnByValue: true } });
  assert.ok(cookie.result.value.includes(`fixture_login=${kind}`));
  assert.deepEqual((await request('tabs.list')).map(t => t.id), [tab.id], 'private tabs stay hidden');
  assert.equal((await status()).allowAllSites, true);
  for (const url of [origins[1], origins[2], origins[0]]) {
    await request('tabs.navigate', { tabId: tab.id, url });
    await until(async () => (await request('tabs.list')).find(page => page.id === tab.id)?.url === url + '/', 'cross-site navigation completes');
  }
  await request('browser.select', { connectionId }, 'app-task');
  const appTab = await request('tabs.create', { url: origins[0] }, 'app-task');
  await request('tabs.navigate', { tabId: appTab.id, url: origins[2] }, 'app-task');
  await assert.rejects(request('debugger.command', { tabId: tab.id, command: 'Runtime.evaluate' }, 'app-task'), { code: 'unmanaged_tab' });
  await assert.rejects(request('tabs.navigate', { tabId: appTab.id, url: origins[1] }), { code: 'unmanaged_tab' });
  assert.equal((await send('Target.getTargets')).targetInfos.some(t => /\/(authorization|connection)\.html/.test(t.url)), false);
  const popupText = await evaluate('document.body.innerText');
  assert.doesNotMatch(popupText, /仅本次|始终允许此网站/);
  report.checks.push('One connection consent covers all websites for App and CLI; cross-conversation tabs remain inaccessible');
  report.checks.push('Cross-site navigation needs no dialog; private tabs stay isolated and same-profile login is reused');
  for (const command of ['Target.getTargets', 'Network.getAllCookies', 'Storage.getCookies']) {
    await assert.rejects(request('debugger.command', { tabId: tab.id, command }), { code: 'unsupported_debugger_command' });
  }
  app.stop(); app = null;
  await until(async () => (await cli.sync()).state === 'running' && (await request('browser.list')).connections.some(c => c.id === connectionId && c.connected), 'CLI takes over after App exits');
  assert.deepEqual((await read(path.join(profile, 'browser-connector/pairing.json'))).credentials, saved.credentials);
  assert.equal((await send('Target.getTargets')).targetInfos.some(t => t.url.includes('/connection.html')), false);
  await request('tabs.navigate', { tabId: tab.id, url: origins[1] });
  await until(async () => (await request('tabs.list'))[0]?.url === origins[1] + '/', 'navigation after reconnect');
  report.checks.push('App exit hands the same credential to CLI; no new approval, and global CDP access is rejected');
  report.success = true;
} catch (error) { report.error = error.stack; process.exitCode = 1; }
finally {
  await send('Browser.close').catch(() => browser?.kill());
  cdp.close(); cli?.close(); app?.stop();
  for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await fs.writeFile(path.join(parent, `browser-cli-consent-${kind}-result.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  // Keep isolated profiles for a failing reproduction; no real user data lives here.
  if (report.success && path.dirname(path.resolve(root)) === parent) await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
