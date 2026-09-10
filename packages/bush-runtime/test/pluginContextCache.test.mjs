import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { CacheChainTracker, FileSessionEventPersistence, InMemoryRuntimeHost, SessionStore, ToolRegistry, ToolExecutionCoordinator } from '../dist/index.js';
import { PluginAgentMemory, AGENT_MEMORY_SNAPSHOT } from '../dist/pluginAgentMemory.js';
import { RuntimeSessionCoordinator } from '../dist/runtimeSessionCoordinator.js';
import { clearMcpDiscovery, modelToolDefinitions, registerMcpDiscovery, synchronizeMcpDiscovery } from '../dist/mcpToolDiscovery.js';

const manifest = { effect_kind: 'observation', operation: 'fixture.read', risk: 'low', owner: 'runtime', dispatch_scope: 'parent_session', mutating: false };
const profile = { id: 'demo:reviewer', pluginId: 'demo', root: '.', name: 'reviewer', description: 'Review', prompt: 'Review files', memory: 'project' };
const toolName = 'mcp__docs__lookup';
const mcp = (overrides = {}) => ({ definition: { name: toolName, description: 'Search project documentation', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }, manifest, decodeInput: input => input, execute: () => ({ found: true }),
  mcpHook: { server: 'docs', tool: 'lookup', call: async () => ({}) }, ...overrides });
const modelRequest = (registry, overrides = {}) => ({ protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 's', turnId: 't', model: 'fixture', permissionMode: 'task_free', tools: registry.definitions(), messages: [], metadata: { mcpToolDiscovery: true }, ...overrides });
const sessionRequest = (registry, turnId, metadata = {}) => ({ protocol: 'bush.session_turn_request.v1', requestId: `r-${turnId}`, sessionId: 's', turnId, model: 'fixture', permissionMode: 'task_free', tools: registry.definitions(), prefixMessages: [{ role: 'developer', content: 'Stable instructions' }], inputMessages: [{ messageId: `user-${turnId}`, message: { role: 'user', content: 'Continue the task' } }], metadata });
const runner = registry => new ToolExecutionCoordinator({ registry, permissions: { request: async () => { throw Error('Unexpected permission request'); } } });
let serial = 0;
const call = (coordinator, request, name, args = {}) => coordinator.execute({ protocol: 'bush.tool_call.v1', id: `c-${++serial}`, name, argumentsText: JSON.stringify(args) }, { ...request, round: 1, ordinal: serial }, undefined, { request, contextMessages: request.messages });
const searchMessages = (result, id = `search-${++serial}`) => [{ role: 'assistant', content: '', toolCalls: [{ id, name: 'mcp_search', argumentsText: '{"query":"docs"}' }] }, { role: 'tool', toolCallId: id, content: JSON.stringify(result) }];
async function temp(t) { const root = await mkdtemp(join(tmpdir(), 'cardbush-plugin-cache-')); t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'cardbush-plugin-cache-')); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }); return root; }

