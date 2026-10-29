import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { AGENT_REGISTRY_COMMAND, TEAM_WORKFLOW_COMMAND } from '@cardbush/bush-protocol';
import { RegisteredAgentStore, registerSubagentTool, SubagentTaskStore, ToolRegistry, ToolExecutionCoordinator, InMemoryRuntimeHost, childAgentToolDenial } from '../dist/index.js';

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-registered-agents-'));
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'cardbush-registered-agents-')); await rm(root, { recursive: true, force: true }); });
  return root;
}
const role = (id = 'warehouse') => ({ id, name: 'Warehouse', system_prompt: 'Work from verified inventory data. Report evidence.', allowed_tools: [] });

test('registered remote roles pin identity and revision without copying local tools or parent history', async t => {
  const root = await temporary(t), agents = new RegisteredAgentStore(join(root, 'roles')), tasks = new SubagentTaskStore(), registry = new ToolRegistry();
  const requests = []; let identity = 'instance';
  registerSubagentTool(registry, tasks, () => assert.fail('A remote role must not create a local child'), { agents, asyncDispatch: false,
    remoteAgents: { list: async () => [{ id: 'worker', name: 'Worker', agentId: identity }], run: async request => { requests.push(request); return { status: 'completed', finalResponse: 'reviewed', errorMessage: '', usage: {} }; } } });
  const parent = { requestId: 'r', sessionId: 'parent', turnId: 'turn', model: 'private-model', tools: registry.definitions(), metadata: {}, permissionMode: 'all_free' };
  const coordinator = new ToolExecutionCoordinator({ registry, permissions: { request: () => assert.fail('Unexpected approval') } });
  const invoke = input => coordinator.execute({ protocol: 'bush.tool_call.v1', id: crypto.randomUUID(), name: 'subagent', argumentsText: JSON.stringify(input) },
    { requestId: 'r', sessionId: 'parent', turnId: 'turn', round: 1, ordinal: 0 }, undefined, { request: parent, contextMessages: [{ role: 'system', content: 'PRIVATE HISTORY' }] });
  const role = { id: 'reviewer', name: 'Release reviewer', system_prompt: 'Review the release', remote: { connection_id: 'worker', agent_id: 'instance' } };
  assert.equal((await invoke({ action: 'save', expected_revision: 0, agent: { ...role, allowed_tools: ['terminal_exec'] } })).kind, 'failed');
  assert.equal((await invoke({ action: 'save', expected_revision: 0, agent: role })).kind, 'returned');
  const first = await invoke({ agent_id: 'reviewer', prompt: 'Review today' }); assert.equal(first.kind, 'returned', JSON.stringify(first));
  const original = tasks.list('parent')[0]; assert.equal(original.agentName, 'Release reviewer');
  assert.equal(requests[0].worker.revision, 1); assert.doesNotMatch(JSON.stringify(requests[0]), /PRIVATE HISTORY|private-model|terminal_exec/);
  await agents.put({ ...role, system_prompt: 'Changed instructions' }, 1);
  assert.equal((await invoke({ task_id: original.taskId, prompt: 'Continue' })).kind, 'returned');
  assert.equal(requests[1].worker.revision, 1); assert.equal(requests[1].sessionId, requests[0].sessionId);
  identity = 'different-instance';
  assert.equal((await invoke({ agent_id: 'reviewer', prompt: 'New task' })).kind, 'failed');
  identity = 'instance'; await agents.put({ ...role, enabled: false }, 2);
  assert.equal((await invoke({ task_id: original.taskId, prompt: 'Continue disabled' })).kind, 'failed');
  assert.equal(requests.length, 2);
});
const result = request => ({ terminal: { kind: 'turn_terminal', payload: { status: 'completed', finalMessageId: 'answer' } }, session: { turns: [{ turnId: request.turnId, usage: {}, messages: [{ messageId: 'answer', message: { role: 'assistant', content: 'Verified result' } }] }] } });
let serial = 0;
function fixture(agents, root) {
  const registry = new ToolRegistry(), tasks = new SubagentTaskStore(), requests = [], saved = new Map();
  registerSubagentTool(registry, tasks, async request => { requests.push(structuredClone(request)); return result(request); }, {
    agents, saveChildRequest: async request => { saved.set(request.sessionId, structuredClone(request)); }, loadChildRequest: async id => saved.get(id),
  });
  const parent = { protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 'parent', turnId: 'turn', model: 'model', tools: registry.definitions(), permissionMode: 'all_free',
    messages: [{ role: 'system', content: 'Parent-only instructions' }, { role: 'user', content: 'Private parent history' }], metadata: {} };
  const call = (name, input, request = parent) => new ToolExecutionCoordinator({ registry, permissions: { request: async () => { throw Error('unexpected approval'); } } }).execute(
    { protocol: 'bush.tool_call.v1', id: `call-${++serial}`, name, argumentsText: JSON.stringify(input) },
    { requestId: request.requestId, sessionId: request.sessionId, turnId: request.turnId, round: 1, ordinal: serial }, undefined, { request, contextMessages: request.messages });
  return { registry, tasks, requests, saved, parent, call };
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
  assert.deepEqual(first.tools, []);
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

test('read-only employee guard is enforced at tool admission, including hidden mutation attempts', async t => {
  const root = await temporary(t), agents = new RegisteredAgentStore(), f = fixture(agents, root);
  await agents.put({ ...role(), guards: ['read_only'] }, 0);
  await f.call('subagent', { agent_id: 'warehouse', prompt: 'Inspect stock' });
  const request = f.requests[0];
  assert.equal(childAgentToolDenial(request, { definition: { name: 'write_file' }, manifest: { mutating: true } }).code, 'registered_agent_read_only');
  assert.equal(childAgentToolDenial(request, { definition: { name: 'terminal_exec' }, manifest: { mutating: true } }).code, 'registered_agent_read_only');
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
