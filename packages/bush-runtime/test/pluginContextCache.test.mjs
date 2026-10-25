import { registerBuiltinToolDisclosure } from '../dist/builtinToolDisclosure.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { CacheChainTracker, FileSessionEventPersistence, InMemoryRuntimeHost, SessionStore, ToolRegistry, ToolExecutionCoordinator } from '../dist/index.js';
import { clearMcpDiscovery, modelToolDefinitions, registerMcpDiscovery, synchronizeMcpDiscovery as synchronize } from '../dist/mcpToolDiscovery.js';

const synchronizeMcpDiscovery = (registry, request, messages) => {
  request.messages = messages;
  synchronize(registry, request, messages);
};

const manifest = { effect_kind: 'observation', operation: 'fixture.read', risk: 'low', owner: 'runtime', dispatch_scope: 'parent_session', mutating: false };
const toolName = 'mcp__docs__lookup';
const mcp = (overrides = {}) => ({ definition: { name: toolName, description: 'Search project documentation', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }, manifest, decodeInput: input => input, execute: () => ({ found: true }),
  mcpHook: { server: 'docs', tool: 'lookup', call: async () => ({}) }, ...overrides });
const modelRequest = (registry, overrides = {}) => ({ protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 's', turnId: 't', model: 'fixture', permissionMode: 'task_free', tools: registry.definitions(), messages: [], metadata: { mcpToolDiscovery: true }, ...overrides });
const sessionRequest = (registry, turnId, metadata = {}) => ({ protocol: 'bush.session_turn_request.v1', requestId: `r-${turnId}`, sessionId: 's', turnId, model: 'fixture', permissionMode: 'task_free', tools: registry.definitions(), prefixMessages: [{ role: 'developer', content: 'Stable instructions' }], inputMessages: [{ messageId: `user-${turnId}`, message: { role: 'user', content: 'Continue the task' } }], metadata });
const runner = registry => new ToolExecutionCoordinator({ registry, permissions: { request: async () => { throw Error('Unexpected permission request'); } } });
let serial = 0;
const call = (coordinator, request, name, args = {}) => coordinator.execute({ protocol: 'bush.tool_call.v1', id: `c-${++serial}`, name, argumentsText: JSON.stringify(args) }, { ...request, round: 1, ordinal: serial }, undefined, { request, contextMessages: request.messages });
const searchMessages = (result, id = `search-${++serial}`) => [{ role: 'assistant', content: '', toolCalls: [{ id, name: 'get_tool_schema', argumentsText: JSON.stringify({ name: toolName }) }] }, { role: 'tool', toolCallId: id, content: JSON.stringify(result) }];
async function temp(t) { const root = await mkdtemp(join(tmpdir(), 'cardbush-plugin-cache-')); t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'cardbush-plugin-cache-')); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }); return root; }

test('discovery survives turns/restart without resending schemas, but not compaction or scope changes', async () => {
  const registry = new ToolRegistry(); registerMcpDiscovery(registry); registerBuiltinToolDisclosure(registry); registry.register(mcp());
  const initial = modelRequest(registry), coordinator = runner(registry);
  const searched = await call(coordinator, initial, 'get_tool_schema', { name: toolName });
  const history = searchMessages(searched.result), original = structuredClone(history);
  clearMcpDiscovery(registry, initial);
  const next = modelRequest(registry, { turnId: 'next', messages: history });
  synchronizeMcpDiscovery(registry, next, history);
  assert.equal((await call(coordinator, next, 'call_tool', { name: toolName, arguments: {} })).kind, 'returned');
  const repeated = await call(coordinator, next, 'mcp_search', { query: 'docs' });
  assert.equal(repeated.result.matches[0].loaded, true);
  assert.equal(repeated.result.matches[0].inputSchema, undefined);
  assert.equal((await call(coordinator, next, 'get_tool_schema', { name: toolName })).result.matches[0].inputSchema.type, 'object');
  assert.deepEqual(history, original);

  const restarted = new ToolRegistry(); registerMcpDiscovery(restarted); registerBuiltinToolDisclosure(restarted); restarted.register(mcp());
  const recovered = modelRequest(restarted, { turnId: 'recovered', messages: history });
  synchronizeMcpDiscovery(restarted, recovered, history);
  assert.equal((await call(runner(restarted), recovered, 'call_tool', { name: toolName, arguments: {} })).kind, 'returned');
  // A compact reference is insufficient when the original full schema was summarized away.
  const compacted = searchMessages(repeated.result);
  synchronizeMcpDiscovery(restarted, recovered, compacted);
  assert.equal((await call(runner(restarted), recovered, 'call_tool', { name: toolName, arguments: {} })).error.code, 'mcp_discovery_required');
  assert.ok((await call(runner(restarted), recovered, 'get_tool_schema', { name: toolName })).result.matches[0].inputSchema);
  const other = modelRequest(registry, { sessionId: 'other', messages: history });
  synchronizeMcpDiscovery(registry, other, history);
  assert.equal((await call(coordinator, other, 'call_tool', { name: toolName, arguments: {} })).kind, 'failed');
  const restricted = modelRequest(registry, { turnId: 'restricted', messages: history, tools: registry.definitions().filter(tool => tool.name !== toolName) });
  synchronizeMcpDiscovery(registry, restricted, history);
  assert.equal((await call(coordinator, restricted, 'call_tool', { name: toolName, arguments: {} })).kind, 'failed');
});

