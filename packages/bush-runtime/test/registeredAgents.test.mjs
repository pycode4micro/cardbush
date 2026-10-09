import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { AGENT_REGISTRY_COMMAND, TEAM_WORKFLOW_COMMAND } from '@cardbush/bush-protocol';
import { RegisteredAgentStore, registeredAgentProfile, registerSubagentTool, SubagentTaskStore, ToolRegistry, ToolExecutionCoordinator, InMemoryRuntimeHost, childAgentToolDenial } from '../dist/index.js';
import { PluginAgentEnvironment } from '../dist/pluginAgentEnvironment.js';

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-registered-agents-'));
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'cardbush-registered-agents-')); await rm(root, { recursive: true, force: true }); });
  return root;
}
const role = (id = 'warehouse') => ({ id, name: 'Warehouse', system_prompt: 'Work from verified inventory data. Report evidence.', allowed_tools: [], memory: 'user' });
const result = request => ({ terminal: { kind: 'turn_terminal', payload: { status: 'completed', finalMessageId: 'answer' } }, session: { turns: [{ turnId: request.turnId, usage: {}, messages: [{ messageId: 'answer', message: { role: 'assistant', content: 'Verified result' } }] }] } });
let serial = 0;
function fixture(agents, root) {
  const registry = new ToolRegistry(), tasks = new SubagentTaskStore(), requests = [], saved = new Map();
  const environment = new PluginAgentEnvironment(root, registry);
  registerSubagentTool(registry, tasks, async request => { requests.push(structuredClone(request)); return result(request); }, {
    agents, saveChildRequest: async request => { saved.set(request.sessionId, structuredClone(request)); }, loadChildRequest: async id => saved.get(id),
  });
  const parent = { protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 'parent', turnId: 'turn', model: 'model', tools: registry.definitions(), permissionMode: 'all_free',
    messages: [{ role: 'system', content: 'Parent-only instructions' }, { role: 'user', content: 'Private parent history' }], metadata: {} };
  const call = (name, input, request = parent) => new ToolExecutionCoordinator({ registry, permissions: { request: async () => { throw Error('unexpected approval'); } } }).execute(
    { protocol: 'bush.tool_call.v1', id: `call-${++serial}`, name, argumentsText: JSON.stringify(input) },
    { requestId: request.requestId, sessionId: request.sessionId, turnId: request.turnId, round: 1, ordinal: serial }, undefined, { request, contextMessages: request.messages });
  return { registry, tasks, requests, saved, environment, parent, call };
}

test('registered clean identities persist, reject stale edits and stay separate from fork snapshots', async t => {
  const root = await temporary(t), agents = new RegisteredAgentStore(join(root, 'roles')), f = fixture(agents, root);
  const saved = await f.call('subagent', { action: 'save', expected_revision: 0, agent: role() });
  assert.equal(saved.kind, 'returned'); assert.equal(saved.result.revision, 1);
  const restored = new RegisteredAgentStore(join(root, 'roles'));
  assert.equal((await restored.get('warehouse')).definition.system_prompt, role().system_prompt);
  await assert.rejects(restored.put(role(), 0), /changed/);
  const options = await f.call('list_subagent_options', {});
  assert.equal(options.result.registered_agents[0].id, 'warehouse');
  const clean = await f.call('subagent', { agent_id: 'warehouse', prompt: 'Check SKU 10' });
  assert.equal(clean.kind, 'returned', JSON.stringify(clean));
  assert.equal(clean.result.mode, 'clean');
  assert.equal(clean.result.agentName, 'Warehouse');
  assert.equal(clean.result.agentProfileId, 'registered:warehouse');
  assert.equal(f.tasks.get('parent', clean.result.taskId).agentName, 'Warehouse');
  const first = f.requests[0];
  assert.deepEqual(first.prefixMessages, [{ role: 'system', content: role().system_prompt }]);
  assert.equal(first.metadata.registeredAgent.definition.id, 'warehouse');
  assert.equal(first.metadata.individuation.habits, false);
  assert.deepEqual(first.tools.map(tool => tool.name), ['agent_memory_read', 'agent_memory_write']);
  await agents.put({ ...role(), system_prompt: 'Updated role' }, 1);
  const followup = await f.call('subagent', { task_id: clean.result.taskId, prompt: 'Continue checking this SKU' });
  assert.equal(followup.kind, 'returned', JSON.stringify(followup));
  assert.equal(f.requests[1].sessionId, first.sessionId);
  assert.deepEqual(f.requests[1].prefixMessages, first.prefixMessages, 'running conversations pin the original role revision');
  const next = await f.call('subagent', { mode: 'clean', agent_id: 'warehouse', prompt: 'A different order' });
  assert.equal(next.kind, 'returned'); assert.notEqual(f.requests[2].sessionId, first.sessionId);
  assert.equal(f.requests[2].prefixMessages[0].content, 'Updated role');
  const fork = await f.call('subagent', { prompt: 'Investigate independently' });
  assert.equal(fork.result.mode, 'fork');
  f.parent.messages.push({ role: 'user', content: 'Later parent message' });
  assert.equal(f.requests[3].prefixMessages.length, 2);
  assert.equal((await f.call('subagent', { mode: 'fork', agent_id: 'warehouse', prompt: 'mix modes' })).kind, 'failed');
});

