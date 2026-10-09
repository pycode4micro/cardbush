import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryRuntimeHost, SessionStore, SubagentTaskStore, ToolRegistry, ToolExecutionCoordinator, registerSubagentTool } from '../dist/index.js';

test('one subagent entry guides the current child and rejects stale names and foreign IDs', async () => {
  const registry = new ToolRegistry(), tasks = new SubagentTaskStore(), guidance = [], browserScopes = [];
  let dispatched = 0;
  registerSubagentTool(registry, tasks, async () => { dispatched++; throw Error('must not dispatch'); }, {
    inheritBrowserScope: async (parent, child) => { browserScopes.push([parent, child]); },
    guideChild: async input => { assert.deepEqual(browserScopes, [['parent', input.sessionId]], 'new browser selection is available before guidance is delivered'); guidance.push(input); return { status: 'queued' }; },
    loadPluginAgents: async () => [{ id: 'fixture:reviewer', description: 'Read only', mcpServers: ['docs'] }],
  });
  const request = { requestId: 'r', sessionId: 'parent', turnId: 't', model: 'fixture', tools: registry.definitions(), metadata: {}, permissionMode: 'task_free' };
  const coordinator = new ToolExecutionCoordinator({ registry, permissions: { request: async () => { throw Error('unexpected permission'); } } });
  const invoke = (name, args, sessionId = 'parent') => coordinator.execute(
    { protocol: 'bush.tool_call.v1', id: crypto.randomUUID(), name, argumentsText: JSON.stringify(args) },
    { requestId: 'r', sessionId, turnId: 't', round: 1, ordinal: 0 }, undefined, { request: { ...request, sessionId }, contextMessages: [] });
  tasks.start({ taskId: 'old', parentSessionId: 'parent', parentTurnId: 'previous', childSessionId: 'child', childTurnId: 'first', prompt: 'first', inheritContext: true, inheritedMessageCount: 0 });
  tasks.finish({ parentSessionId: 'parent', taskId: 'old', status: 'completed', finalResponse: 'done', errorMessage: '', usage: {} });
  tasks.start({ taskId: 'current', parentSessionId: 'parent', parentTurnId: 'previous', childSessionId: 'child', childTurnId: 'second', prompt: 'next', inheritContext: true, inheritedMessageCount: 0 });
  const receipt = await invoke('subagent', { task_id: 'old', prompt: 'Keep it read only' });
  assert.equal(receipt.result.status, 'message_queued'); assert.equal(receipt.result.taskId, 'current');
  assert.equal(guidance[0].turnId, 'second'); assert.equal(guidance[0].mode, 'interrupt_and_continue');
  assert.equal((await invoke('subagent', { task_id: 'old', prompt: 'x' }, 'foreign')).kind, 'failed');
  assert.equal((await invoke('subagent', { task_id: 'unknown', prompt: 'x' })).kind, 'failed');
  assert.equal((await invoke('subagent', { resume_task_id: 'old', prompt: 'x' })).kind, 'failed');
  assert.equal(guidance.length, 1); assert.equal(dispatched, 0); assert.equal(tasks.list('parent').length, 2);
  assert.deepEqual(browserScopes, [['parent', 'child']], 'foreign task IDs never transfer grants');
  assert.equal(registry.resolve('list_plugin_agents'), undefined);
  const options = await invoke('list_subagent_options', {});
  assert.equal(options.result.agent_roles[0].id, 'fixture:reviewer');
  assert.deepEqual(options.result.agent_roles[0].mcpServers, ['docs']);
  const properties = registry.resolve('subagent').definition.inputSchema.properties;
  assert.ok(properties.task_id); assert.equal(properties.resume_task_id, undefined);
});

