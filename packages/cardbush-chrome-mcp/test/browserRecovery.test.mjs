import assert from 'node:assert/strict';
import test from 'node:test';
import { createCardbushBrowserServer, createBrowserUseState } from '../dist/index.js';
import { projectMcpResult } from '../../bush-mcp-client/dist/modelResult.js';
import { BrowserConnectorError } from '../dist/bridgeClient.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const context = { mcpReq: { signal: new AbortController().signal, _meta: { cardbush_session_id: 'recovery' } } };

function assertNoActionHints(result) {
  assert.doesNotMatch(JSON.stringify(result), /"(?:next_step|nextStep|guidance|recovery_hint)"\s*:/);
  assert.doesNotMatch(JSON.stringify(result), /Call list_browsers again|Run npm run build:agent|重新申请本机连接/);
}

test('connection receipts preserve availability and selection without prescribing actions', async () => {
  const id = '1'.repeat(32);
  let connections = [];
  const server = createCardbushBrowserServer({ connector: async method => {
    assert.equal(method, 'browser.list'); return { connections, selectedConnectionId: id };
  } });
  const empty = (await server._registeredTools.list_browsers.handler({}, context)).structuredContent;
  assert.deepEqual(empty, { connections: [], selectedConnectionId: id, availability: 'needs_connection' });
  assertNoActionHints(empty);
  connections = [{ id, browser: 'edge', connected: false }];
  const offline = (await server._registeredTools.list_browsers.handler({}, context)).structuredContent;
  assert.equal(offline.selectedConnectionId, id); assert.equal(offline.connections[0].id, id);
  assert.equal(offline.availability, 'needs_connection');
  assert.deepEqual(offline.connections, connections); assertNoActionHints(offline);
  connections[0].connected = true;
  const online = (await server._registeredTools.list_browsers.handler({}, context)).structuredContent;
  assert.equal(online.selectedConnectionId, id); assert.equal(online.connections[0].connected, true);
  assert.equal(online.availability, undefined); assertNoActionHints(online);
});

test('rejected handshake receipts preserve their reason and timestamp without changing connections', async () => {
  const id = '1'.repeat(32);
  let at = new Date().toISOString();
  const calls = [];
  const server = createCardbushBrowserServer({ connector: async method => {
    calls.push(method); return { connections: [{ id, connected: false }], selectedConnectionId: id,
      connectionAttempt: { at, stage: 'rejected', reason: 'pairing_proof_mismatch', connectionId: id } };
  } });
  const current = (await server._registeredTools.list_browsers.handler({}, context)).structuredContent;
  assert.deepEqual(current.connectionAttempt, { at, stage: 'rejected', reason: 'pairing_proof_mismatch', connectionId: id });
  assert.equal(current.selectedConnectionId, id); assertNoActionHints(current);
  at = new Date(Date.now() - 60_000).toISOString();
  const stale = (await server._registeredTools.list_browsers.handler({}, context)).structuredContent;
  assert.equal(stale.connectionAttempt.at, at); assert.equal(stale.connectionAttempt.reason, 'pairing_proof_mismatch');
  assert.equal(stale.selectedConnectionId, id); assertNoActionHints(stale);
  assert.deepEqual(calls, ['browser.list', 'browser.list']);
});

test('session 095c replay: missing bridge is setup state, mutations stay blocked and recovery is live', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-browser-setup-')), config = join(root, 'bridge.json');
  t.after(async () => { assert.equal(dirname(root), tmpdir()); await rm(root, { recursive: true, force: true }); });
  const server = createCardbushBrowserServer({ browserConfigPath: config });
  const listed = await server._registeredTools.list_browsers.handler({}, context);
  assert.equal(listed.isError, undefined); assert.equal(listed.structuredContent.availability, 'needs_setup');
  assert.deepEqual(listed.structuredContent.connections, []);
  assert.equal(listed.structuredContent.reason, 'bridge_config_unavailable'); assertNoActionHints(listed);
  const mutation = await server._registeredTools.new_page.handler({ url: 'https://example.invalid' }, context);
  assert.equal(mutation.isError, true); assert.equal(mutation.structuredContent.error.code, 'bridge_config_unavailable');
  assert.ok(mutation.structuredContent.error.message); assertNoActionHints(mutation);
  assert.equal(mutation.structuredContent.error.details.execution, 'not_dispatched');
  await writeFile(config, JSON.stringify({ token: 'must-not-be-printed', protocol: 'invalid' }));
  const invalid = await server._registeredTools.list_browsers.handler({}, context);
  assert.equal(invalid.structuredContent.availability, 'misconfigured'); assert.doesNotMatch(JSON.stringify(invalid), /must-not-be-printed/);
  assert.equal(invalid.structuredContent.reason, 'bridge_config_invalid'); assertNoActionHints(invalid);
  let connected = false; const calls = [];
  const live = createCardbushBrowserServer({ connector: async method => {
    calls.push(method);
    if (!connected) throw new BrowserConnectorError('cardbush_bridge_unavailable', 'offline');
    return { connections: [{ id: 'cardbush', connected: true }] };
  } });
  const disconnected = (await live._registeredTools.list_browsers.handler({}, context)).structuredContent;
  assert.equal(disconnected.availability, 'disconnected'); assert.equal(disconnected.reason, 'cardbush_bridge_unavailable');
  assertNoActionHints(disconnected);
  connected = true;
  assert.equal((await live._registeredTools.list_browsers.handler({}, context)).structuredContent.connections[0].id, 'cardbush');
  assert.deepEqual(calls, ['browser.list', 'browser.list'], 'no hidden launch or mutation replay');
});