test('schema updates reload only changed definitions while permissions and connections remain live', async () => {
  const registry = new ToolRegistry(); registerMcpDiscovery(registry); registerBuiltinToolDisclosure(registry); registry.replaceOwned('docs', [mcp()]);
  const request = modelRequest(registry), coordinator = runner(registry);
  const first = await call(coordinator, request, 'get_tool_schema', { name: toolName });
  const history = searchMessages(first.result), projection = modelToolDefinitions(registry, request);
  const tracker = new CacheChainTracker(); tracker.observe({ ...request, tools: projection, messages: history });
  const changed = mcp({ definition: { ...mcp().definition, description: 'Search updated documentation', inputSchema: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] } } });
  registry.replaceOwned('docs', [changed]);
  assert.equal((await call(coordinator, request, 'call_tool', { name: toolName, arguments: {} })).error.code, 'mcp_discovery_required');
  synchronizeMcpDiscovery(registry, request, history);
  const second = await call(coordinator, request, 'get_tool_schema', { name: toolName });
  assert.deepEqual(second.result.matches[0].inputSchema.required, ['topic']);
  assert.notEqual(first.result.matches[0].revision, second.result.matches[0].revision);
  const appended = [...history, ...searchMessages(second.result)];
  assert.equal(tracker.observe({ ...request, tools: modelToolDefinitions(registry, request), messages: appended }).frozenPrefixBreak, false);
  registry.replaceOwned('docs', [mcp({ ...changed, authorize: () => ({ kind: 'deny', code: 'revoked', message: 'Permission revoked' }) })]);
  synchronizeMcpDiscovery(registry, request, appended);
  assert.equal((await call(coordinator, request, 'call_tool', { name: toolName, arguments: { topic: 'a' } })).error.code, 'revoked');
  registry.removeOwned('docs');
  assert.equal((await call(coordinator, request, 'call_tool', { name: toolName, arguments: {} })).kind, 'failed');
  assert.deepEqual(modelToolDefinitions(registry, request), projection);
  const empty = modelRequest(registry, { turnId: 'empty' });
  assert.deepEqual(modelToolDefinitions(registry, empty), projection);
});

test('replacing an MCP connection during approval prevents executing the captured old connection', async () => {
  const registry = new ToolRegistry(); registerMcpDiscovery(registry); registerBuiltinToolDisclosure(registry);
  let executed = 0;
  registry.replaceOwned('docs', [mcp({ execute: () => { executed++; return {}; }, authorize: () => ({ kind: 'ask', request: { reason: 'Read docs', actions: ['read'], targets: [], capabilityIds: [] } }) })]);
  const request = modelRequest(registry);
  const coordinator = new ToolExecutionCoordinator({ registry, permissions: { request: async () => { registry.replaceOwned('docs', [mcp()]); return { decision: 'allow', grantedCapabilityIds: [] }; } } });
  const searched = await call(coordinator, request, 'get_tool_schema', { name: toolName });
  synchronizeMcpDiscovery(registry, request, searchMessages(searched.result));
  assert.equal((await call(coordinator, request, 'call_tool', { name: toolName, arguments: {} })).error.code, 'tool_definition_changed');
  assert.equal(executed, 0);
});

test('archived/rewritten tool output cannot count as a visible schema', async () => {
  const registry = new ToolRegistry(); registerMcpDiscovery(registry); registerBuiltinToolDisclosure(registry); registry.register(mcp());
  const request = modelRequest(registry), coordinator = runner(registry);
  const searched = await call(coordinator, request, 'get_tool_schema', { name: toolName });
  const messages = searchMessages(searched.result);
  messages[1].content = JSON.stringify({ archived: true, preview: JSON.stringify(searched.result) });
  synchronizeMcpDiscovery(registry, request, messages);
  assert.equal((await call(coordinator, request, 'call_tool', { name: toolName, arguments: {} })).kind, 'failed');
  messages[1].content = JSON.stringify({ ...searched.result, matches: searched.result.matches.map(match => ({ ...match, inputSchema: { type: 'object' } })) });
  synchronizeMcpDiscovery(registry, request, messages);
  assert.equal((await call(coordinator, request, 'call_tool', { name: toolName, arguments: {} })).kind, 'failed');
});

