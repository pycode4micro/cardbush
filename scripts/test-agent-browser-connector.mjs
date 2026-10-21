import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { AgentBrowserConnector } from '../dist-electron/agentBrowserConnector.mjs';
import { AgentService } from '../dist-electron/agentService.mjs';
import { requestChromeConnector } from '../packages/cardbush-chrome-mcp/dist/bridgeClient.js';
import { pairedClient } from './helpers/chrome-paired-client.mjs';

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
