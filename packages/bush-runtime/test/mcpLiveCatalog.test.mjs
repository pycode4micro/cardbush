import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryRuntimeHost, ToolRegistry, registerMcpDiscovery } from '../dist/index.js';
import { synchronizeMcpCatalog, modelToolDefinitions, mcpToolWasDiscovered } from '../dist/mcpToolDiscovery.js';

const manifest = { effect_kind: 'observation', operation: 'test', risk: 'low', owner: 'fixture', dispatch_scope: 'parent_session', mutating: false };
const tool = (name, extra = {}) => ({ definition: { name, description: name, inputSchema: { type: 'object' } }, manifest,
  decodeInput: x => x, execute: () => ({ ok: true }), mcpHook: { server: 'added', tool: name, call: async () => ({}) }, ...extra });

test('live additions remain opt-in, scoped and unloaded; provider definitions stay stable', () => {
  const registry = new ToolRegistry(); registerMcpDiscovery(registry);
  const initial = registry.definitions();
  registry.replaceOwned('runtime_mcp', [tool('mcp__added__echo'), tool('private', { sessionScope: 'other' }),
    tool('ui_only', { mcpHook: { server: 'added', tool: 'ui_only', modelVisible: false, call: async () => ({}) } })]);
  registry.register(tool('unrelated'));
  for (const restrictions of [{ agentRole: 'child' }, { pluginAgentId: 'role' }, { automationRunId: 'job' }, { mcpCatalogUpdates: undefined }]) {
    const request = { sessionId: 's', turnId: 't', tools: [...initial], metadata: { mcpToolDiscovery: true, mcpCatalogUpdates: 'additions', ...restrictions } };
    synchronizeMcpCatalog(registry, request);
    assert.deepEqual(request.tools, initial);
  }
  const request = { sessionId: 's', turnId: 't', tools: [...initial], metadata: { mcpToolDiscovery: true, mcpCatalogUpdates: 'additions' } };
  const before = modelToolDefinitions(registry, request);
  synchronizeMcpCatalog(registry, request); synchronizeMcpCatalog(registry, request);
  assert.deepEqual(request.tools.map(t => t.name), [...initial.map(t => t.name), 'mcp__added__echo']);
  assert.deepEqual(modelToolDefinitions(registry, request), before);
  assert.equal(mcpToolWasDiscovered(registry, request, 'mcp__added__echo'), false);
});

test('no-tools policy suppresses both fresh and saved provider definitions without changing the live scope', () => {
  const registry = new ToolRegistry(); registerMcpDiscovery(registry);
  const initial = registry.definitions();
  const request = { sessionId: 's', turnId: 't', tools: [...initial], metadata: { mcpToolDiscovery: true } };
  const before = modelToolDefinitions(registry, request);
  assert.ok(before.length > 0);
  const snapshot = structuredClone(request.metadata.mcpModelToolSnapshot);

  request.metadata.toolExecutionPolicy = 'none';
  assert.deepEqual(modelToolDefinitions(registry, request), []);
  assert.deepEqual(request.metadata.mcpModelToolSnapshot, snapshot);
  assert.deepEqual(request.tools, initial);
  assert.deepEqual(registry.definitions(), initial);
  assert.deepEqual(modelToolDefinitions(registry, {
    sessionId: 's', turnId: 'fresh', tools: [...initial], metadata: { toolExecutionPolicy: 'none' },
  }), []);

  delete request.metadata.toolExecutionPolicy;
  assert.deepEqual(modelToolDefinitions(registry, request), before);
});