test('discovery survives turns/restart without resending schemas, but not compaction or scope changes', async () => {
  const registry = new ToolRegistry(); registerMcpDiscovery(registry); registry.register(mcp());
  const initial = modelRequest(registry), coordinator = runner(registry);
  const searched = await call(coordinator, initial, 'mcp_search', { query: 'docs' });
  const history = searchMessages(searched.result), original = structuredClone(history);
  clearMcpDiscovery(registry, initial);
  const next = modelRequest(registry, { turnId: 'next', messages: history });
  synchronizeMcpDiscovery(registry, next, history);
  assert.equal((await call(coordinator, next, 'mcp_call', { name: toolName, arguments: {} })).kind, 'returned');
  const repeated = await call(coordinator, next, 'mcp_search', { query: 'docs' });
  assert.equal(repeated.result.matches[0].loaded, true);
  assert.equal(repeated.result.matches[0].inputSchema, undefined);
  assert.equal((await call(coordinator, next, 'mcp_search', { query: 'docs', reload: true })).result.matches[0].inputSchema.type, 'object');
  assert.deepEqual(history, original);

  const restarted = new ToolRegistry(); registerMcpDiscovery(restarted); restarted.register(mcp());
  const recovered = modelRequest(restarted, { turnId: 'recovered', messages: history });
  synchronizeMcpDiscovery(restarted, recovered, history);
  assert.equal((await call(runner(restarted), recovered, 'mcp_call', { name: toolName, arguments: {} })).kind, 'returned');
  // A compact reference is insufficient when the original full schema was summarized away.
  const compacted = searchMessages(repeated.result);
  synchronizeMcpDiscovery(restarted, recovered, compacted);
  assert.equal((await call(runner(restarted), recovered, 'mcp_call', { name: toolName, arguments: {} })).error.code, 'mcp_discovery_required');
  assert.ok((await call(runner(restarted), recovered, 'mcp_search', { query: 'docs' })).result.matches[0].inputSchema);
  const other = modelRequest(registry, { sessionId: 'other', messages: history });
  synchronizeMcpDiscovery(registry, other, history);
  assert.equal((await call(coordinator, other, 'mcp_call', { name: toolName, arguments: {} })).kind, 'failed');
  const restricted = modelRequest(registry, { turnId: 'restricted', messages: history, tools: registry.definitions().filter(tool => tool.name !== toolName) });
  synchronizeMcpDiscovery(registry, restricted, history);
  assert.equal((await call(coordinator, restricted, 'mcp_call', { name: toolName, arguments: {} })).kind, 'failed');
});

test('schema updates reload only changed definitions while permissions and connections remain live', async () => {
  const registry = new ToolRegistry(); registerMcpDiscovery(registry); registry.replaceOwned('docs', [mcp()]);
  const request = modelRequest(registry), coordinator = runner(registry);
  const first = await call(coordinator, request, 'mcp_search', { query: 'docs' });
  const history = searchMessages(first.result), projection = modelToolDefinitions(registry, request);
  const tracker = new CacheChainTracker(); tracker.observe({ ...request, tools: projection, messages: history });
  const changed = mcp({ definition: { ...mcp().definition, description: 'Search updated documentation', inputSchema: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] } } });
  registry.replaceOwned('docs', [changed]);
  assert.equal((await call(coordinator, request, 'mcp_call', { name: toolName, arguments: {} })).error.code, 'mcp_discovery_required');
  synchronizeMcpDiscovery(registry, request, history);
  const second = await call(coordinator, request, 'mcp_search', { query: 'docs' });
  assert.deepEqual(second.result.matches[0].inputSchema.required, ['topic']);
  assert.notEqual(first.result.matches[0].revision, second.result.matches[0].revision);
  const appended = [...history, ...searchMessages(second.result)];
  assert.equal(tracker.observe({ ...request, tools: modelToolDefinitions(registry, request), messages: appended }).frozenPrefixBreak, false);
  registry.replaceOwned('docs', [mcp({ ...changed, authorize: () => ({ kind: 'deny', code: 'revoked', message: 'Permission revoked' }) })]);
  synchronizeMcpDiscovery(registry, request, appended);
  assert.equal((await call(coordinator, request, 'mcp_call', { name: toolName, arguments: { topic: 'a' } })).error.code, 'revoked');
  registry.removeOwned('docs');
  assert.equal((await call(coordinator, request, 'mcp_call', { name: toolName, arguments: {} })).kind, 'failed');
  assert.deepEqual(modelToolDefinitions(registry, request), projection);
  const empty = modelRequest(registry, { turnId: 'empty' });
  assert.deepEqual(modelToolDefinitions(registry, empty), projection);
});

test('replacing an MCP connection during approval prevents executing the captured old connection', async () => {
  const registry = new ToolRegistry(); registerMcpDiscovery(registry);
  let executed = 0;
  registry.replaceOwned('docs', [mcp({ execute: () => { executed++; return {}; }, authorize: () => ({ kind: 'ask', request: { reason: 'Read docs', actions: ['read'], targets: [], capabilityIds: [] } }) })]);
  const request = modelRequest(registry);
  const coordinator = new ToolExecutionCoordinator({ registry, permissions: { request: async () => { registry.replaceOwned('docs', [mcp()]); return { decision: 'allow', grantedCapabilityIds: [] }; } } });
  const searched = await call(coordinator, request, 'mcp_search', { query: 'docs' });
  synchronizeMcpDiscovery(registry, request, searchMessages(searched.result));
  assert.equal((await call(coordinator, request, 'mcp_call', { name: toolName, arguments: {} })).error.code, 'tool_definition_changed');
  assert.equal(executed, 0);
});