function* respond(request, name, args, text = 'parent done') {
  const base = { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: new Date().toISOString() };
  yield { ...base, sequence: 0, kind: 'response_started' };
  if (name) yield { ...base, sequence: 1, kind: 'tool_call_delta', index: 0, toolCallId: crypto.randomUUID(), nameDelta: name, argumentsDelta: JSON.stringify(args) };
  else yield { ...base, sequence: 1, kind: 'text_delta', delta: text };
  yield { ...base, sequence: 2, kind: 'response_completed', finishReason: name ? 'tool_calls' : 'stop' };
}
test('resumes original fork history after host recreation with the current parent model configuration', async t => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'subagent-resume-'));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const sessions = new SessionStore(), tasks = new SubagentTaskStore();
  const requests = [], parentRounds = new Map(), browserScopes = []; let resumeId;
  const provider = { async *stream(request) {
    if (request.metadata.agentRole === 'child') {
      assert.deepEqual(browserScopes.at(-1), ['parent', request.sessionId]);
      requests.push(request);
      yield* respond(request, undefined, undefined, requests.length === 1 ? 'private child identity alpha; read position 4' : 'continued alpha'); return;
    }
    const round = (parentRounds.get(request.turnId) ?? 0) + 1; parentRounds.set(request.turnId, round);
    if (round === 1) yield* respond(request, 'subagent', resumeId ? { task_id: resumeId, prompt: 'continue' } : { prompt: 'first task' });
    else yield* respond(request);
  } };
  const makeHost = () => new InMemoryRuntimeHost({ provider, sessionStore: sessions, subagentTaskStore: tasks, dataRoot,
    inheritBrowserScope: async (parent, child) => { browserScopes.push([parent, child]); } });
  let host = makeHost();
  const run = async (turn) => host.runModelTurn({ protocol: 'bush.model_request.v1', requestId: `r-${turn}`, sessionId: 'parent', turnId: turn, model: turn === 'first' ? 'original-model' : 'new-parent-model',
    providerBinding: { bindingId: turn, revision: `revision-${turn}` },
    maxOutputTokens: turn === 'first' ? 512 : 2048, reasoningEffort: turn === 'first' ? 'low' : 'high',
    tools: await host.sendCommand({ kind: 'runtime.get_tool_catalog', payload: {} }), messages: [{ role: 'system', content: 'original prefix' }, { role: 'user', content: turn }],
    metadata: { contextWindowTokens: turn === 'first' ? 128000 : 256000 } });
  const first = await run('first');
  assert.equal(first.payload.status, 'completed', JSON.stringify(first.payload));
  resumeId = tasks.list('parent')[0].taskId;
  host = makeHost();
  assert.equal((await run('second')).payload.status, 'completed');
  assert.equal(requests.length, 2);
  assert.deepEqual(browserScopes, [['parent', requests[0].sessionId], ['parent', requests[0].sessionId]], 'initial and resumed children inherit browser scope');
  assert.equal(requests[1].sessionId, requests[0].sessionId);
  assert.notEqual(requests[1].turnId, requests[0].turnId);
  assert.equal(requests[1].model, 'new-parent-model');
  assert.deepEqual(requests[1].providerBinding, { bindingId: 'second', revision: 'revision-second' });
  assert.equal(requests[1].maxOutputTokens, 2048);
  assert.equal(requests[1].reasoningEffort, 'high');
  assert.equal(requests[1].metadata.contextWindowTokens, 256000);
  const projection = await host.sendCommand({ kind: 'runtime.get_session', payload: { sessionId: requests[0].sessionId } });
  assert.deepEqual(projection.metadata.executionModel, { model: 'new-parent-model', modelConfigId: 'second', turnId: requests[1].turnId }, 'the child UI observes the new executing configuration');
  assert.ok(requests[1].messages.some(m => m.content.includes('private child identity alpha')));
  assert.equal(requests[1].messages.filter(m => m.content === 'original prefix').length, 1);
  assert.equal(tasks.list('parent')[1].resumedFromTaskId, resumeId);
  assert.equal(sessions.snapshot(requests[0].sessionId).turns.length, 2);
});

