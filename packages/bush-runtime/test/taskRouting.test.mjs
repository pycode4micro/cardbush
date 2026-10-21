import test from 'node:test';
import assert from 'node:assert/strict';
import { RegisteredAgentStore, SubagentTaskStore, TeamWorkflowManager, ToolRegistry, ToolExecutionCoordinator, registerSubagentTool } from '../dist/index.js';
import { RuntimeTaskTools } from '../dist/taskTools.js';
import { registerBuiltinToolDisclosure, synchronizeBuiltinSchemas } from '../dist/builtinToolDisclosure.js';
import { modelToolDefinitions } from '../dist/mcpToolDiscovery.js';

// In-memory stores and a deterministic child runner; no provider or plugin calls.
async function fixture(t) {
  const registry = new ToolRegistry(), store = new SubagentTaskStore(), agents = new RegisteredAgentStore();
  await agents.put({ id: 'employee-review', name: 'Reviewer', system_prompt: 'Review fixture evidence.', memory: 'none' }, 0);
  const saved = new Map(), executions = [], guidance = [];
  let taskSequence = 0;
  const children = registerSubagentTool(registry, store, async request => {
    executions.push(request);
    return { terminal: { kind: 'turn_terminal', payload: { status: 'completed', finalMessageId: 'answer' } },
      session: { turns: [{ turnId: request.turnId, messages: [{ messageId: 'answer', message: { role: 'assistant', content: 'Fixture checked.' } }] }] } };
  }, { agents, createTaskId: () => `child-task-${++taskSequence}`,
    saveChildRequest: async request => saved.set(request.sessionId, structuredClone(request)),
    loadChildRequest: async id => saved.get(id), guideChild: async message => guidance.push(message) });
  const teams = new TeamWorkflowManager(agents, children.dispatch);
  teams.register(registry); t.after(() => teams.close());
  const tasks = new RuntimeTaskTools(async (_context, promises) => { await Promise.all(promises); return 'task_completed'; });
  tasks.addSource(context => teams.taskHandles(context.sessionId));
  tasks.addSource(context => store.list(context.sessionId).filter(task => task.origin === 'subagent').map(task => ({
    task_id: task.taskId, kind: 'subagent', status: task.status, revision: String(task.revision), result: { output: task.finalResponse },
  })));
  tasks.register(registry); registerBuiltinToolDisclosure(registry);
  const request = { protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 'parent', turnId: 't', model: 'offline-fixture',
    tools: registry.definitions(), messages: [{ role: 'system', content: 'Stable fixture instructions.' }], permissionMode: 'all_free', metadata: {} };
  const messages = [], coordinator = new ToolExecutionCoordinator({ registry }); let ordinal = 0;
  const run = async (name, args, sessionId = 'parent') => {
    const id = `call-${++ordinal}`, argumentsText = JSON.stringify(args);
    const scoped = sessionId === 'parent' ? request : { ...request, sessionId, metadata: {} };
    const result = await coordinator.execute({ protocol: 'bush.tool_call.v1', id, name, argumentsText },
      { requestId: 'r', sessionId, turnId: 't', round: 1, ordinal }, undefined, { request: scoped, contextMessages: sessionId === 'parent' ? messages : [] });
    if (result.kind === 'returned' && sessionId === 'parent') messages.push({ role: 'assistant', content: '', toolCalls: [{ id, name, argumentsText }] },
      { role: 'tool', toolCallId: id, content: JSON.stringify(result.result) });
    return result;
  };
  const call = async (name, args) => { const result = await run(name, args); assert.equal(result.kind, 'returned', JSON.stringify(result)); return result.result; };
  const reject = async (name, args, expected, owner) => {
    const result = await run(name, args, owner); assert.equal(result.kind, 'failed', JSON.stringify(result)); assert.match(result.error.message, expected);
  };
  return { registry, store, teams, tasks, agents, request, messages, executions, guidance, call, run, reject };
}
const workflow = { id: 'workflow-review', name: 'Review workflow', nodes: [{ id: 'review-node', agent_id: 'employee-review', prompt: 'Review fixture evidence.' }] };

