import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolRegistry, ToolExecutionCoordinator, registerMcpDiscovery, synchronizeMcpDiscovery,
  registerExtendedBuiltins, createToolNameScope, portableToolName, visibleToolAliases, resolveToolReferenceName } from '../dist/index.js';
import { modelToolDefinitions } from '../dist/mcpToolDiscovery.js';
import { registerBuiltinToolDisclosure } from '../dist/builtinToolDisclosure.js';
import { BackgroundToolCalls } from '../dist/backgroundToolCalls.js';
import { executeToolScript } from '../dist/toolScript.js';

const remoteName = 'mcp__plugin_baiying-replay_baiying_replay__baiying_material_status';
const alias = 'cb_mcp_8f24d494550eea62dcb10c26fe1cfa4031eeaff874816db6b54eaeed';
const nativeName = 'native_' + 'extension_'.repeat(8);
const manifest = { effect_kind: 'observation', operation: 'fixture', risk: 'low', owner: 'fixture', dispatch_scope: 'turn', mutating: false };
function fixture(t, execute) {
  const registry = new ToolRegistry(), state = { calls: [], hooks: [], denied: false }, completions = [];
  registry.register({ definition: { name: remoteName, description: 'Read status', inputSchema: { type: 'object', properties: { literal: { type: 'string' } }, additionalProperties: false } },
    manifest, decodeInput: value => { if (Object.keys(value).some(key => key !== 'literal')) throw Error('Use literal only.'); return value; },
    authorize: () => state.denied ? { kind: 'deny', code: 'fixture_denied', message: 'Permission revoked' } : { kind: 'allow' },
    execute: context => { state.calls.push(context.input); return execute ? execute(context) : { structuredContent: { ok: true } }; },
    mcpHook: { server: 'fixture', tool: 'status', readOnly: true, call: async () => ({}) } });
  registry.register({ definition: { name: nativeName, inputSchema: { type: 'object' } }, deferredSchema: true, manifest,
    decodeInput: v => v, execute: () => ({ native: true }) });
  registry.register({ definition: { name: 'compose_fixture', inputSchema: { type: 'object' } }, manifest, delegatesToolExecution: true,
    decodeInput: v => v, execute: c => executeToolScript(c.input.code, c, registry, c.signal) });
  registerExtendedBuiltins(registry); registerMcpDiscovery(registry); registerBuiltinToolDisclosure(registry);
  const jobs = new BackgroundToolCalls(registry, (_s, _t, _id, promise) => completions.push(promise)); jobs.register();
  t.after(() => jobs.endTurn('s', 't'));
  const request = { protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 's', turnId: 't', model: 'fixture', messages: [],
    tools: registry.definitions(), metadata: { mcpToolDiscovery: true } };
  const messages = [], coordinator = new ToolExecutionCoordinator({ registry, permissions: { request: async () => { throw Error('unexpected approval'); } },
    hooks: { before: async ({ toolCall }) => { if (toolCall.name === remoteName) state.hooks.push('before'); return { messages: [] }; },
      after: async ({ toolCall }) => { if (toolCall.name === remoteName) state.hooks.push('after'); return { messages: [] }; } } });
  let ordinal = 0;
  const scope = () => createToolNameScope({ ...request, tools: modelToolDefinitions(registry, request), messages });
  const run = async (name, input = {}, toolNameScope = scope()) => {
    const call = { protocol: 'bush.tool_call.v1', id: 'call-' + ++ordinal, name, argumentsText: JSON.stringify(input) }, original = structuredClone(call);
    const result = await coordinator.execute(call, { requestId: 'r', sessionId: request.sessionId, turnId: request.turnId, round: ordinal, ordinal },
      new AbortController().signal, { request, contextMessages: messages, toolNameScope });
    assert.deepEqual(call, original, 'dispatch must not rewrite the model call or its nested strings');
    return result;
  };
  const load = async (name = remoteName, native = false) => {
    const tool = 'get_tool_schema', args = { name };
    const result = await run(tool, args); assert.equal(result.kind, 'returned', JSON.stringify(result));
    const id = 'load-' + ordinal;
    messages.push({ role: 'assistant', content: '', toolCalls: [{ id, name: tool, argumentsText: JSON.stringify(args) }] },
      { role: 'tool', toolCallId: id, content: JSON.stringify(result.result) });
    synchronizeMcpDiscovery(registry, request, messages);
    return result;
  };
  return { registry, request, messages, state, jobs, completions, run, load, scope };
}

