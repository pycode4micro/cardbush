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

test('search keeps long descriptions compact and only an explicitly loaded schema becomes callable', async () => {
  const { registry, request, search } = fixture();
  const result = await search({ query: 'image generator', limit: 10 });
  assert.equal(mcpToolWasDiscovered(registry, request, 'mcp__seedream__generate'), false, 'search execution alone does not imply delivery');
  const content = projectMcpDiscoveryResult(JSON.stringify(result));
  const view = JSON.parse(content);
  assert.equal(view.action, 'search');
  assert.ok(view.matches.every(tool => tool.loaded === false));
  assert.equal(view.next_step, undefined, 'static instructions belong to the tool description');
  assert.equal(view.protocol, undefined);
  assert.equal(view.sessionId, undefined);
  assert.equal(view.catalog, undefined, 'one catalog, without duplicate entries');
  assert.ok(view.matches.some(tool => tool.name === 'mcp__seedream__generate'));
  assert.ok(view.matches.every(tool => tool.inputSchema === undefined && tool.description.length <= 512));
  assert.equal(view.matches.find(tool => tool.name === 'mcp__fixture__aaa_long').descriptionTruncated, true);
  const messages = [{ role: 'assistant', content: '', toolCalls: [{ id: 'search', name: 'mcp_search', argumentsText: '{}' }] },
    { role: 'tool', toolCallId: 'search', content }];
  synchronizeMcpDiscovery(registry, request, messages);
  assert.equal(mcpToolWasDiscovered(registry, request, 'mcp__seedream__generate'), false, 'a search receipt cannot authorize a call');
  const full = await search({ action: 'load', query: 'mcp__seedream__generate' });
  messages.push({ role: 'assistant', content: '', toolCalls: [{ id: 'load', name: 'mcp_search', argumentsText: '{"action":"load","query":"mcp__seedream__generate"}' }] },
    { role: 'tool', toolCallId: 'load', content: projectMcpDiscoveryResult(JSON.stringify(full)) });
  synchronizeMcpDiscovery(registry, request, messages);
  assert.equal(mcpToolWasDiscovered(registry, request, 'mcp__seedream__generate'), true);
  assert.equal((await search({ query: 'mcp__seedream__generate' })).matches[0].loaded, true);
  assert.equal(mcpToolWasDiscovered(registry, request, 'mcp__fixture__aaa_long'), false);
  synchronizeMcpDiscovery(registry, request, []);
  assert.equal(mcpToolWasDiscovered(registry, request, 'mcp__seedream__generate'), false, 'compaction cannot retain a hidden schema');
  assert.equal((await search({ query: 'mcp__seedream__generate' })).matches[0].loaded, false);
});

test('exact names rank before description mentions; pagination and isolated large loads remain complete', async () => {
  const { search } = fixture();
  assert.equal((await search({ query: 'upload-asset-from-url', limit: 1 })).matches[0].tool, 'upload-asset-from-url');
  const first = await search({ query: '*', limit: 2 });
  const second = await search({ cursor: first.next_cursor, limit: 2 });
  assert.equal(new Set([...first.matches, ...second.matches].map(tool => tool.name)).size, 4);
  const isolated = await search({ action: 'load', query: 'mcp__fixture__aaa_long' });
  assert.equal(projectMcpDiscoveryResult(JSON.stringify(isolated)), undefined, 'oversized default loads use the archive');
  const view = JSON.parse(projectMcpDiscoveryResult(JSON.stringify(isolated), 128000));
  assert.deepEqual(view.matches[0], isolated.matches[0]);
  assert.ok(view.matches[0].description.length > 16_000);
  assert.equal(view.catalog, undefined);
  for (const reload of [true, false]) assert.throws(() => search({ query: 'mcp__fixture__aaa_long', reload }), /Unknown MCP search fields: reload/);
  assert.throws(() => search({ query: '*', typo: true }), /Unknown MCP search fields: typo/);
  for (const value of [null, [], 'query', 1]) assert.throws(() => search(value), /requires an object/);
  await assert.rejects(() => search({ action: 'load', query: 'image generator' }), /exact name/);
  await assert.rejects(() => search({ action: 'load', query: '*', server: 'fixture' }), /exact name/);
  assert.throws(() => search({ action: 'unexpected', query: '*' }), /action/);
  assert.throws(() => search({ action: 'load', query: 'generate', offset: 1 }), /offset/);
});

test('loads use exact identities and preserve current visibility across duplicate server tool names', async () => {
  const { registry, request, search } = fixture();
  registry.register({ definition: { name: 'mcp__other__generate', description: 'Another image tool', inputSchema: { type: 'object' } },
    manifest, decodeInput: value => value, execute: () => ({}), mcpHook: { server: 'other', tool: 'generate', call: async () => ({}) } });
  request.tools = registry.definitions();
  await assert.rejects(() => search({ action: 'load', query: 'generate' }), /ambiguous/);
  assert.equal((await search({ action: 'load', query: 'generate', server: 'seedream' })).matches[0].name, 'mcp__seedream__generate');
  assert.equal((await search({ action: 'load', query: 'mcp__other__generate' })).matches[0].name, 'mcp__other__generate');
  registry.resolve('mcp__other__generate').sessionScope = 'different-session';
  await assert.rejects(() => search({ action: 'load', query: 'mcp__other__generate' }), /unavailable/);
  request.tools = request.tools.filter(tool => tool.name !== 'mcp__seedream__generate');
  await assert.rejects(() => search({ action: 'load', query: 'mcp__seedream__generate' }), /unavailable/);
});

