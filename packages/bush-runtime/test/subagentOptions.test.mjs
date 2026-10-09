import assert from 'node:assert/strict';
import test from 'node:test';
import { RegisteredAgentStore, ToolRegistry, ToolExecutionCoordinator } from '../dist/index.js';
import { registerSubagentOptions } from '../dist/subagentOptions.js';

const manifest = { effect_kind: 'observation', operation: 'fixture.read', risk: 'low', owner: 'fixture', dispatch_scope: 'turn', mutating: false };
function fixture(options = {}, count = 580) {
  const registry = new ToolRegistry();
  for (let i = 0; i < count; i++) registry.register({ definition: {
    name: `mcp__fixture__${i % 2 ? 'read' : 'write'}_${String(i).padStart(3, '0')}`, description: 'Fixture capability', inputSchema: { type: 'object' },
  }, manifest, visibleToChild: i % 2 === 1, decodeInput: value => value, execute: () => ({ ok: true }) });
  registerSubagentOptions(registry, options);
  const request = { protocol: 'bush.model_request.v1', requestId: 'request', sessionId: 'parent', turnId: 'turn', model: 'fixture',
    permissionMode: 'all_free', maxOutputTokens: 4096, tools: registry.definitions(), messages: [], metadata: {} };
  const coordinator = new ToolExecutionCoordinator({ registry, permissions: { request: async () => assert.fail('Discovery must not need approval') } });
  let serial = 0;
  const call = async input => {
    const result = await coordinator.execute({ protocol: 'bush.tool_call.v1', id: `call-${++serial}`, name: 'list_subagent_options', argumentsText: JSON.stringify(input) },
      { requestId: request.requestId, sessionId: request.sessionId, turnId: request.turnId, round: 1, ordinal: serial }, undefined, { request, contextMessages: [] });
    assert.equal(result.kind, 'returned', JSON.stringify(result));
    return result.result;
  };
  return { registry, call };
}
const role = { id: 'fixture:review', name: 'review', description: 'Review changes for correctness.', prompt: 'PRIVATE ROLE INSTRUCTIONS',
  tools: ['read_file'], disallowedTools: ['write_file'], memory: 'project', mcpServers: [{ inventory: { headers: { Authorization: 'PRIVATE-CREDENTIAL' } } }] };

test('580 inherited tools do not inflate default agent discovery or load unused settings', async () => {
  const f = fixture({ agents: new RegisteredAgentStore(), loadPluginAgents: async () => [role], remoteAgents: { list: async () => [] },
    models: { list: async () => assert.fail('Agent discovery must not load models') }, loadHooks: async () => assert.fail('Agent discovery must not load hooks') });
  const result = await f.call({});
  assert.deepEqual(result.registered_agents, []);
  assert.deepEqual(result.agent_roles, [{ id: role.id, description: role.description }]);
  assert.equal(result.total, 1);
  assert.equal(result.next_offset, null);
  const serialized = JSON.stringify(result);
  assert.ok(serialized.length < 1000, `${serialized.length} characters`);
  assert.doesNotMatch(serialized, /mcp__fixture|PRIVATE|settings_schema|disallowedTools/);
});

test('employee lists are bounded and searchable without losing configuration on explicit reads', async () => {
  const agents = new RegisteredAgentStore();
  for (let i = 0; i < 45; i++) await agents.put({ id: `employee-${String(i).padStart(2, '0')}`, name: `Employee ${i}`,
    description: 'Capability '.repeat(200) + `unique-needle-${i}`, system_prompt: 'PRIVATE SYSTEM '.repeat(2000), guards: ['read_only'], memory: 'local' }, 0);
  const f = fixture({ agents }, 0), ids = [];
  let offset = 0;
  do {
    const page = await f.call({ offset, limit: 50 });
    assert.equal(page.total, 45);
    assert.ok(JSON.stringify(page).length < 7000);
    assert.ok(page.registered_agents.every(agent => !('system_prompt' in agent) && !('memory' in agent) && !('guards' in agent)));
    ids.push(...page.registered_agents.map(agent => agent.id));
    offset = page.next_offset;
  } while (offset !== null);
  assert.equal(new Set(ids).size, 45);
  assert.equal(ids.length, 45, 'paging must neither repeat nor skip entries');
  const found = await f.call({ query: 'UNIQUE-NEEDLE-44' });
  assert.equal(found.total, 1, 'search uses the complete description, even beyond the preview');
  assert.equal(found.registered_agents[0].id, 'employee-44');
  const detail = await f.call({ agent_id: 'employee-44' });
  assert.deepEqual(detail, await agents.get('employee-44'));
});