test('subagent distinguishes employee, child task and session IDs without starting or guiding the wrong child', async t => {
  const f = await fixture(t);
  const child = await f.call('subagent', { agent_id: 'employee-review', prompt: 'Review once.' });
  assert.equal(f.executions.length, 1);
  const before = f.store.list('parent');
  for (const task_id of ['employee-review', child.childSessionId, 'workflow-review', 'team-run-fixture', 'review-node']) {
    await f.reject('subagent', { task_id, prompt: 'Continue.' }, /taskId.*tasks list/);
  }
  await f.reject('subagent', { task_id: child.taskId, prompt: 'Continue.' }, /owned by this parent/, 'other-parent');
  for (const agent_id of [child.taskId, child.childSessionId, 'workflow-review']) {
    await f.reject('subagent', { agent_id, prompt: 'Continue.' }, /agent_id.*task_id/);
  }
  for (const targets of [
    { agent_id: 'employee-review', task_id: child.taskId },
    { target_agent: 'remote-agent', task_id: child.taskId },
    { agent_id: 'employee-review', target_agent: 'remote-agent' },
  ]) await f.reject('subagent', { ...targets, prompt: 'Continue.' }, /Choose one target/);
  assert.equal(f.executions.length, 1); assert.deepEqual(f.guidance, []);
  assert.deepEqual(f.store.list('parent'), before);
  const continued = await f.call('subagent', { task_id: child.taskId, prompt: 'Review a second time.' });
  assert.equal(f.executions.length, 2);
  assert.equal(continued.childSessionId, child.childSessionId);
  assert.notEqual(continued.taskId, child.taskId);
  assert.equal(f.store.get('parent', continued.taskId).resumedFromTaskId, child.taskId);
});

test('team definition, run and node IDs stay separate across direct and recalled calls', async t => {
  const f = await fixture(t);
  await f.call('get_tool_schema', { name: 'team' });
  await f.call('call_tool', { name: 'team', arguments: { action: 'save', definition: workflow, expected_revision: 0 } });
  const started = await f.call('team', { action: 'run', team_id: workflow.id, input: 'Check fixture.' });
  const finished = await f.call('tasks', { action: 'wait', task_ids: [started.task_id] });
  assert.equal(finished.tasks[0].status, 'completed');
  assert.equal(started.task_id, started.run_id);
  const node = f.store.list('parent').find(task => task.origin === 'team');
  const before = await f.teams.listRuns('parent');
  for (const run_id of [workflow.id, 'employee-review', 'review-node', node.taskId, node.childSessionId]) {
    for (const action of ['status', 'wait', 'stop', 'resume']) {
      await f.reject('call_tool', { name: 'team', arguments: { action, run_id } }, /run_id.*section=runs/);
    }
  }
  for (const team_id of [started.run_id, node.taskId, node.childSessionId, 'employee-review']) {
    await f.reject('team', { action: 'run', team_id, input: 'Check fixture.' }, /team_id.*run_id/);
    await f.reject('team', { action: 'get', team_id }, /team_id.*run_id/);
  }
  await f.reject('team', { action: 'run', run_id: started.run_id, input: 'Check fixture.' }, /Accepted fields: team_id/);
  await f.reject('team', { action: 'resume', team_id: workflow.id }, /Accepted fields: run_id/);
  await f.reject('team', { action: 'resume', run_id: started.run_id, team_id: workflow.id }, /Accepted fields: run_id/);
  for (const action of ['status', 'wait', 'stop', 'resume']) {
    await f.reject('team', { action, run_id: started.run_id }, /unavailable in this conversation/, 'other-parent');
  }
  await f.reject('subagent', { task_id: node.taskId, prompt: 'Bypass the workflow.' }, /Team workflow node.*run_id/);
  assert.equal(f.executions.length, 1); assert.deepEqual(f.guidance, []);
  assert.deepEqual(await f.teams.listRuns('parent'), before);
  const runs = await f.call('team', { action: 'list', section: 'runs' });
  assert.equal(runs.runs[0].run_id, started.run_id);
  assert.equal((await f.call('team', { action: 'resume', run_id: started.run_id })).status, 'completed');
  assert.equal(f.executions.length, 1, 'resuming a completed workflow must not duplicate work');
});

test('tasks rejects wrong-domain and foreign IDs before any mixed selection reads or controls a task', async t => {
  const f = await fixture(t), effects = [];
  f.tasks.addSource(context => context.sessionId === 'parent' ? [{ task_id: 'existing-task', kind: 'subagent', status: 'running', revision: '1',
    readResult: () => effects.push('read'), wait: async () => effects.push('wait'), stop: async () => effects.push('stop'),
    cancelObservation: () => effects.push('cancel'), readConversation: async () => effects.push('conversation') }] : []);
  for (const id of ['employee-review', workflow.id, 'review-node', 'child-session']) {
    for (const action of ['inspect', 'wait', 'stop', 'cancel_observation']) {
      await f.reject('tasks', { action, task_ids: ['existing-task', id] }, /tasks list.*task_id/);
    }
    await f.reject('tasks', { action: 'conversation', task_ids: [id] }, /tasks list.*task_id/);
  }
  await f.reject('tasks', { action: 'stop', task_ids: ['existing-task'] }, /not available in this conversation/, 'other-parent');
  assert.deepEqual(effects, []);
  assert.equal((await f.call('tasks', { action: 'inspect', task_ids: ['existing-task'] })).tasks[0].task_id, 'existing-task');
  assert.deepEqual(effects, ['read']);
});