test('a load constrained by context is archived intact and cannot make an unseen schema callable', async () => {
  const { registry, request } = fixture();
  const store = new ToolExecutionStore();
  const loop = new RuntimeToolLoop({ registry, executionStore: store, eventLog: new InMemoryRuntimeEventLog(),
    identity: { requestId: 'r', sessionId: 's', turnId: 't' } });
  const call = { protocol: 'bush.tool_call.v1', id: 'load', name: 'mcp_search', argumentsText: JSON.stringify({ action: 'load', query: 'mcp__fixture__aaa_long' }) };
  const result = await loop.execute([call], { round: 1, assistantMessageId: 'a', request, contextMessages: [], modelContextIngressBudgetTokens: 250 });
  const receipt = JSON.parse(result.messages[0].content);
  assert.equal(receipt.archived, true); assert.match(receipt.locator, /^tool-result:/);
  const raw = store.get('s', 't', 'load').result;
  assert.equal(raw.action, 'load'); assert.equal(raw.matches[0].description.length, 'image generator '.repeat(5000).length);
  assert.ok(raw.matches[0].inputSchema);
  synchronizeMcpDiscovery(registry, request, [{ role: 'assistant', content: '', toolCalls: [call] }, ...result.messages]);
  assert.equal(mcpToolWasDiscovered(registry, request, 'mcp__fixture__aaa_long'), false);
});

test('load size limits preserve whole definitions and explicitly defer omitted schemas', () => {
  for (const count of [1, 3, 10]) for (const length of [10, 15_999, 80_000, 150_000]) for (const budget of [0, 6000, 16000, 128000]) {
    const result = { protocol: 'bush.mcp_discovery.v1', sessionId: 's', action: 'load', total: count, more: false,
      matches: Array.from({ length: count }, (_, i) => ({ name: `mcp__s__tool${i}`, server: 's', tool: `tool${i}`, revision: 'v1',
        description: '文'.repeat(length), inputSchema: { type: 'object', properties: { requiredDetail: { const: i } } } })) };
    const raw = JSON.stringify(result), rendered = projectMcpDiscoveryResult(raw, budget);
    if (rendered === undefined) { assert.ok(raw.length > budget); continue; }
    const view = JSON.parse(rendered); assert.ok(rendered.length <= budget);
    assert.ok(view.matches.length > 0);
    for (const match of view.matches) assert.deepEqual(match, result.matches.find(item => item.name === match.name));
    assert.deepEqual(new Set([...view.matches.map(item => item.name), ...(view.deferred ?? [])]), new Set(result.matches.map(item => item.name)));
  }
});

test('a batch larger than the delivery budget loads only visible whole schemas and defers the rest', async () => {
  const { registry, request } = fixture();
  const names = ['first', 'second', 'third'].map(name => `mcp__batch__${name}`);
  for (const name of names) registry.register({ definition: { name, description: 'description '.repeat(750), inputSchema: { type: 'object' } },
    manifest, decodeInput: value => value, execute: () => ({}), mcpHook: { server: 'batch', tool: name, call: async () => ({}) } });
  request.tools = registry.definitions();
  const loop = new RuntimeToolLoop({ registry, eventLog: new InMemoryRuntimeEventLog(), identity: { requestId: 'r', sessionId: 's', turnId: 't' } });
  const call = { protocol: 'bush.tool_call.v1', id: 'batch-load', name: 'mcp_search', argumentsText: JSON.stringify({ action: 'load', names }) };
  const result = await loop.execute([call], { round: 1, assistantMessageId: 'a', request, contextMessages: [] });
  const view = JSON.parse(result.messages[0].content);
  assert.equal(view.archived, undefined); assert.ok(result.messages[0].content.length <= 16000);
  assert.equal(view.matches.length, 1); assert.deepEqual(view.deferred, names.slice(1));
  synchronizeMcpDiscovery(registry, request, [{ role: 'assistant', content: '', toolCalls: [call] }, ...result.messages]);
  for (const name of names) assert.equal(mcpToolWasDiscovered(registry, request, name), name === names[0]);
});

test('a discovery receipt requires an explicit current action', () => {
  for (const action of [undefined, null, 'reload']) {
    assert.equal(projectMcpDiscoveryResult(JSON.stringify({ protocol: 'bush.mcp_discovery.v1', sessionId: 's', action, matches: [] })), undefined);
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
  const result = await search({ action: 'load', query: 'mcp__seedream__generate' });
  assert.deepEqual(result.hostCapabilities.interfaces, {
    mcpApps: true, openAiBridge: true, presentation: 'conversation', statusTool: 'mcp_app_status',
  });
  assert.equal(result.hostCapabilities.files, undefined);
  const projected = projectMcpDiscoveryResult(JSON.stringify(result));
  synchronizeMcpDiscovery(registry, request, [{ role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'mcp_search', argumentsText: '{}' }] }, { role: 'tool', toolCallId: 'c', content: projected }]);
  const compact = await search({ query: 'mcp__seedream__generate' });
  assert.equal(compact.matches[0].loaded, true);
  assert.equal(compact.matches[0].inputSchema, undefined);
  assert.equal(JSON.parse(projected).matches[0].interface.resourceUri, 'ui://generate');
  assert.equal(projectMcpDiscoveryResult(JSON.stringify(result), 0), undefined, 'a full load that does not fit uses the ordinary archive');
});
