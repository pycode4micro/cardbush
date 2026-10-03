import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { AgentDesktop } from '../dist-electron/agentDesktop.mjs';
import { AgentService } from '../dist-electron/agentService.mjs';
import { AgentRuntimeHost } from '../dist-electron/agentRuntimeHost.mjs';
import { serveAgentHttp } from '../dist-electron/agentServer.mjs';
import { ToolRegistry } from '../packages/bush-runtime/dist/index.js';
import { registerAgentDesktopTools } from '../dist-electron/agentDesktopTools.mjs';
import ts from 'typescript';

const image = { width: 1600, height: 900, mimeType: 'image/jpeg', data: 'fixture' };
const tabId = randomUUID();
function fixture() {
  const calls = [];
  let clock = 100_000, handler;
  const worker = { async request(operation, input) {
    calls.push({ operation, input });
    if (handler) return handler(operation, input);
    return operation === 'frame' ? image : { image, status: 'ok' };
  }, async close() { calls.push({ operation: 'close' }); } };
  const desktop = new AgentDesktop(worker, () => clock);
  const tool = (input, tool = 'computer', sessionId = 'a', turnId = '1', signal) => desktop.tool({ tool, input, sessionId, turnId }, signal);
  return { desktop, calls, tool, tick: ms => { clock += ms; }, handle: next => { handler = next; } };
}

test('observations are bound to tool, session, turn, tab and a single mutation', async () => {
  const f = fixture();
  const { stateId } = (await f.tool({ action: 'observe' })).structuredContent;
  const click = { action: 'click', stateId, x: 20, y: 30 };
  await assert.rejects(f.tool(click, 'computer', 'other'), /stale observation/);
  await assert.rejects(f.tool(click, 'computer', 'a', 'other'), /stale observation/);
  await assert.rejects(f.tool({ action: 'click', stateId, element: 0, tabId }, 'browser'), /stale observation/);
  await f.tool(click);
  await assert.rejects(f.tool(click), /stale observation/);
  assert.equal(f.calls.filter(call => call.input?.action === 'click').length, 1);
  const browserState = (await f.tool({ action: 'snapshot', tabId }, 'browser')).structuredContent.stateId;
  await assert.rejects(f.tool({ action: 'close', stateId: browserState, tabId: randomUUID() }, 'browser'), /stale observation/);
  await f.tool({ action: 'close', stateId: browserState, tabId }, 'browser');
});

test('expiry, another observation, malformed action and unsafe URL cannot use an old state', async () => {
  const f = fixture();
  let stateId = (await f.tool({ action: 'observe' })).structuredContent.stateId;
  f.tick(15001);
  await assert.rejects(f.tool({ action: 'key', stateId, key: 'Return' }), /stale/);
  stateId = (await f.tool({ action: 'observe' })).structuredContent.stateId;
  await f.tool({ action: 'observe' }, 'computer', 'another');
  await assert.rejects(f.tool({ action: 'key', stateId, key: 'Return' }), /stale/);
  const before = f.calls.length;
  await assert.rejects(f.tool({ action: 'open', url: 'file:///etc/passwd' }, 'browser'));
  await assert.rejects(f.tool({ action: 'open' }, 'browser'), /url is required/);
  await assert.rejects(f.tool({ action: 'key', tabId }, 'browser'), /key is required/);
  await assert.rejects(f.tool({ action: 'open', url: 'https://secret:pass@example.com' }, 'browser'));
  await assert.rejects(f.tool({ action: 'click', x: -1, y: 0 }));
  assert.equal(f.calls.length, before);
});