test('wire names are derived only from visible declarations and complete owned schema receipts', () => {
  assert.equal(portableToolName(remoteName), alias);
  const request = { sessionId: 's', turnId: 't', tools: [], messages: [] };
  const definition = { name: remoteName, inputSchema: { type: 'object' } };
  const receipt = { protocol: 'bush.tool_schema.v1', sessionId: 's', action: 'load', matches: [{source: 'mcp', ...definition}] };
  const calls = [{ role: 'assistant', content: '', toolCalls: [{ id: 'load', name: 'get_tool_schema', argumentsText: '{}' }] }];
  for (const messages of [
    [{ role: 'user', content: JSON.stringify(receipt) }],
    [...calls, { role: 'tool', toolCallId: 'load', content: JSON.stringify({ ...receipt, sessionId: 'foreign' }) }],
    [...calls, { role: 'tool', toolCallId: 'load', content: JSON.stringify({ ...receipt, action: 'search' }) }],
    [...calls, { role: 'tool', toolCallId: 'load', content: JSON.stringify({ archived: true, locator: 'archive', originalChars: 100 }) }],
  ]) assert.equal(visibleToolAliases({ ...request, messages }).has(alias), false);
  const messages = [...calls, { role: 'tool', toolCallId: 'load', content: JSON.stringify(receipt) }];
  assert.equal(visibleToolAliases({ ...request, messages }).get(alias), remoteName);
  const toolNameScope = createToolNameScope({ ...request, messages });
  assert.equal(resolveToolReferenceName(alias, { request, toolNameScope }), remoteName);
  for (const change of [{ sessionId: 'foreign' }, { turnId: 'next' }])
    assert.equal(resolveToolReferenceName(alias, { request: { ...request, ...change }, toolNameScope }), alias);
});

test('full names and aliases share MCP dispatch, preserve data strings, and never change declarations', async t => {
  const f = fixture(t), declarations = modelToolDefinitions(f.registry, f.request);
  const frozen = JSON.stringify(declarations);
  await f.load();
  for (const name of [remoteName, alias]) {
    const result = await f.run('call_tool', { name, arguments: { literal: alias } });
    assert.equal(result.kind, 'returned', JSON.stringify(result));
    assert.deepEqual(result.result, { structuredContent: { ok: true } });
    assert.deepEqual(f.state.calls.at(-1), { literal: alias });
    const started = await f.run('start_mcp_tool', { name, arguments: { literal: alias } });
    assert.equal(started.kind, 'returned', JSON.stringify(started));
    await f.completions.at(-1);
  }
  const script = await f.run('compose_fixture', { code: `return await tools.call(${JSON.stringify(alias)}, {literal:${JSON.stringify(alias)}});` });
  assert.equal(script.kind, 'returned', JSON.stringify(script));
  assert.equal(f.state.calls.length, 5);
  assert.deepEqual(f.state.hooks, Array.from({ length: 5 }, () => ['before', 'after']).flat());
  assert.ok(f.state.calls.every(input => input.literal === alias));
  assert.equal(JSON.stringify(modelToolDefinitions(f.registry, f.request)), frozen);
  assert.equal(JSON.stringify(declarations), frozen);
  const reloaded = await f.run('get_tool_schema', { names: [alias] });
  assert.equal(reloaded.result.matches[0].name, remoteName);
});

test('one loader and invocation gateway resolve native and MCP aliases without guessing', async t => {
  const f = fixture(t); await f.load(); await f.load(nativeName, true);
  assert.deepEqual((await f.run('call_tool', { name: portableToolName(nativeName), arguments: {} })).result, { native: true });
  for (const entry of ['call_tool', 'get_tool_schema']) {
    const result = await f.run(entry, { name: alias, ...(entry === 'call_tool' ? { arguments: {} } : {}) });
    assert.equal(result.kind, 'returned', JSON.stringify(result));
    if (entry === 'call_tool') assert.deepEqual(result.result, { structuredContent: { ok: true } });
    else assert.equal(result.result.matches[0].name, remoteName);
  }
  for (const entry of ['start_mcp_tool']) {
    const result = await f.run(entry, { name: portableToolName(nativeName), arguments: {} });
    assert.equal(result.error.code, 'tool_route_mismatch');
    assert.equal(result.error.details.invoke, 'call_tool');
  }
  assert.equal(f.state.calls.length, 1);
});