test('archived/rewritten tool output cannot count as a visible schema', async () => {
  const registry = new ToolRegistry(); registerMcpDiscovery(registry); registry.register(mcp());
  const request = modelRequest(registry), coordinator = runner(registry);
  const searched = await call(coordinator, request, 'mcp_search', { query: 'docs' });
  const messages = searchMessages(searched.result);
  messages[1].content = JSON.stringify({ archived: true, preview: JSON.stringify(searched.result) });
  synchronizeMcpDiscovery(registry, request, messages);
  assert.equal((await call(coordinator, request, 'mcp_call', { name: toolName, arguments: {} })).kind, 'failed');
  messages[1].content = JSON.stringify({ ...searched.result, matches: searched.result.matches.map(match => ({ ...match, inputSchema: { type: 'object' } })) });
  synchronizeMcpDiscovery(registry, request, messages);
  assert.equal((await call(coordinator, request, 'mcp_call', { name: toolName, arguments: {} })).kind, 'failed');
});

test('a large archived schema becomes reusable only after all exact chunks are visible', async () => {
  const registry = new ToolRegistry(); registerMcpDiscovery(registry);
  registry.register(mcp({ definition: { ...mcp().definition, description: 'Docs '.repeat(5000) } }));
  const request = modelRequest(registry), coordinator = runner(registry);
  const searched = await call(coordinator, request, 'mcp_search', { query: 'docs' });
  const text = JSON.stringify(searched.result), locator = 'tool-result://s/t/search-large';
  const messages = searchMessages(searched.result, 'search-large');
  messages[1].content = JSON.stringify({ archived: true, locator, originalChars: text.length, preview: text.slice(0, 400) });
  for (let offset = 0; offset < text.length; offset += 8000) {
    const id = `page-${offset}`, part = text.slice(offset, offset + 8000);
    messages.push({ role: 'assistant', content: '', toolCalls: [{ id, name: 'read_archived_tool_result', argumentsText: JSON.stringify({ locator, offset }) }] },
      { role: 'tool', toolCallId: id, content: JSON.stringify({ locator, offset, next_offset: offset + part.length, complete: offset + part.length === text.length }) + '\n\n[text]\n' + part });
    synchronizeMcpDiscovery(registry, request, messages);
    assert.equal((await call(coordinator, request, 'mcp_call', { name: toolName, arguments: {} })).kind, offset + part.length === text.length ? 'returned' : 'failed');
  }
  const changed = structuredClone(messages);
  changed.splice(2, 2); // Compaction removes one of the chunks; a background receipt is insufficient.
  synchronizeMcpDiscovery(registry, request, changed);
  assert.equal((await call(coordinator, request, 'mcp_call', { name: toolName, arguments: {} })).kind, 'failed');
});