test('availability diagnostics never rewrite uncertain dispatch into a safe-to-retry mutation', async () => {
  const server = createCardbushBrowserServer({ connector: async () => {
    throw new BrowserConnectorError('cardbush_bridge_unavailable', 'disconnected', { execution: 'unknown' });
  } });
  const result = await server._registeredTools.new_page.handler({ url: 'https://example.invalid' }, context);
  assert.equal(result.isError, true); assert.equal(result.structuredContent.error.details.execution, 'unknown');
  assertNoActionHints(result);
});

test('only fresh diagnostics for this host explain startup failure; disabled, expired and foreign states stay distinct', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-browser-health-')), config = join(root, 'bridge.json'), healthPath = join(root, 'health.json');
  t.after(async () => { assert.equal(dirname(root), tmpdir()); await rm(root, { recursive: true, force: true }); });
  const health = { protocol: 'cardbush.browser_connector_health.v1', configPath: config, updatedAt: new Date().toISOString(), state: 'unavailable', recoveryPaused: true,
    error: { code: 'browser_connector_component_missing', message: 'Agent browser connector component is missing.', nextStep: 'Run npm run build:agent and reopen the CLI.',
      token: 'unexpected-field-must-not-reach-the-model' } };
  const server = createCardbushBrowserServer({ browserConfigPath: config, browserHealthPath: healthPath });
  const list = async () => (await server._registeredTools.list_browsers.handler({}, context)).structuredContent;
  await writeFile(healthPath, JSON.stringify(health));
  const failed = await list();
  assert.equal(failed.reason, 'browser_connector_component_missing'); assert.equal(failed.availability, 'host_unavailable');
  assert.equal(failed.connector.checkedAt, health.updatedAt); assert.equal(failed.connector.recoveryPaused, true);
  assert.equal(failed.connector.message, health.error.message); assertNoActionHints(failed);
  assert.doesNotMatch(JSON.stringify(failed), /unexpected-field/);
  const mutation = await server._registeredTools.new_page.handler({ url: 'https://example.invalid' }, context);
  assert.equal(mutation.isError, true); assert.equal(mutation.structuredContent.error.code, failed.reason);
  assert.equal(mutation.structuredContent.error.details.execution, 'not_dispatched');
  assertNoActionHints(mutation);
  delete health.error.nextStep;
  await writeFile(healthPath, JSON.stringify(health));
  assert.deepEqual(await list(), failed, 'health diagnostics work with both old and current host records, without forwarding old hints');
  for (const override of [{ updatedAt: '2000-01-01T00:00:00Z' }, { configPath: join(root, 'other-host.json') }, { updatedAt: 'invalid' }]) {
    await writeFile(healthPath, JSON.stringify({ ...health, ...override }));
    assert.equal((await list()).reason, 'bridge_config_unavailable');
  }
  await writeFile(healthPath, JSON.stringify({ ...health, state: 'disabled' }));
  const disabled = await list(); assert.equal(disabled.availability, 'disabled');
  assert.equal(disabled.reason, 'browser_connector_disabled'); assertNoActionHints(disabled);
});