test('resume refuses other owners and running children, and concurrent requests cannot reuse one identity', async () => {
  const registry = new ToolRegistry(), tasks = new SubagentTaskStore(); let started = 0, saved;
  let taskIndex = 0;
  registerSubagentTool(registry, tasks, async request => { started++; await new Promise(resolve => setTimeout(resolve, 15));
    return { terminal: { kind: 'turn_terminal', payload: { status: 'completed', finalMessageId: 'answer' } }, session: { turns: [{ turnId: request.turnId, messages: [{ messageId: 'answer', message: { role: 'assistant', content: 'ok' } }] }] } };
  }, { asyncDispatch: false, createTaskId: () => `task${++taskIndex}`, saveChildRequest: async request => { saved = request; }, loadChildRequest: async () => { await Promise.resolve(); return saved; } });
  const coordinator = new ToolExecutionCoordinator({ registry, permissions: { request: async () => { throw Error('unexpected'); } } });
  const run = (args, sessionId = 'parent') => coordinator.execute({ protocol: 'bush.tool_call.v1', id: crypto.randomUUID(), name: 'subagent', argumentsText: JSON.stringify(args) },
    { requestId: 'r', sessionId, turnId: 't', round: 1, ordinal: 0 }, undefined,
    { request: { requestId: 'r', sessionId, turnId: 't', model: 'fixture', tools: registry.definitions(), metadata: {}, permissionMode: 'task_free' }, contextMessages: [{ role: 'system', content: 'prefix' }] });
  assert.equal((await run({ prompt: 'one' })).kind, 'returned');
  assert.equal((await run({ prompt: 'steal', task_id: 'task1' }, 'other')).kind, 'failed');
  const pair = await Promise.all([run({ prompt: 'continue', task_id: 'task1' }), run({ prompt: 'duplicate', task_id: 'task1' })]);
  assert.equal(pair.filter(result => result.kind === 'returned').length, 1); assert.equal(started, 2);
  assert.equal((await run({ prompt: 'override', task_id: 'task1', mode: 'clean' })).kind, 'failed');
});