test('tasks prefers canonical IDs over aliases and rejects ambiguous aliases before any controls', async t => {
  const f = await fixture(t), stopped = [], cancelled = [];
  f.tasks.addSource(() => [
    { task_id: 'terminal', aliases: ['team-run', 'ambiguous', 'terminal-notice'], kind: 'terminal' },
    { task_id: 'team-run', kind: 'team' },
    { task_id: 'child', aliases: ['ambiguous'], kind: 'subagent' },
  ].map(task => ({ ...task, status: 'running', revision: '1', result: task.task_id,
    stop: async () => { stopped.push(task.task_id); return { stopped: true }; }, cancelObservation: () => cancelled.push(task.task_id) })));
  const exact = await f.call('tasks', { action: 'stop', task_ids: ['team-run'] });
  assert.deepEqual(stopped, ['team-run']);
  assert.equal(exact.tasks[0].kind, 'team');
  for (const action of ['inspect', 'wait', 'stop', 'cancel_observation']) {
    await f.reject('tasks', { action, task_ids: ['terminal', 'ambiguous'] }, /ambiguous.*exact task_id/);
  }
  assert.deepEqual(stopped, ['team-run']); assert.deepEqual(cancelled, []);
  const alias = await f.call('tasks', { action: 'stop', task_ids: ['terminal-notice', 'terminal'] });
  assert.deepEqual(stopped, ['team-run', 'terminal']);
  assert.equal(alias.controls.length, 1, 'a canonical ID and its alias must not dispatch twice');
});

test('routing descriptions and ID guidance are available without changing frozen tools during recall or execution', async t => {
  const f = await fixture(t);
  const native = structuredClone(f.registry.definitions()), requestTools = structuredClone(f.request.tools);
  const current = modelToolDefinitions(f.registry, f.request);
  for (const catalog of [native, current]) {
    assert.match(catalog.find(tool => tool.name === 'subagent').description, /independent assignments.*several agents/);
    assert.match(catalog.find(tool => tool.name === 'team').description, /dependency workflows/);
    assert.match(catalog.find(tool => tool.name === 'tasks').description, /Creates no work/);
  }
  assert.match(current.find(tool => tool.name === 'subagent').inputSchema.properties.task_id.description, /taskId.*childSessionId/);
  assert.ok(current.find(tool => tool.name === 'subagent').inputSchema.properties.name);
  assert.match(current.find(tool => tool.name === 'team').inputSchema.properties.run_id.description, /team_id.*node ID/);
  // Simulate declarations already bound to an existing conversation before a host update.
  const frozen = structuredClone(current);
  delete frozen.find(tool => tool.name === 'subagent').inputSchema.properties.name;
  for (const tool of frozen.filter(tool => ['subagent', 'team', 'tasks'].includes(tool.name))) tool.description = `Previously saved ${tool.name} description.`;
  f.request.metadata.mcpModelToolSnapshot.tools = structuredClone(frozen);
  const prefix = JSON.stringify(frozen), system = JSON.stringify(f.request.messages);
  for (const name of ['subagent', 'team', 'tasks']) {
    const loaded = await f.call('get_tool_schema', { name });
    assert.equal(loaded.matches[0].definition.description, native.find(tool => tool.name === name).description);
    assert.equal(JSON.stringify(modelToolDefinitions(f.registry, f.request)), prefix);
  }
  const child = await f.call('call_tool', { name: 'subagent', arguments: { prompt: 'Check the fixture.' } });
  await f.call('call_tool', { name: 'tasks', arguments: { action: 'inspect', task_ids: [child.taskId] } });
  await f.reject('tasks', { action: 'stop', task_ids: ['employee-review'] }, /tasks list/);
  assert.equal(JSON.stringify(modelToolDefinitions(f.registry, f.request)), prefix);
  f.messages.length = 0; synchronizeBuiltinSchemas(f.registry, f.request, []);
  assert.equal(JSON.stringify(modelToolDefinitions(f.registry, f.request)), prefix, 'clearing recalled receipts preserves the provider contract');
  assert.equal(JSON.stringify(f.request.messages), system);
  assert.deepEqual(f.request.tools, requestTools); assert.deepEqual(f.registry.definitions(), native);
});
