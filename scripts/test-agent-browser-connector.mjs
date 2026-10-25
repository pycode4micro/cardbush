import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { AgentBrowserConnector } from '../dist-electron/agentBrowserConnector.mjs';
import { AgentService } from '../dist-electron/agentService.mjs';
import { requestChromeConnector } from '../packages/cardbush-chrome-mcp/dist/bridgeClient.js';
import { pairedClient } from './helpers/chrome-paired-client.mjs';
import { createCardbushChromeServer } from '../packages/cardbush-chrome-mcp/dist/index.js';

const parent = resolve('tmp/agent-browser-connector-tests');
async function fixture(t) {
  await mkdir(parent, { recursive: true }); const root = await mkdtemp(join(parent, 'agent-'));
  await mkdir(join(root, 'config'));
  const close = [];
  t.after(async () => { for (const cleanup of close.reverse()) await cleanup();
    assert.ok(resolve(root).startsWith(parent + sep)); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
  const configure = (enabled, connectionMode = 'connector') => writeFile(join(root, 'config/apps.json'), JSON.stringify({
    protocol: 'cardbush.apps.config.v1', revision: 1, serviceEnabled: true, plugins: [{ id: 'chrome', installed: true, enabled, config: { connectionMode } }] }));
  await configure(true);
  return { root, close, configure, configPath: join(root, 'browser-connector/bridge.json') };
}
test('Agent owns a paired connector across restarts, disabling and explicit mode changes', async t => {
  const f = await fixture(t);
  let connector = new AgentBrowserConnector(f.root, resolve('assets'));
  f.close.push(() => connector.close());
  assert.equal((await connector.sync()).state, 'running');
  const list = () => requestChromeConnector('browser.list', { scopeId: 'fixture-session' }, { configPath: f.configPath });
  assert.deepEqual((await list()).connections, []);
  const pair = await connector.call({ action: 'pair', browser: 'edge', label: 'Remote Edge' });
  const peer = await pairedClient(pair.code, { browser: 'edge' }); f.close.push(() => peer.destroy());
  assert.equal((await list()).connections[0].browser, 'edge');
  assert.equal((await list()).connections[0].connected, true);
  assert.ok(!JSON.stringify(connector.status()).includes(pair.code.split('.').at(-1)), 'status must not disclose pairing credentials');
  await connector.close();
  await assert.rejects(readFile(f.configPath), { code: 'ENOENT' });
  connector = new AgentBrowserConnector(f.root, resolve('assets')); await connector.sync();
  assert.equal((await list()).connections[0].id, pair.id);
  const resumed = await pairedClient(pair.code, { browser: 'edge' }); f.close.push(() => resumed.destroy());
  assert.equal((await list()).connections[0].connected, true);
  await f.configure(false); assert.equal((await connector.sync()).state, 'disabled');
  await assert.rejects(connector.call({ action: 'pair', browser: 'edge' }), /Enable/);
  await f.configure(true, 'remote_debugging'); assert.equal((await connector.sync()).state, 'disabled');
  await f.configure(true); assert.equal((await connector.sync()).state, 'running');
  assert.equal((await list()).connections[0].id, pair.id, 'ordinary disable retains pairing');
});
test('incomplete Windows packages report a precise connector failure without starting an unprotected endpoint', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), connector = new AgentBrowserConnector(f.root, join(f.root, 'missing/assets'));
  f.close.push(() => connector.close());
  const status = await connector.sync();
  assert.equal(status.state, 'unavailable'); assert.match(status.error, /component is missing/);
  await assert.rejects(readFile(f.configPath), { code: 'ENOENT' });
});
test('Agent starts the enabled connector and exposes management through its authenticated host API', async t => {
  const f = await fixture(t);
  const service = await AgentService.open({ dataRoot: f.root, bundledRoot: resolve('assets') });
  f.close.push(() => service.close());
  assert.equal((await service.call('browser.connector', { action: 'status' })).state, 'running');
  const pair = await service.call('browser.connector', { action: 'pair', browser: 'edge' });
  assert.equal(pair.browser, 'edge');
  assert.deepEqual((await requestChromeConnector('browser.list', { scopeId: 'fixture' }, { configPath: f.configPath })).connections, []);
});