test('memory snapshots are journaled once; disk writes and restart do not rebuild the prefix', async t => {
  const root = await temp(t), project = join(root, 'project'); await mkdir(project);
  const registry = new ToolRegistry(), memory = new PluginAgentMemory(join(root, 'memory'), registry), coordinator = runner(registry);
  const seed = sessionRequest(registry, 'seed', { projectDir: project });
  await memory.prepare(profile, seed, registry);
  const initialWrite = await call(coordinator, modelRequest(registry), 'agent_memory_write', { content: 'Remember original project conventions.', expected_revision: null });
  assert.equal(initialWrite.kind, 'returned');

  const persistence = new FileSessionEventPersistence({ root: join(root, 'sessions') });
  const sessions = new RuntimeSessionCoordinator({ store: new SessionStore({ persistence }) });
  const first = sessionRequest(registry, 'first', { projectDir: project });
  await memory.prepare(profile, first, registry);
  const prepared = sessions.prepare(first), original = structuredClone(prepared.modelRequest.messages);
  assert.ok(first.prefixMessages.every(message => !message.content.includes('original project conventions')));
  const snapshot = first.inputMessages.find(item => item.message.name === AGENT_MEMORY_SNAPSHOT);
  assert.match(snapshot.message.content, /original project conventions/);
  const tracker = new CacheChainTracker(); tracker.observe(prepared.modelRequest);
  sessions.finalizer(prepared.modelRequest, prepared.sessionCommit)({ status: 'completed', reason: 'fixture', details: {} }, [], {}, tracker.snapshot());
  await writeFile(initialWrite.result.path, 'Changed externally while the Agent was idle.');
  persistence.close(); memory.release('s');

  const reopened = new FileSessionEventPersistence({ root: join(root, 'sessions') }); t.after(() => reopened.close());
  const recovered = new RuntimeSessionCoordinator({ store: new SessionStore({ persistence: reopened }) });
  const freshRegistry = new ToolRegistry(), freshMemory = new PluginAgentMemory(join(root, 'memory'), freshRegistry);
  const second = sessionRequest(freshRegistry, 'second', { projectDir: project });
  await freshMemory.prepare(profile, second, freshRegistry, recovered.assemble({ sessionId: 's' }).messages);
  assert.equal(second.inputMessages.filter(item => item.message.name === AGENT_MEMORY_SNAPSHOT).length, 0);
  assert.deepEqual(second.prefixMessages, first.prefixMessages);
  const next = recovered.prepare(second);
  assert.deepEqual(next.modelRequest.messages.slice(0, original.length), original);
  assert.equal(tracker.observe(next.modelRequest).frozenPrefixBreak, false);
  const read = await call(runner(freshRegistry), next.modelRequest, 'agent_memory_read', {});
  assert.match(read.result.content, /Changed externally/);
  assert.deepEqual(prepared.modelRequest.messages, original);
  const newTask = { ...sessionRequest(freshRegistry, 'new', { projectDir: project }), sessionId: 'new-session' };
  await freshMemory.prepare(profile, newTask, freshRegistry);
  assert.match(newTask.inputMessages.at(-1).message.content, /Changed externally/);
});

test('memory reads are bounded, searchable and can continue inside a long Unicode line', async t => {
  const root = await temp(t), project = join(root, 'project'); await mkdir(project);
  const registry = new ToolRegistry(), memory = new PluginAgentMemory(join(root, 'memory'), registry), coordinator = runner(registry);
  const request = sessionRequest(registry, 'memory', { projectDir: project }); await memory.prepare(profile, request, registry);
  const req = modelRequest(registry);
  const content = '🦊中文'.repeat(5000);
  const written = await call(coordinator, req, 'agent_memory_write', { content, expected_revision: null });
  assert.equal(written.kind, 'returned');
  let collected = '', cursor = {};
  for (let i = 0; i < 8; i++) {
    const read = await call(coordinator, req, 'agent_memory_read', cursor); assert.equal(read.kind, 'returned');
    assert.ok(Buffer.byteLength(read.result.content) <= 16384); assert.ok(!read.result.content.includes('\ufffd'));
    collected += read.result.content;
    if (read.result.nextLine === null) break;
    cursor = { start_line: read.result.nextLine, start_column: read.result.nextColumn };
  }
  assert.equal(collected, content);
  const next = { ...sessionRequest(registry, 'snapshot', { projectDir: project }), sessionId: 'snapshot-session' };
  await memory.prepare(profile, next, registry);
  const snapshot = JSON.parse(next.inputMessages.at(-1).message.content);
  assert.ok(Buffer.byteLength(snapshot.content) <= 4096); assert.ok(snapshot.nextColumn > 1);
  const unchanged = await call(coordinator, req, 'agent_memory_write', { content, expected_revision: written.result.revision });
  assert.equal(unchanged.result.unchanged, true);
  await call(coordinator, req, 'agent_memory_write', { content: 'first\nsecond\nneedle\nfourth\nfifth', expected_revision: written.result.revision });
  const relevant = await call(coordinator, req, 'agent_memory_read', { query: 'needle', max_lines: 4 });
  assert.ok(relevant.result.content.includes('needle')); assert.equal(relevant.result.nextLine, 5);
  const oneLine = await call(coordinator, req, 'agent_memory_read', { query: 'needle', max_lines: 1 });
  assert.equal(oneLine.result.content, 'needle');
  const current = await call(coordinator, req, 'agent_memory_read');
  await call(coordinator, req, 'agent_memory_write', { content: '\\'.repeat(30000) + 'needle', expected_revision: current.result.revision });
  const escaped = await call(coordinator, req, 'agent_memory_read');
  assert.ok(JSON.stringify(escaped.result).length < 16000, 'a bounded page must stay below the generic tool archive threshold');
  assert.ok((await call(coordinator, req, 'agent_memory_read', { query: 'needle' })).result.content.includes('needle'));
});