test('empty selection and invalid tab ids never become a phantom page zero', async () => {
  for (const listed of [{ pages: [], selectedPageId: null, selectionState: 'none' }, [{ id: null }, { id: false }, { id: '' }]]) {
    const server = createCardbushBrowserServer({ connector: async method => { assert.equal(method, 'tabs.list'); return listed; } });
    const result = await server._registeredTools.list_pages.handler({}, context);
    assert.deepEqual(result.structuredContent.pages, []);
    assert.equal(result.structuredContent.selectionState, 'none');
    assert.equal(result.structuredContent.selectedPageId, null);
    assert.equal(result.structuredContent.unavailablePageId, undefined);
  }
});

test('a lost external selection can be listed but never falls back, including after release', async () => {
  let available = [{ id: 1, active: true }, { id: 2, active: false }], commands = 0;
  const server = createCardbushBrowserServer({ connector: async (method, params) => {
    if (method === 'tabs.list') return available;
    if (method === 'tabs.close') { available = available.filter(page => page.id !== params.tabId); return { closed: true }; }
    if (method === 'tabs.activate') return { id: params.tabId };
    if (method === 'debugger.detachScope') return {};
    commands++; return { result: { value: 'selected explicitly' } };
  } });
  const call = (name, args = {}) => server._registeredTools[name].handler(args, context);
  assert.equal((await call('list_pages')).structuredContent.selectedPageId, 1);
  await call('close_page');
  available[0].active = true;
  for (let attempt = 0; attempt < 2; attempt++) {
    const listed = await call('list_pages');
    assert.equal(listed.isError, undefined);
    assert.deepEqual(listed.structuredContent.pages.map(page => page.id), [2]);
    assert.equal(listed.structuredContent.selectionState, 'missing');
    assert.equal(listed.structuredContent.selectedPageId, null);
    assert.equal((await call('evaluate_script', { expression: 'document.title' })).structuredContent.error.code, 'browser_page_missing');
    await call('release_browser');
  }
  assert.equal(commands, 0);
  await call('select_page', { pageId: 2 });
  assert.equal((await call('evaluate_script', { expression: 'document.title' })).structuredContent.value, 'selected explicitly');
  assert.equal(commands, 1);
});

test('an inherited missing CardBush target blocks implicit selection even without a local selection cache', async () => {
  const server = createCardbushBrowserServer({ connector: async method => {
    assert.equal(method, 'tabs.list');
    return { pages: [{ id: 2, active: true, browser: 'cardbush' }], selectedPageId: 1, selectionState: 'missing' };
  } });
  const listed = await server._registeredTools.list_pages.handler({}, context);
  assert.equal(listed.structuredContent.selectionState, 'missing');
  assert.equal(listed.structuredContent.unavailablePageId, 1);
  assert.equal((await server._registeredTools.evaluate_script.handler({ expression: 'document.title' }, context)).isError, true);
});

test('browser evaluation preserves native data and presents its JSON once to the model', async () => {
  const value = { rows: Array.from({ length: 10 }, (_, i) => ({ id: i, label: `unique-row-${i}` })) };
  const server = createCardbushBrowserServer({ connector: async method => method === 'tabs.list'
    ? [{ id: 42, active: true }] : { result: { value } } });
  const native = await server._registeredTools.evaluate_script.handler({ expression: 'readData()', resultType: 'json' }, context);
  const before = structuredClone(native);
  assert.deepEqual(JSON.parse(native.content[0].text), native.structuredContent);
  const projected = projectMcpResult(native);
  assert.deepEqual(JSON.parse(projected).structuredContent, { pageId: 42, value });
  assert.equal(projected.split('unique-row-0').length - 1, 1);
  assert.deepEqual(native, before);
});

test('resize reports failure before caching a viewport the page did not apply', async () => {
  const state = createBrowserUseState();
  let writes = 0;
  const server = createCardbushBrowserServer({ state, connector: async (method, params) => {
    if (method === 'tabs.list') return [{ id: 42, active: true }];
    if (params.command === 'Page.getLayoutMetrics') return { cssVisualViewport: { zoom: 1 } };
    if (params.command === 'Emulation.setDeviceMetricsOverride') { writes++; return {}; }
    return { result: { value: { width: 521, height: 882, deviceScaleFactor: 1 } } };
  } });
  const resized = await server._registeredTools.resize_page.handler({ width: 473, height: 800 }, context);
  assert.equal(resized.isError, true);
  assert.equal(resized.structuredContent.error.code, 'viewport_not_applied');
  assert.equal(resized.structuredContent.error.details.dimensions.width, 521);
  assert.equal(state.requestedViewports.size, 0);
  assert.equal(writes, 1, 'a mismatch does not start a hidden resize retry loop');
});