test('employee memory reuses the scoped memory environment across sessions and host recreation', async t => {
  const root = await temporary(t), agents = new RegisteredAgentStore(join(root, 'roles')), receipt = await agents.put(role(), 0);
  const f = fixture(agents, root);
  await f.call('subagent', { agent_id: 'warehouse', prompt: 'First task' });
  const request = f.requests[0], profile = registeredAgentProfile(receipt);
  const lease = await f.environment.acquire(request, profile);
  const asModel = { ...request, protocol: 'bush.model_request.v1', messages: request.prefixMessages };
  const read = await f.call('agent_memory_read', {}, asModel);
  assert.equal(read.kind, 'returned');
  const write = await f.call('agent_memory_write', { content: 'Stock adjustments require a verified receipt.', expected_revision: read.result.revision }, asModel);
  assert.equal(write.kind, 'returned', JSON.stringify(write)); await lease.release();
  const g = fixture(new RegisteredAgentStore(join(root, 'roles')), root);
  await g.call('subagent', { agent_id: 'warehouse', prompt: 'Second task' });
  const next = g.requests[0], nextLease = await g.environment.acquire(next, profile);
  assert.match(JSON.stringify(next.inputMessages), /Stock adjustments require/); await nextLease.release();
  const other = await agents.put(role('reviewer'), 0);
  await g.call('subagent', { agent_id: 'reviewer', prompt: 'Unrelated task' });
  const isolated = g.requests[1], otherLease = await g.environment.acquire(isolated, registeredAgentProfile(other));
  assert.doesNotMatch(JSON.stringify(isolated.inputMessages), /Stock adjustments require/); await otherLease.release();
});

test('read-only employee guard is enforced at tool admission, including hidden mutation attempts', async t => {
  const root = await temporary(t), agents = new RegisteredAgentStore(), f = fixture(agents, root);
  await agents.put({ ...role(), guards: ['read_only'] }, 0);
  await f.call('subagent', { agent_id: 'warehouse', prompt: 'Inspect stock' });
  const request = f.requests[0];
  assert.equal(childAgentToolDenial(request, { definition: { name: 'write_file' }, manifest: { mutating: true } }).code, 'registered_agent_read_only');
  assert.equal(childAgentToolDenial(request, { definition: { name: 'agent_memory_write' }, manifest: { mutating: true } }).code, 'registered_agent_read_only');
  assert.equal((await f.call('subagent', { action: 'save', expected_revision: 0, agent: { ...role('hooks'), hooks: ['unknown:hook'] } })).kind, 'failed');
});

test('native host exposes Team and employee management without installing a plugin', async t => {
  const root = await temporary(t);
  const host = new InMemoryRuntimeHost({ dataRoot: root, provider: { id: 'fixture', async *stream() { throw Error('No model required'); } } });
  assert.ok(host.capabilities().features.includes('native_team_workflows'));
  assert.ok(host.capabilities().features.includes('registered_clean_agents'));
  await host.sendCommand({ kind: AGENT_REGISTRY_COMMAND, payload: { action: 'save', definition: role(), expected_revision: 0 } });
  const employee = await host.sendCommand({ kind: AGENT_REGISTRY_COMMAND, payload: { action: 'get', agent_id: 'warehouse' } });
  assert.equal(employee.definition.name, 'Warehouse');
  await assert.rejects(host.sendCommand({ kind: AGENT_REGISTRY_COMMAND, payload: { action: 'get', agent_id: 'missing' } }), /unavailable/);
  await host.sendCommand({ kind: TEAM_WORKFLOW_COMMAND, payload: { action: 'save', definition: { id: 'stock', name: 'Stock', nodes: [{ id: 'check', agent_id: 'warehouse', prompt: 'Check stock' }] }, expected_revision: 0 } });
  const result = await host.sendCommand({ kind: TEAM_WORKFLOW_COMMAND, payload: { action: 'list' } });
  assert.equal(result.teams[0].definition.nodes[0].agent_id, 'warehouse');
  await host.sendCommand({ kind: 'runtime.shutdown', payload: {} });
});