test('resume preserves clean configuration while intersecting current permissions, tools and skills', async () => {
  const registry = new ToolRegistry(), tasks = new SubagentTaskStore(), requests = [];
  for (const name of ['read_file', 'write_file', 'delete_file']) registry.register({
    definition: { name, inputSchema: { type: 'object' } }, decodeInput: value => value, execute: () => ({}),
    manifest: { effect_kind: 'observation', operation: 'test', risk: 'low', owner: 'test', dispatch_scope: 'turn', mutating: false },
  });
  let saved, taskIndex = 0;
  registerSubagentTool(registry, tasks, async request => {
    requests.push(request);
    return { terminal: { kind: 'turn_terminal', payload: { status: 'completed', finalMessageId: 'answer' } },
      session: { turns: [{ turnId: request.turnId, messages: [{ messageId: 'answer', message: { role: 'assistant', content: 'ok' } }] }] } };
  }, { createTaskId: () => `task${++taskIndex}`, saveChildRequest: async request => { saved = request; }, loadChildRequest: async () => saved });
  const coordinator = new ToolExecutionCoordinator({ registry, permissions: { request: async () => { throw Error('unexpected'); } } });
  const run = (args, metadata, tools = registry.definitions(), permissionMode = 'all_free', model = 'fixture') => coordinator.execute(
    { protocol: 'bush.tool_call.v1', id: crypto.randomUUID(), name: 'subagent', argumentsText: JSON.stringify(args) },
    { requestId: 'r', sessionId: 'parent', turnId: 't', round: 1, ordinal: 0 }, undefined,
    { request: { requestId: 'r', sessionId: 'parent', turnId: 't', model, tools, metadata, permissionMode, maxOutputTokens: 4096 }, contextMessages: [] });
  const first = await run({ prompt: 'first', mode: 'clean', system_prompt: 'private instructions', allowed_tools: ['read_file', 'write_file'],
    settings: { max_context_tokens: 8192, max_output_tokens: 512, max_turns: 4, permission_routing: 'parent',
      permission_mode: 'user_free', allowed_skills: ['a', 'b'], disabled_skills: ['old-disabled'], disabled_tools: ['write_file'] } },
    { contextWindowTokens: 65536 });
  assert.equal(first.kind, 'returned', JSON.stringify(first));
  const resumed = await run({ prompt: 'continue', task_id: 'task1' },
    { contextWindowTokens: 32768, pluginAgentMaxTurns: 2, allowedSkills: ['b', 'c'], disabledSkills: ['new-disabled'],
      childAgentPolicy: { disabledTools: ['delete_file'] } }, registry.definitions().filter(tool => tool.name !== 'write_file'), 'task_free', 'new-parent-model');
  assert.equal(resumed.kind, 'returned', JSON.stringify(resumed));
  const child = requests[1];
  assert.equal(child.model, 'fixture', 'explicit clean configuration remains independent');
  assert.equal(child.metadata.contextWindowTokens, 8192); assert.equal(child.maxOutputTokens, 512);
  assert.equal(child.metadata.pluginAgentMaxTurns, 2); assert.equal(child.permissionMode, 'task_free');
  assert.equal(child.metadata.permissionScopeSessionId, child.sessionId);
  assert.deepEqual(child.tools.map(tool => tool.name), ['read_file']);
  assert.deepEqual(child.metadata.allowedSkills, ['b']);
  assert.ok(child.metadata.disabledTools.includes('write_file')); assert.ok(child.metadata.disabledTools.includes('delete_file'));
  assert.deepEqual(child.metadata.disabledSkills, ['old-disabled', 'new-disabled']);
  assert.deepEqual(child.prefixMessages, [{ role: 'system', content: 'private instructions' }]);
  assert.equal((await run({ prompt: 'continue again', task_id: 'task2' }, { contextWindowTokens: 32768 }, registry.definitions(), 'task_free', 'third-model')).kind, 'returned');
  assert.equal(requests[2].model, 'fixture');
  assert.equal(requests[2].maxOutputTokens, 512);
  assert.equal(requests[2].metadata.subagentMode, 'clean', 'repeated continuations retain the original explicit mode');
});

test('await_subagents any returns the first result while its sibling stays running', async () => {
  let releaseB, parentRound = 0;
  const gateB = new Promise(resolve => { releaseB = resolve; });
  const registry = new ToolRegistry();
  registry.register({ definition: { name: 'release_b', inputSchema: { type: 'object' } },
    manifest: { effect_kind: 'observation', operation: 'test', risk: 'low', owner: 'test', dispatch_scope: 'turn', mutating: false }, decodeInput: value => value,
    execute: () => { releaseB(); return {}; } });
  const provider = { async *stream(request) {
    if (request.metadata.agentRole === 'child') {
      if (request.messages.at(-1).content.endsWith('B')) await gateB;
      else await new Promise(resolve => setTimeout(resolve, 70));
      yield* respond(request, undefined, undefined, request.messages.at(-1).content.endsWith('B') ? 'result B' : 'result A'); return;
    }
    parentRound++;
    if (parentRound <= 2) yield* respond(request, 'subagent', { prompt: parentRound === 1 ? 'A' : 'B' });
    else if (parentRound === 3) yield* respond(request, 'await_subagents', { mode: 'any' });
    else if (parentRound === 4) {
      const result = request.messages.filter(m => m.role === 'tool').at(-1);
      assert.match(result.content, /result A/); assert.doesNotMatch(result.content, /result B/);
      yield* respond(request, 'release_b', {});
    } else yield* respond(request);
  } };
  const host = new InMemoryRuntimeHost({ provider, toolRegistry: registry });
  const terminal = await host.runModelTurn({ protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 'parent', turnId: 't', model: 'fixture', tools: registry.definitions(), messages: [{ role: 'user', content: 'two children' }] });
  assert.equal(terminal.payload.status, 'completed'); assert.ok(parentRound >= 5);
});
