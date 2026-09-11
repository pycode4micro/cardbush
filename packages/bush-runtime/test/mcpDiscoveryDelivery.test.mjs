import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolRegistry, RuntimeToolLoop, InMemoryRuntimeEventLog, ToolExecutionStore, registerMcpDiscovery, projectMcpDiscoveryResult, synchronizeMcpDiscovery, mcpToolWasDiscovered } from '../dist/index.js';

const manifest = { effect_kind: 'observation', operation: 'test', risk: 'low', owner: 'fixture', dispatch_scope: 'parent_session', mutating: false };
function fixture() {
  const registry = new ToolRegistry(); registerMcpDiscovery(registry);
  const add = (name, description, server = 'fixture') => registry.register({
    definition: { name: `mcp__${server}__${name}`, description, inputSchema: { type: 'object', properties: { value: { type: 'string' } } } },
    manifest, decodeInput: input => input, execute: () => ({}), mcpHook: { server, tool: name, call: async () => ({}) },
  });
  add('aaa_long', 'image generator '.repeat(5000));
  add('bbb_long', 'image generator '.repeat(5000));
  add('generate', 'image generator', 'seedream');
  add('upload-asset-from-url', 'Upload an asset');
  add('aaa_mentions_upload', 'Use upload-asset-from-url before this tool');
  const request = { sessionId: 's', turnId: 't', tools: registry.definitions(), metadata: { mcpToolDiscovery: true } };
  const search = args => {
    const tool = registry.resolve('mcp_search');
    return tool.execute({ input: tool.decodeInput(args), turn: { request, contextMessages: [] } });
  };
  return { registry, request, search };
}

test('long descriptions keep every search hit visible and only complete delivered schemas become callable', async () => {
  const { registry, request, search } = fixture();
  const result = await search({ query: 'image generator', limit: 10 });
  assert.equal(mcpToolWasDiscovered(registry, request, 'mcp__seedream__generate'), false, 'search execution alone does not imply delivery');
  const content = projectMcpDiscoveryResult(JSON.stringify(result));
  const view = JSON.parse(content);
  assert.deepEqual(view.catalog.map(tool => tool.name), result.matches.map(tool => tool.name));
  assert.ok(view.matches.some(tool => tool.name === 'mcp__seedream__generate'));
  assert.ok(view.unloaded.includes('mcp__fixture__aaa_long'));
  const messages = [{ role: 'assistant', content: '', toolCalls: [{ id: 'search', name: 'mcp_search', argumentsText: '{}' }] },
    { role: 'tool', toolCallId: 'search', content }];
  synchronizeMcpDiscovery(registry, request, messages);
  assert.equal(mcpToolWasDiscovered(registry, request, 'mcp__seedream__generate'), true);
  assert.equal(mcpToolWasDiscovered(registry, request, 'mcp__fixture__aaa_long'), false);
  synchronizeMcpDiscovery(registry, request, []);
  assert.equal(mcpToolWasDiscovered(registry, request, 'mcp__seedream__generate'), false, 'compaction cannot retain a hidden schema');
});

test('exact names rank before description mentions; pagination and isolated large loads remain complete', async () => {
  const { search } = fixture();
  assert.equal((await search({ query: 'upload-asset-from-url', limit: 1 })).matches[0].tool, 'upload-asset-from-url');
  const first = await search({ query: '*', limit: 2 });
  const second = await search({ query: '*', limit: 2, offset: first.next_offset });
  assert.equal(new Set([...first.matches, ...second.matches].map(tool => tool.name)).size, 4);
  const isolated = await search({ query: 'mcp__fixture__aaa_long', limit: 1, reload: true });
  const view = JSON.parse(projectMcpDiscoveryResult(JSON.stringify(isolated)));
  assert.deepEqual(view.matches[0], isolated.matches[0]);
  assert.ok(view.matches[0].description.length > 16_000);
});

test('adversarial sizes never produce partial definitions or hide hit identities', () => {
  for (const count of [1, 3, 10]) for (const length of [10, 15_999, 80_000, 150_000]) for (const budget of [0, 6000, 16000, 128000]) {
    const result = { protocol: 'bush.mcp_discovery.v1', sessionId: 's', total: count, more: false,
      matches: Array.from({ length: count }, (_, i) => ({ name: `mcp__s__tool${i}`, server: 's', tool: `tool${i}`, revision: 'v1',
        description: '文'.repeat(length), inputSchema: { type: 'object', properties: { requiredDetail: { const: i } } } })) };
    const raw = JSON.stringify(result), rendered = projectMcpDiscoveryResult(raw, budget), view = JSON.parse(rendered);
    assert.deepEqual(view.catalog.map(tool => tool.name), result.matches.map(tool => tool.name));
    for (const tool of view.matches) assert.deepEqual(tool, result.matches.find(original => original.name === tool.name));
    const minimum = projectMcpDiscoveryResult(raw, 0).length;
    assert.ok(rendered.length <= Math.max(budget, minimum));
    assert.equal(view.matches.length + view.unloaded.length, count);
  }
});

test('trusted Hook feedback cannot be bypassed by the structured discovery projection', async () => {
  const { registry, request } = fixture();
  const store = new ToolExecutionStore();
  const loop = new RuntimeToolLoop({ registry, executionStore: store, eventLog: new InMemoryRuntimeEventLog(),
    identity: { requestId: 'r', sessionId: 's', turnId: 't' }, hooks: {
      before: async () => ({ messages: [] }),
      after: async () => ({ messages: [], toolFeedback: 'Hook replaced this discovery result.' }),
    } });
  const call = { protocol: 'bush.tool_call.v1', id: 'search', name: 'mcp_search', argumentsText: JSON.stringify({ query: 'seedream' }) };
  const result = await loop.execute([call], { round: 1, assistantMessageId: 'a', request, contextMessages: [] });
  assert.equal(result.messages[0].content, 'Hook replaced this discovery result.');
  assert.equal(store.get('s', 't', 'search').result.matches.length, 1, 'Original search facts stay in the journal');
  synchronizeMcpDiscovery(registry, request, [{ role: 'assistant', content: '', toolCalls: [call] }, ...result.messages]);
  assert.equal(mcpToolWasDiscovered(registry, request, 'mcp__seedream__generate'), false);
});

test('discovery carries presentation capabilities and declared UI through compact and truncated results', async () => {
  const { registry, request, search } = fixture();
  registry.resolve('mcp__seedream__generate').mcpApp = { resourceUri: 'ui://generate', readResource: async () => { throw Error('Search must not load UI'); } };
  const result = await search({ query: 'mcp__seedream__generate' });
  assert.equal(result.hostCapabilities.files.presentationTool, 'present_artifact');
  const projected = projectMcpDiscoveryResult(JSON.stringify(result));
  synchronizeMcpDiscovery(registry, request, [{ role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'mcp_search', argumentsText: '{}' }] }, { role: 'tool', toolCallId: 'c', content: projected }]);
  const compact = await search({ query: 'mcp__seedream__generate' });
  assert.equal(compact.matches[0].loaded, true); assert.equal(compact.matches[0].interface.state, 'declared');
  assert.equal(compact.matches[0].revision, result.matches[0].revision);
  const limited = JSON.parse(projectMcpDiscoveryResult(JSON.stringify(result), 0));
  assert.equal(limited.matches.length, 0); assert.equal(limited.catalog[0].interface.resourceUri, 'ui://generate');
  assert.deepEqual(limited.hostCapabilities, result.hostCapabilities);
});