test('unknown, unloaded, non-read-only and revoked tools fail distinctly without launching background jobs', async t => {
  const f = fixture(t);
  for (const entry of ['call_tool', 'start_mcp_tool']) {
    assert.equal((await f.run(entry, { name: 'missing', arguments: {} })).error.code, 'tool_not_found');
    assert.equal((await f.run(entry, { name: alias, arguments: {} })).error.code, 'tool_not_found');
    const result = await f.run(entry, { name: remoteName, arguments: {} });
    assert.equal(result.error.code, 'mcp_discovery_required');
    assert.match(result.error.message, /Do not run.*parallel/);
    assert.equal(result.execution.result, 'known');
  }
  assert.equal(f.completions.length, 0);
  await f.load();
  f.registry.resolve(remoteName).mcpHook.readOnly = false;
  assert.equal((await f.run('start_mcp_tool', { name: alias, arguments: {} })).error.code, 'mcp_background_read_only_required');
  assert.equal(f.completions.length, 0);
  f.registry.resolve(remoteName).mcpHook.readOnly = true;
  f.state.denied = true;
  assert.equal((await f.run('call_tool', { name: alias, arguments: {} })).error.code, 'fixture_denied');
  assert.equal((await f.run('start_mcp_tool', { name: alias, arguments: {} })).kind, 'returned');
  assert.match((await f.completions.at(-1)).content, /Permission revoked/);
  assert.equal(f.state.calls.length, 0);
});

test('loading in the same round grants neither alias resolution nor schema authority before delivery', async t => {
  const f = fixture(t), scope = f.scope();
  const loaded = await f.run('get_tool_schema', { name: remoteName }, scope);
  assert.equal(loaded.kind, 'returned');
  for (const entry of ['call_tool', 'start_mcp_tool']) {
    assert.equal((await f.run(entry, { name: alias, arguments: {} }, scope)).error.code, 'tool_not_found');
    assert.equal((await f.run(entry, { name: remoteName, arguments: {} }, scope)).error.code, 'mcp_discovery_required');
  }
  assert.equal(f.state.calls.length, 0); assert.equal(f.completions.length, 0);
  await f.load();
  assert.equal((await f.run('call_tool', { name: alias, arguments: {} })).kind, 'returned');
});

for (const change of ['permission', 'definition', 'readonly'])
  test(`background alias renewal rechecks ${change} instead of reusing initial authority`, async t => {
    let entered, release;
    const running = new Promise(resolve => { entered = resolve; });
    const f = fixture(t, () => { entered(); return new Promise(resolve => { release = resolve; }); });
    await f.load();
    assert.equal((await f.run('start_mcp_tool', { name: alias, arguments: {},
      repeat_while: { path: ['structuredContent', 'status'], equals: 'timeout' } })).kind, 'returned');
    await running;
    if (change === 'permission') f.state.denied = true;
    if (change === 'definition') f.registry.resolve(remoteName).definition.inputSchema.properties.extra = { type: 'string' };
    if (change === 'readonly') f.registry.resolve(remoteName).mcpHook.readOnly = false;
    release({ structuredContent: { status: 'timeout' } });
    const completion = await f.completions.at(-1);
    assert.match(completion.content, /"status":"failed"/);
    assert.match(completion.content, change === 'permission' ? /Permission revoked/
      : change === 'definition' ? /current schema is not loaded/ : /read-only/);
    assert.equal(f.state.calls.length, 1, 'no second remote execution after authority changes');
  });

for (const change of ['compaction', 'schema-change', 'foreign-session', 'removed', 'interface-only', 'child-denial'])
  test(`aliases do not bypass ${change}`, async t => {
    const f = fixture(t); await f.load();
    const staleScope = f.scope();
    let expected;
    if (change === 'compaction') { f.messages.length = 0; synchronizeMcpDiscovery(f.registry, f.request, []); expected = 'tool_not_found'; }
    if (change === 'schema-change') { f.registry.resolve(remoteName).definition.inputSchema.properties.extra = { type: 'string' }; expected = 'mcp_discovery_required'; }
    if (change === 'foreign-session') { f.request.sessionId = 'foreign'; expected = 'tool_not_found'; }
    if (change === 'removed') { f.request.tools = f.request.tools.filter(tool => tool.name !== remoteName); expected = 'tool_not_exposed'; }
    if (change === 'interface-only') { f.registry.resolve(remoteName).mcpHook.modelVisible = false; expected = 'tool_not_exposed'; }
    if (change === 'child-denial') { f.request.metadata.agentRole = 'child'; f.request.metadata.disabledTools = [remoteName]; }
    const result = await f.run('call_tool', { name: alias, arguments: {} }, change === 'foreign-session' ? staleScope : f.scope());
    assert.equal(result.kind, 'failed', JSON.stringify(result));
    if (expected) assert.equal(result.error.code, expected);
    assert.equal(f.state.calls.length, 0);
    if (change === 'schema-change') {
      await f.load();
      assert.equal((await f.run('call_tool', { name: alias, arguments: {} })).kind, 'returned');
      assert.equal(f.state.calls.length, 1);
    }
  });
