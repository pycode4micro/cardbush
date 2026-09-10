import test from 'node:test';
import assert from 'node:assert/strict';
import { McpClientManager } from '../dist/index.js';
import { ToolRegistry } from '@cardbush/bush-runtime';

function fixture(respond) {
  const registry = new ToolRegistry(); const calls = [];
  const transport = { async start() {}, async close() {}, async send(message) {
    if (!('id' in message)) return;
    let response;
    if (message.method === 'server/discover') response = { error: { code: -32601, message: 'Legacy fixture' } };
    else if (message.method === 'initialize') response = { result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } };
    else if (message.method === 'tools/list') response = { result: { tools: [{ name: 'read', inputSchema: { type: 'object' } }] } };
    else if (message.method === 'tools/call') { calls.push(message.params); response = await respond(message.params); }
    else throw Error('Unexpected test method ' + message.method);
    queueMicrotask(() => transport.onmessage?.({ jsonrpc: '2.0', id: message.id, ...response }));
  } };
  const manager = new McpClientManager({ registry, createTransport: () => transport });
  const config = { protocol: 'bush.mcp_snapshot.v2', snapshotId: 'fixture', revision: 1, servers: [{
    id: 'fixture', name: 'fixture', enabled: true, required: false,
    transport: { kind: 'stdio', command: 'in-memory-test-no-process', args: [], env: {} },
    defaultToolPolicy: { permission: 'allow', parallelSafe: true, visibleToChild: true }, toolPolicies: {},
  }] };
  return { registry, manager, config, calls };
}

test('stdio invalid structured content preserves the exact received result without retrying', async t => {
  const raw = { content: [{ type: 'text', text: 'Server completed the operation.' }], structuredContent: null, _meta: { original: true } };
  const f = fixture(() => ({ result: raw })); t.after(() => f.manager.close());
  assert.equal((await f.manager.apply(f.config)).servers[0].health, 'ready', JSON.stringify(f.manager.snapshot()));
  const tool = f.registry.resolve('mcp__fixture__read');
  await assert.rejects(tool.execute({ sessionId: 's', turnId: 't', requestId: 'r', input: {}, toolCall: { id: 'c' } }), error => {
    assert.equal(error.code, 'mcp_protocol_error');
    assert.equal(error.details.resultValidationFailed, true);
    assert.deepEqual(error.details.rawResult, raw);
    assert.match(error.message, /does not establish/);
    return true;
  });
  assert.equal(f.calls.length, 1);
  assert.equal(f.manager.snapshot().servers[0].health, 'ready');
});

test('concurrent replies retain their own raw results, including out-of-order failures', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(async params => {
    if (params.arguments.key === 'slow') await gate; else release();
    return { result: { content: [{ type: 'text', text: params.arguments.key }], structuredContent: null } };
  }); t.after(() => f.manager.close()); assert.equal((await f.manager.apply(f.config)).servers[0].health, 'ready', JSON.stringify(f.manager.snapshot()));
  const tool = f.registry.resolve('mcp__fixture__read');
  const outcomes = await Promise.all(['slow', 'fast'].map(key => tool.execute({ sessionId: 's', turnId: 't', requestId: key,
    input: { key }, toolCall: { id: key } }).catch(error => error)));
  assert.deepEqual(outcomes.map(error => error.details.rawResult.content[0].text), ['slow', 'fast']);
  assert.equal(f.calls.length, 2);
});

test('valid native errors remain native and JSON-RPC errors do not acquire invented results', async t => {
  const raw = { isError: true, content: [{ type: 'text', text: 'Native business error' }], _meta: { opaque: 'unchanged' } };
  const f = fixture(params => params.arguments.rpc ? { error: { code: -32602, message: 'Server rejected arguments' } } : { result: raw });
  t.after(() => f.manager.close()); assert.equal((await f.manager.apply(f.config)).servers[0].health, 'ready', JSON.stringify(f.manager.snapshot()));
  const tool = f.registry.resolve('mcp__fixture__read');
  const invoke = input => tool.execute({ sessionId: 's', turnId: 't', requestId: 'r', input, toolCall: { id: 'c' } });
  assert.deepEqual(await invoke({}), raw);
  await assert.rejects(invoke({ rpc: true }), error => !Object.hasOwn(error.details, 'rawResult'));
  assert.equal(f.calls.length, 2);
});

test('a cancelled call cannot acquire a late result or contaminate the following call', async t => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const begun = new Promise(resolve => { started = resolve; });
  const f = fixture(async params => {
    if (params.arguments.cancel) { started(); await gate; }
    return { result: { content: [{ type: 'text', text: params.arguments.cancel ? 'late' : 'next' }], structuredContent: null } };
  });
  t.after(() => f.manager.close()); await f.manager.apply(f.config);
  const tool = f.registry.resolve('mcp__fixture__read'), controller = new AbortController();
  const pending = tool.execute({ sessionId: 's', turnId: 't', requestId: 'cancel', input: { cancel: true },
    signal: controller.signal, toolCall: { id: 'cancel' } }).catch(error => error);
  await begun; controller.abort(); release();
  const error = await pending;
  assert.ok(error instanceof Error);
  assert.equal(error.details?.resultValidationFailed, undefined);
  await assert.rejects(tool.execute({ sessionId: 's', turnId: 't', requestId: 'next', input: {}, toolCall: { id: 'next' } }),
    error => error.details?.rawResult?.content?.[0]?.text === 'next');
  assert.equal(f.calls.length, 2);
  assert.equal(f.manager.snapshot().servers[0].health, 'ready');
});