test('local Runtime connects without the App and then shares the same browsers with it', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), profile = join(f.root, 'profile'), dataRoot = join(f.root, 'local');
  const configurationRoot = join(profile, 'product-host');
  await mkdir(join(configurationRoot, 'config'), { recursive: true });
  await writeFile(join(configurationRoot, 'config/apps.json'), await readFile(join(f.root, 'config/apps.json')));
  const service = await AgentService.open({ dataRoot, local: true, localProfileRoot: profile, bundledRoot: resolve('assets') });
  f.close.push(() => service.close());
  assert.equal((await service.call('browser.connector', { action: 'status' })).state, 'running');
  await assert.rejects(readFile(join(dataRoot, 'browser-connector/bridge.json')), { code: 'ENOENT' }, 'no second CLI broker');
  const configPath = join(profile, 'browser-connector/bridge.json');
  const server = createCardbushChromeServer({ browserConfigPath: configPath });
  const codes = [];
  for (const browser of ['chrome', 'edge']) {
    const context = { mcpReq: { signal: new AbortController().signal, _meta: { cardbush_session_id: 'local-' + browser } } };
    const pair = await service.call('browser.connector', { action: 'pair', browser, label: 'CLI ' + browser }); codes.push(pair.code);
    assert.equal(pair.extensionPath, resolve('assets/plugins/chrome/extension'));
    const peer = await pairedClient(pair.code, { browser }); f.close.push(() => peer.destroy());
    peer.on('data', data => {
      const message = JSON.parse(String(data));
      if (message.type === 'request') peer.write(JSON.stringify({ type: 'response', clientId: message.clientId, id: message.id,
        result: [{ id: 42, active: true, browser, title: 'authorized fixture', url: 'https://example.invalid' }] }));
    });
    const listed = await server._registeredTools.list_browsers.handler({}, context);
    assert.ok(listed.structuredContent.connections.some(item => item.id === pair.id && item.browser === browser && item.connected));
    assert.equal((await server._registeredTools.select_browser.handler({ connectionId: pair.id }, context)).isError, undefined);
    assert.equal((await server._registeredTools.list_pages.handler({}, context)).structuredContent.pages[0].browser, browser);
    assert.ok(codes.every(code => !JSON.stringify(listed).includes(code.split('.').at(-1))), 'browser tools never return pairing secrets');
  }
  const desktop = new AgentBrowserConnector(profile, resolve('assets'), configurationRoot, true); f.close.push(() => desktop.close());
  await desktop.sync();
  const appPair = await desktop.call({ action: 'pair', browser: 'chrome' });
  const appPeer = await pairedClient(appPair.code); f.close.push(() => appPeer.destroy());
  assert.equal((await desktop.call({ action: 'status' })).connector.connections.length, 3);
  assert.equal((await service.call('browser.connector', { action: 'status' })).connector.connections.length, 3);
  await service.close();
  await desktop.call({ action: 'status' });
  const appResumed = await pairedClient(appPair.code); f.close.push(() => appResumed.destroy());
  assert.ok((await requestChromeConnector('browser.list', { scopeId: 'app-stays-alive' }, { configPath })).connections.some(connection => connection.id === appPair.id && connection.connected));
  const restarted = await AgentService.open({ dataRoot, local: true, localProfileRoot: profile, bundledRoot: resolve('assets') });
  f.close.push(() => restarted.close());
  const resumed = await pairedClient(codes[1], { browser: 'edge' }); f.close.push(() => resumed.destroy());
  const restored = await requestChromeConnector('browser.list', { scopeId: 'local-edge' }, { configPath });
  assert.equal(restored.selectedConnectionId, codes[1].split('.')[2]);
  assert.equal(restored.connections.find(item => item.browser === 'edge').connected, true, 'ordinary CLI restart retains the pairing and session route');
});