test('a large archived schema becomes reusable only after all exact chunks are visible', async () => {
  const registry = new ToolRegistry(); registerMcpDiscovery(registry); registerBuiltinToolDisclosure(registry);
  registry.register(mcp({ definition: { ...mcp().definition, description: 'Docs '.repeat(5000) } }));
  const request = modelRequest(registry), coordinator = runner(registry);
  const searched = await call(coordinator, request, 'get_tool_schema', { name: toolName });
  const text = JSON.stringify(searched.result), locator = 'tool-result://s/t/search-large';
  const messages = searchMessages(searched.result, 'search-large');
  messages[1].content = JSON.stringify({ archived: true, locator, originalChars: text.length, preview: text.slice(0, 400) });
  for (let offset = 0; offset < text.length; offset += 8000) {
    const id = `page-${offset}`, part = text.slice(offset, offset + 8000);
    messages.push({ role: 'assistant', content: '', toolCalls: [{ id, name: 'read_archived_tool_result', argumentsText: JSON.stringify({ locator, offset }) }] },
      { role: 'tool', toolCallId: id, content: JSON.stringify({ locator, offset, next_offset: offset + part.length, complete: offset + part.length === text.length }) + '\n\n[text]\n' + part });
    synchronizeMcpDiscovery(registry, request, messages);
    assert.equal((await call(coordinator, request, 'call_tool', { name: toolName, arguments: {} })).kind, offset + part.length === text.length ? 'returned' : 'failed');
  }
  const changed = structuredClone(messages);
  changed.splice(2, 2); // Compaction removes one of the chunks; a background receipt is insufficient.
  synchronizeMcpDiscovery(registry, request, changed);
  assert.equal((await call(coordinator, request, 'call_tool', { name: toolName, arguments: {} })).kind, 'failed');
});

test('real host preserves cache chain and discovered tools across a durable session restart', async t => {
  const root = await temp(t), journal = join(root, 'sessions'), observed = [];
  const createHost = (persistence, turn) => {
    const registry = new ToolRegistry(); registry.register(mcp());
    // A catalog change does not change the compact model-facing tool definitions.
    if (turn === 'second') registry.register(mcp({ definition: { ...mcp().definition, name: 'mcp__other__lookup' }, mcpHook: { server: 'other', tool: 'lookup', call: async () => ({}) } }));
    let round = 0;
    const host = new InMemoryRuntimeHost({ dataRoot: root, sessionStore: new SessionStore({ persistence }), toolRegistry: registry, registerDefaultWorkspaceTools: false,
      provider: { async *stream(request) {
        observed.push(structuredClone(request)); round++;
        const base = { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: new Date().toISOString() };
        yield { ...base, sequence: 0, kind: 'response_started' };
        const name = turn === 'first' && round === 1 ? 'get_tool_schema' : 'call_tool';
        if (round <= (turn === 'first' ? 2 : 1)) {
          yield { ...base, sequence: 1, kind: 'tool_call_delta', index: 0, toolCallId: `${turn}-${round}`, nameDelta: name, argumentsDelta: JSON.stringify(name === 'get_tool_schema' ? { name: toolName } : { name: toolName, arguments: {} }) };
          yield { ...base, sequence: 2, kind: 'response_completed', finishReason: 'tool_calls' };
        } else { yield { ...base, sequence: 1, kind: 'text_delta', delta: 'done' }; yield { ...base, sequence: 2, kind: 'response_completed', finishReason: 'stop' }; }
      } } });
    return { host, registry };
  };
  const firstPersistence = new FileSessionEventPersistence({ root: journal });
  const first = createHost(firstPersistence, 'first');
  assert.equal((await first.host.runSessionTurn(sessionRequest(first.registry, 'first'))).payload.status, 'completed');
  await first.host.sendCommand({ kind: 'runtime.shutdown', payload: {} }); firstPersistence.close();
  const secondPersistence = new FileSessionEventPersistence({ root: journal });
  const second = createHost(secondPersistence, 'second');
  t.after(async () => { await second.host.sendCommand({ kind: 'runtime.shutdown', payload: {} }); secondPersistence.close(); });
  assert.equal((await second.host.runSessionTurn(sessionRequest(second.registry, 'second'))).payload.status, 'completed');
  const last = observed.at(-1).messages.filter(message => message.role === 'tool').at(-1);
  assert.deepEqual(JSON.parse(last.content), { found: true });
  assert.ok(observed.every(request => !request.tools.some(tool => tool.name.startsWith('mcp__'))));
  const cache = [...first.host.events('s', 'first'), ...second.host.events('s', 'second')].filter(event => event.kind === 'cache_chain_observed');
  assert.equal(cache.length, 5); assert.ok(cache.every(event => event.payload.frozenPrefixBreak === false), JSON.stringify(cache));
  assert.equal(observed.flatMap(request => request.messages).filter(message => message.role === 'assistant' && message.toolCalls.some(call => call.name === 'get_tool_schema')).at(-1).toolCalls[0].id, 'first-1');
});
