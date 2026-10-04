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

test('a running product turn loads and calls a new plugin on its next round without changing provider tools', async () => {
  const registry = new ToolRegistry(); let round = 0, calls = 0, providerTools;
  registry.register({ ...tool('install_fixture'), mcpHook: undefined, execute: () => {
    registry.replaceOwned('runtime_mcp', [tool('mcp__added__echo', { execute: () => { calls++; return { ok: true }; } })]);
    return { installed: true };
  } });
  const host = new InMemoryRuntimeHost({ toolRegistry: registry, provider: { async *stream(request) {
    providerTools ??= request.tools;
    assert.deepEqual(request.tools, providerTools);
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