test('real plugin Agent startup appends memory and a write preserves its initial snapshot', async t => {
  const root = await temp(t), project = join(root, 'project'); await mkdir(project);
  const registry = new ToolRegistry(), children = [], rounds = new Map();
  const host = new InMemoryRuntimeHost({ dataRoot: root, toolRegistry: registry, registerDefaultWorkspaceTools: false,
    loadPluginExtensions: async () => ({ hooks: [], agents: [{ ...profile, tools: ['agent_memory_read', 'agent_memory_write'] }] }),
    provider: { async *stream(request) {
      const round = (rounds.get(request.sessionId) ?? 0) + 1; rounds.set(request.sessionId, round);
      const child = request.metadata.agentRole === 'child';
      if (child) children.push(structuredClone(request));
      const base = { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: new Date().toISOString() };
      yield { ...base, sequence: 0, kind: 'response_started' };
      if (round === 1) {
        const name = child ? 'agent_memory_write' : 'subagent';
        const args = child ? { content: 'New project convention', expected_revision: null } : { prompt: 'Remember the convention', inherit_context: false, agent_type: profile.id };
        yield { ...base, sequence: 1, kind: 'tool_call_delta', index: 0, toolCallId: `call-${request.sessionId}`, nameDelta: name, argumentsDelta: JSON.stringify(args) };
        yield { ...base, sequence: 2, kind: 'response_completed', finishReason: 'tool_calls' };
      } else { yield { ...base, sequence: 1, kind: 'text_delta', delta: 'done' }; yield { ...base, sequence: 2, kind: 'response_completed', finishReason: 'stop' }; }
    } } });
  t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  assert.equal((await host.runSessionTurn(sessionRequest(registry, 'parent', { projectDir: project }))).payload.status, 'completed');
  assert.equal(children.length, 2);
  const snapshot = children[0].messages.find(message => message.name === AGENT_MEMORY_SNAPSHOT);
  assert.equal(snapshot.role, 'user'); assert.equal(snapshot.visibility, 'internal');
  assert.equal(JSON.parse(snapshot.content).revision, null);
  assert.deepEqual(children[1].messages.slice(0, children[0].messages.length), children[0].messages);
  assert.deepEqual(children[1].messages.find(message => message.name === AGENT_MEMORY_SNAPSHOT), snapshot);
  assert.ok(JSON.parse(children[1].messages.filter(message => message.role === 'tool').at(-1).content).written);
  assert.ok(host.events(children[0].sessionId, children[0].turnId).filter(event => event.kind === 'cache_chain_observed').every(event => !event.payload.frozenPrefixBreak));
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
        const name = turn === 'first' && round === 1 ? 'mcp_search' : 'mcp_call';
        if (round <= (turn === 'first' ? 2 : 1)) {
          yield { ...base, sequence: 1, kind: 'tool_call_delta', index: 0, toolCallId: `${turn}-${round}`, nameDelta: name, argumentsDelta: JSON.stringify(name === 'mcp_search' ? { query: 'docs' } : { name: toolName, arguments: {} }) };
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
  assert.equal(observed.flatMap(request => request.messages).filter(message => message.role === 'assistant' && message.toolCalls.some(call => call.name === 'mcp_search')).at(-1).toolCalls[0].id, 'first-1');
});