test('round boundaries reconcile additions, changes and removals with one bounded model notice', () => {
  const registry = new ToolRegistry(); registerMcpDiscovery(registry);
  registry.replaceOwned('runtime_mcp', [tool('old'), tool('edit'), tool('steady')]);
  const request = { sessionId: 's', turnId: 't', tools: registry.definitions(), metadata: { mcpToolDiscovery: true, mcpCatalogUpdates: 'additions' } };
  assert.equal(synchronizeMcpCatalog(registry, request), undefined);
  const provider = modelToolDefinitions(registry, request);
  registry.replaceOwned('runtime_mcp', [tool('added'), tool('edit', { definition: { name: 'edit', description: 'new parameters', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }), tool('steady')]);
  const message = synchronizeMcpCatalog(registry, request);
  const update = JSON.parse(message.content);
  assert.deepEqual(update.added, ['added']); assert.deepEqual(update.updated, ['edit']); assert.deepEqual(update.removed, ['old']);
  assert.equal(message.visibility, 'internal');
  assert.deepEqual(request.tools.find(tool => tool.name === 'edit').inputSchema.required, ['path']);
  assert.ok(!request.tools.some(tool => tool.name === 'old'));
  assert.deepEqual(modelToolDefinitions(registry, request), provider, 'MCP provider gateway remains stable');
  assert.equal(synchronizeMcpCatalog(registry, request), undefined, 'unchanged catalog produces no repeated guidance');
  const resumed = structuredClone(request);
  registry.replaceOwned('runtime_mcp', [tool('steady')]);
  assert.deepEqual(JSON.parse(synchronizeMcpCatalog(registry, resumed).content).removed, ['added', 'edit'], 'checkpoint resumes retain the previous catalog identity');
});

test('native extension scope refreshes without rewriting provider declarations or expanding a child scope', () => {
  const registry = new ToolRegistry(); registerMcpDiscovery(registry);
  registry.replaceOwned('extension:fixture', [{ ...tool('native'), mcpHook: undefined }]);
  const request = { sessionId: 's', turnId: 't', tools: registry.definitions(), metadata: { mcpToolDiscovery: true, mcpCatalogUpdates: 'additions' } };
  synchronizeMcpCatalog(registry, request);
  const frozen = modelToolDefinitions(registry, request);
  assert.ok(frozen.some(tool => tool.name === 'native'));
  const child = structuredClone(request); child.metadata.agentRole = 'child';
  registry.replaceOwned('extension:fixture', [{ ...tool('native', { definition: { name: 'native', description: 'new version', inputSchema: { type: 'object' } } }), mcpHook: undefined }, { ...tool('replacement'), mcpHook: undefined }]);
  synchronizeMcpCatalog(registry, request); synchronizeMcpCatalog(registry, child);
  assert.ok(request.tools.some(tool => tool.name === 'replacement'));
  assert.deepEqual(modelToolDefinitions(registry, request), frozen);
  assert.equal(child.tools.find(tool => tool.name === 'native').description, 'new version');
  assert.ok(!child.tools.some(tool => tool.name === 'replacement'));
  assert.deepEqual(modelToolDefinitions(registry, child), frozen, 'a fork retains the provider prefix');
  registry.replaceOwned('extension:fixture', []);
  synchronizeMcpCatalog(registry, request); synchronizeMcpCatalog(registry, child);
  assert.deepEqual(modelToolDefinitions(registry, request), frozen, 'removal changes admission, not the prefix');
  assert.ok(!request.tools.some(tool => tool.name === 'native'));
  assert.ok(!child.tools.some(tool => tool.name === 'native'));
});

test('a running product turn loads and calls a new plugin on its next round without changing provider tools', async () => {
  const registry = new ToolRegistry(); let round = 0, calls = 0, providerTools;
  registry.register({ ...tool('install_fixture'), mcpHook: undefined, execute: () => {
    registry.replaceOwned('runtime_mcp', [tool('mcp__added__echo', { execute: () => { calls++; return { ok: true }; } })]);
    return { installed: true };
  } });
  const host = new InMemoryRuntimeHost({ toolRegistry: registry, provider: { async *stream(request) {
    providerTools ??= request.tools;
    assert.deepEqual(request.tools, providerTools);
    const notices = request.messages.filter(message => message.name === 'mcp_catalog_update');
    assert.equal(notices.length, round === 0 ? 0 : 1, 'the next round sees exactly one capability update');
    if (notices.length) assert.deepEqual(JSON.parse(notices[0].content).added, ['mcp__added__echo']);
    const operations = [ ['install_fixture', {}], ['mcp_search', { action: 'load', query: 'mcp__added__echo' }],
      ['mcp_call', { name: 'mcp__added__echo', arguments: {} }] ];
    const operation = operations[round++];
    const event = (sequence, kind, values) => ({ protocol: 'bush.model_event.v1', requestId: request.requestId,
      sequence, createdAt: new Date().toISOString(), kind, ...values });
    if (operation) yield event(0, 'tool_call_delta', { index: 0, toolCallId: `call_${round}`, nameDelta: operation[0], argumentsDelta: JSON.stringify(operation[1]) });
    else yield event(0, 'text_delta', { delta: 'Done' });
    yield event(1, 'response_completed', { finishReason: operation ? 'tool_calls' : 'stop' });
  } } });
  const result = await host.runSessionTurn({ protocol: 'bush.session_turn_request.v1', requestId: 'r', sessionId: 's', turnId: 't', model: 'fixture',
    prefixMessages: [], inputMessages: [{ messageId: 'u', createdAt: new Date().toISOString(), message: { role: 'user', content: 'Use the newly added plugin' } }],
    tools: registry.definitions(), permissionMode: 'all_free', metadata: { mcpCatalogUpdates: 'additions' } });
  assert.equal(result.kind, 'turn_terminal');
  assert.equal(calls, 1);
  assert.equal(round, 4);
});
