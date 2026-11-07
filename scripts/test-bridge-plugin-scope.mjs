import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry, ToolExecutionCoordinator } from '../packages/bush-runtime/dist/index.js';
import { BridgePluginTools } from '../packages/bush-runtime/dist/botMessaging.js';
import { registerMcpDiscovery } from '../packages/bush-runtime/dist/mcpToolDiscovery.js';

test('bridge plugins use ordinary search, isolate sessions and sources, refresh revisions and disappear on disconnect', async () => {
  const registry = new ToolRegistry(), calls = [];
  registerMcpDiscovery(registry);
  const connectionA = '11111111-1111-4111-8111-111111111111', connectionB = '22222222-2222-4222-8222-222222222222';
  const plugin = id => ({ id, name: id, version: '1', description: 'Platform-owned arbitrary tool', tools: [
    { name: 'create_card', description: 'Create a platform-specific card', inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false } },
  ] });
  let catalog = [connectionA, connectionB].map((connectionId, index) => ({ connectionId, sessionId: 'a', expiresAt: Date.now() + 60000,
    revision: String(index + 1).repeat(64), plugin: plugin(index ? 'platform_b' : 'platform_a') }));
  const source = ref => ({ sourceRef: ref, connectionId: ref === 'source-a' ? connectionA : connectionB, available: true, capabilities: { text: true } });
  let extraRecipient = false;
  const plugins = new BridgePluginTools(registry, {
    catalog: async sessionId => catalog.filter(item => item.sessionId === sessionId),
    context: async (sessionId, ref) => ({ discovery: 'mcp_search', available: true, source: ref ? source(ref) : undefined, targets: [source('source-a'), source('source-b'),
      ...(extraRecipient ? [{ ...source('source-a'), sourceRef: 'another-recipient' }] : [])] }),
    call: async (sessionId, input) => { calls.push({ sessionId, input }); return { status: 'accepted' }; },
  }, id => id === 'child-a' ? 'a' : id);
  await plugins.sync('a');
  const names = registry.definitions().filter(tool => tool.name.startsWith('mcp__bridge_')).map(tool => tool.name);
  assert.equal(names.length, 2);
  const prepare = (metadata, tools = []) => plugins.prepare({ sessionId: 'a', metadata, tools });
  assert.equal((await prepare({})).tools.length, 2, 'ordinary conversations discover connected tools');
  for (const metadata of [{ agentRole: 'child' }, { pluginAgentId: 'restricted' }, { automationRunId: 'scheduled' }, { toolExecutionPolicy: 'none' }])
    assert.equal((await prepare(metadata)).tools.length, 0, 'scoped requests cannot gain ungranted capabilities');
  assert.equal((await prepare({ agentRole: 'child' }, [registry.resolve(names[0]).definition])).tools.length, 1);
  assert.equal((await prepare({ disabledTools: names })).tools.length, 0);
  assert.equal((await prepare({ botDeliveryLocalOnly: true }, [registry.resolve(names[0]).definition])).tools.length, 0);
  const coordinator = new ToolExecutionCoordinator({ registry });
  const execute = (sessionId, name, args, metadata = {}) => coordinator.execute({ protocol: 'bush.tool_call.v1', id: 'call', name, argumentsText: JSON.stringify(args) },
    { requestId: 'r', sessionId, turnId: 't', round: 1, ordinal: 1 }, undefined,
    { request: { protocol: 'bush.model_request.v1', requestId: 'r', sessionId, turnId: 't', model: 'fixture', messages: [], tools: registry.definitions(), permissionMode: 'all_free', metadata }, contextMessages: [] });
  assert.equal((await execute('a', 'mcp_search', { query: 'create_card' })).result.matches.length, 2);
  assert.equal((await execute('a', 'mcp_search', { query: 'create_card' }, { botDeliveryLocalOnly: true })).result.matches.length, 0);
  assert.equal((await execute('a', names[0], { title: 'local reminder' }, { botDeliveryLocalOnly: true })).kind, 'failed');
  assert.equal((await execute('b', 'mcp_search', { query: '*' })).result.matches.length, 0, 'another conversation cannot discover these plugins');
  assert.equal((await execute('child-a', 'mcp_search', { query: '*' })).result.matches.length, 2, 'authorized children retain the root connection scope');
  assert.equal((await execute('a', names[1], { title: 'wrong platform' }, { botSourceRef: 'source-a' })).error.code, 'bridge_source_mismatch');
  assert.equal((await execute('a', names[0], { title: 'spoof', source_ref: 'source-b' }, { botSourceRef: 'source-a' })).error.code, 'bridge_source_mismatch');
  assert.equal((await execute('b', names[0], { title: 'foreign session' })).kind, 'failed');
  assert.equal(calls.length, 0);
  extraRecipient = true;
  assert.equal((await execute('a', names[0], { title: 'do not guess', source_ref: 'source-a' }, { botRequiresSingleRecipient: true })).error.code, 'bridge_source_required');
  assert.equal(calls.length, 0);
  extraRecipient = false;
  assert.equal((await execute('a', names[0], { title: 123 }, { botSourceRef: 'source-a' })).error.code, 'tool_arguments_schema_invalid');
  assert.equal((await execute('a', names[0], { title: 'ambiguous' }, { botSourceRefs: ['source-a','source-b'] })).error.code, 'bridge_source_ambiguous');
  assert.equal((await execute('a', names[0], { title: 'card' }, { botSourceRef: 'source-a' })).kind, 'returned');
  assert.equal(calls[0].input.sourceRef, 'source-a');
  assert.equal(calls[0].input.connectionId, connectionA);
  assert.deepEqual(calls[0].input.arguments, { title: 'card' }, 'routing fields are host data, not platform parameters');
  await execute('child-a', names[1], { title: 'delegated' }, { botSourceRef: 'source-b' });
  assert.equal(calls[1].sessionId, 'a'); assert.equal(calls[1].input.connectionId, connectionB);
  catalog[0] = { ...catalog[0], revision: 'c'.repeat(64), plugin: { ...catalog[0].plugin, version: '2' } };
  await plugins.sync('a');
  await execute('a', names[0], { title: 'new revision' }, { botSourceRef: 'source-a' });
  assert.equal(calls.at(-1).input.revision, 'c'.repeat(64));
  catalog = [];
  await plugins.sync('a');
  assert.equal((await execute('a', 'mcp_search', { query: '*' })).result.matches.length, 0);
  const count = calls.length;
  assert.equal((await execute('a', names[0], { title: 'disconnected' }, { botSourceRef: 'source-a' })).kind, 'failed');
  assert.equal(calls.length, count);
});