test('plugin role detail is opt-in and does not expose inline MCP credentials', async () => {
  const f = fixture({ loadPluginAgents: async () => [role], remoteAgents: { list: async () => assert.fail('A role read must not enumerate remote hosts') } }, 0);
  const detail = await f.call({ agent_type: role.id });
  assert.equal(detail.prompt, role.prompt);
  assert.deepEqual(detail.tools, role.tools);
  assert.deepEqual(detail.mcpServers, ['inventory']);
  assert.equal(detail.model, 'inherit');
  assert.doesNotMatch(JSON.stringify(detail), /PRIVATE-CREDENTIAL/);
});

test('tool discovery searches and pages without loading agents, hooks or providers', async () => {
  const unavailable = async () => assert.fail('Tool discovery must only inspect the inherited catalog');
  const f = fixture({ loadPluginAgents: unavailable, loadHooks: unavailable, models: { list: unavailable }, remoteAgents: { list: unavailable } });
  const names = [];
  let offset = 0;
  do {
    const page = await f.call({ section: 'tools', query: 'MCP__FIXTURE__READ', offset, limit: 50 });
    assert.equal(page.total, 290);
    assert.ok(JSON.stringify(page).length < 6500);
    assert.ok(page.tools.every(tool => tool.child_available));
    names.push(...page.tools.map(tool => tool.name));
    offset = page.next_offset;
  } while (offset !== null);
  assert.equal(names.length, 290);
  assert.equal(new Set(names).size, 290);
  const denied = await f.call({ section: 'tools', query: 'write_000' });
  assert.equal(denied.tools[0].child_available, false);
  assert.ok(denied.tools[0].restriction);
});

test('settings are explicit and invalid discovery combinations fail before loading data', async () => {
  let calls = 0;
  const f = fixture({ models: { list: async () => { calls++; return [{ id: 'configured', model: 'model', maxOutputTokens: 8192, apiKey: 'PRIVATE-KEY' }]; } },
    loadHooks: async () => [{ id: 'trusted', event: 'PreToolUse', matcher: '*', trusted: true, command: 'PRIVATE-COMMAND' }, { id: 'untrusted', trusted: false }],
    loadPluginAgents: async () => assert.fail('Settings must not load Agent profiles') }, 0);
  const decode = f.registry.resolve('list_subagent_options').decodeInput;
  for (const input of [[], { section: 'unknown' }, { section: 'settings', query: 'x' }, { agent_id: 'x', offset: 1 }, { agent_id: 'x', agent_type: 'y' },
    { section: 'tools', agent_id: 'x' }, { limit: 51 }, { limit: 0 }, { offset: -1 }, { offset: 0.5 }, { query: ' ' }, { details: true }]) {
    assert.throws(() => decode(input), undefined, JSON.stringify(input));
  }
  assert.equal(calls, 0);
  const settings = await f.call({ section: 'settings' });
  assert.equal(calls, 1);
  assert.deepEqual(settings.models, [{ id: 'configured', model: 'model', maxOutputTokens: 8192 }]);
  assert.deepEqual(settings.hooks, [{ id: 'trusted', event: 'PreToolUse', matcher: '*' }]);
  assert.equal(settings.defaults.max_output_tokens, 4096);
  assert.doesNotMatch(JSON.stringify(settings), /PRIVATE|settings_schema|registered_agents/);
});