test('takeover blocks both tools; leases are exclusive, renewable and expire without a viewer', async () => {
  const f = fixture();
  const lease = await f.desktop.call('take', {});
  await assert.rejects(f.desktop.call('take', {}), /Another viewer/);
  await assert.rejects(f.tool({ action: 'observe' }), /user has taken control/);
  await assert.rejects(f.tool({ action: 'open', url: 'https://example.com' }, 'browser'), /user has taken control/);
  await assert.rejects(f.desktop.call('frame', { token: randomUUID() }), /control expired/);
  const frame = await f.desktop.call('frame', { token: lease.token });
  await f.desktop.call('input', { token: lease.token, frameId: frame.frameId, event: { action: 'click', x: 1599, y: 899 } });
  f.tick(19_000);
  await f.desktop.call('frame', { token: lease.token });
  f.tick(19_000);
  assert.equal(f.desktop.status().control, 'user');
  f.tick(1001);
  assert.equal(f.desktop.status().control, 'agent');
  await assert.rejects(f.desktop.call('input', { token: lease.token, frameId: frame.frameId, event: { action: 'key', key: 'Return' } }), /control expired/);
  await f.tool({ action: 'observe' });
});

test('viewer input needs its own fresh frame, original dimensions and valid lease', async () => {
  const f = fixture();
  const unownedFrame = await f.desktop.call('frame', {});
  const lease = await f.desktop.call('take', {});
  const input = frameId => ({ token: lease.token, frameId, event: { action: 'click', x: 10, y: 15 } });
  await assert.rejects(f.desktop.call('input', input(unownedFrame.frameId)), /frame is stale/);
  const frame = await f.desktop.call('frame', { token: lease.token });
  await assert.rejects(f.desktop.call('input', { ...input(frame.frameId), event: { action: 'click', x: 1600, y: 0 } }), /outside/);
  await assert.rejects(f.desktop.call('input', { ...input(frame.frameId), event: { action: 'drag', x: 0, y: 0, toX: 0, toY: 900 } }), /outside/);
  await f.desktop.call('input', input(frame.frameId));
  assert.deepEqual(f.calls.at(-1).input, { action: 'click', x: 10, y: 15, width: 1600, height: 900 });
  f.tick(5001);
  await assert.rejects(f.desktop.call('input', input(frame.frameId)), /frame is stale/);
  await f.desktop.call('release', { token: lease.token });
  await assert.rejects(f.desktop.call('input', input(frame.frameId)), /control expired/);
});

test('takeover waits for a dispatched operation and preempts queued Agent actions', async () => {
  const f = fixture();
  let finish;
  f.handle(() => new Promise(resolve => { finish = () => resolve({ image }); }));
  const running = f.tool({ action: 'observe' });
  await new Promise(resolve => setImmediate(resolve));
  const queued = f.tool({ action: 'open', url: 'https://example.com' }, 'browser');
  const rejection = assert.rejects(queued, /user has taken control/);
  let granted = false;
  const takeover = f.desktop.call('take', {}).then(value => { granted = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(granted, false);
  finish();
  await running; await rejection; await takeover;
  assert.equal(f.calls.length, 1);
  assert.equal(granted, true);
});

test('abort before dispatch and uncertain worker outcomes never replay actions', async () => {
  const f = fixture();
  const abort = new AbortController(); abort.abort();
  await assert.rejects(f.tool({ action: 'observe' }, 'computer', 'a', '1', abort.signal), { name: 'AbortError' });
  assert.equal(f.calls.length, 0);
  f.handle(() => { throw new Error('Desktop operation timed out; outcome unknown.'); });
  await assert.rejects(f.tool({ action: 'open', url: 'https://example.com' }, 'browser'), /outcome unknown/);
  assert.equal(f.desktop.status().available, false);
  await assert.rejects(f.desktop.call('frame', {}), /outcome unknown/);
  assert.equal(f.calls.length, 1);
});

test('registered tools use private RPC with host-supplied session and turn, preserving original images', async () => {
  const registry = new ToolRegistry(); const requests = [];
  registerAgentDesktopTools(registry, { request(...args) { requests.push(args); return Promise.resolve({ ok: true }); } });
  assert.deepEqual(registry.definitions().map(item => item.name), ['linux_computer_use', 'linux_browser_use']);
  const tool = registry.resolve('linux_computer_use');
  await tool.execute({ sessionId: 'real', turnId: 'turn', input: tool.decodeInput({ action: 'observe' }) });
  assert.deepEqual(requests[0].slice(0, 2), ['agent.desktop.tool', { sessionId: 'real', turnId: 'turn', tool: 'computer', input: { action: 'observe' } }]);
  assert.equal(tool.parallelSafe, false);
  assert.throws(() => tool.decodeInput({ action: 'observe', sessionId: 'spoofed' }));
  const result = await fixture().tool({ action: 'observe' });
  assert.equal(result.content[1]._meta['codex/imageDetail'], 'original');
});

test('preview coordinates account for letterboxing, scaling, position and edges', async () => {
  const source = await readFile(new URL('../src/features/agents/agentDesktopCoordinates.ts', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
  const { desktopPoint } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
  const rect = { left: 100, top: 50, width: 800, height: 800 };
  assert.deepEqual(desktopPoint(500, 450, rect, image), { x: 800, y: 450 });
  assert.equal(desktopPoint(500, 60, rect, image), null);
  assert.equal(desktopPoint(900, 450, rect, image), null);
  assert.deepEqual(desktopPoint(100, 225, rect, image), { x: 0, y: 0 });
});

test('the shared Node Runtime exposes desktop tools only for the explicit service capability', { timeout: 45000 }, async () => {
  const base = resolve('tmp/agent-desktop-tests'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'worker-'));
  const runtime = new AgentRuntimeHost({ ...process.env, CARDBUSH_SERVICE_ID: 'desktop-contract-test', CARDBUSH_AGENT_DESKTOP: '1',
    CARDBUSH_RUNTIME_STATE_ROOT: root, CARDBUSH_RUNTIME_PLUGIN_ROOTS: '[]', CARDBUSH_RUNTIME_SKILL_ROOTS: '[]',
    CARDBUSH_MCP_DESKTOP_BRIDGE: undefined, CARDBUSH_APPS_MCP_ENTRY: undefined }, async operation => {
    if (operation === 'network.configuration') return { mode: 'system' };
    throw Error(`Unexpected host request ${operation}`);
  });
  try {
    await runtime.ready;
    const catalog = await runtime.transport.sendCommand({ kind: 'runtime.get_tool_catalog', payload: {} });
    const names = catalog.map(tool => tool.name);
    assert.ok(names.includes('linux_computer_use'));
    assert.ok(names.includes('linux_browser_use'));
    assert.equal(names.includes('open_external_url'), false);
  } finally { await runtime.close(); assert.ok(root.startsWith(base)); await rm(root, { recursive: true, force: true, maxRetries: 3 }); }
});

test('default real Agent remains headless despite DISPLAY and inherited desktop flags', { timeout: 45000 }, async () => {
  const base = resolve('tmp/agent-desktop-tests'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'headless-'));
  const service = await AgentService.open({ dataRoot: root, env: { DISPLAY: ':99', CARDBUSH_AGENT_DESKTOP: '1' } });
  let http;
  try {
    for (const key of ['desktop', 'computerUse', 'browserUi']) assert.equal(service.info().capabilities[key], false);
    await assert.rejects(service.call('desktop.frame'), /Desktop is disabled/);
    const catalog = await service.call('runtime.command', { kind: 'runtime.get_tool_catalog', payload: {} });
    assert.doesNotMatch(JSON.stringify(catalog), /linux_computer_use|linux_browser_use/);
    const token = 'fixture-only-'.padEnd(40, 'x');
    http = await serveAgentHttp(service, { host: '127.0.0.1', port: 0, token });
    const url = `http://127.0.0.1:${http.port}/api/agent/v1/call`;
    const request = headers => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ operation: 'desktop.take', input: {} }) });
    assert.equal((await request({})).status, 401);
    assert.equal((await request({ authorization: `Bearer ${token}`, origin: 'null' })).status, 401);
    assert.match(await (await request({ authorization: `Bearer ${token}` })).text(), /Desktop is disabled/);
  } finally { await http?.close(); await service.close(); assert.ok(root.startsWith(base)); await rm(root, { recursive: true, force: true, maxRetries: 3 }); }
});
