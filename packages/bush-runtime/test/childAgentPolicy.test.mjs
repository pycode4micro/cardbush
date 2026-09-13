import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildChildTurnRequest, CacheChainTracker, inheritedChildMessages, InMemoryRuntimeHost,
  SubagentTaskStore, ToolExecutionCoordinator, ToolRegistry, registerSubagentTool,
} from '../dist/index.js';
import { registerPluginCommandTools } from '../dist/pluginCommandTools.js';

const manifest = { effect_kind: 'observation', operation: 'fixture.read', risk: 'low', owner: 'fixture', dispatch_scope: 'turn', mutating: false };
const ids = { requestId: 'child-request', sessionId: 'child-session', turnId: 'child-turn', messageId: 'child-input' };
const definition = name => ({ name, description: name, inputSchema: { type: 'object', properties: {} } });
const request = (registry, overrides = {}) => ({ protocol: 'bush.model_request.v1', requestId: 'parent-request', sessionId: 'parent-session', turnId: 'parent-turn', model: 'fixture', tools: registry.definitions(), messages: [], metadata: {}, permissionMode: 'all_free', ...overrides });
const registration = (name, overrides = {}) => ({ definition: definition(name), manifest, decodeInput: value => value, execute: () => ({ ok: true }), ...overrides });
const coordinator = (registry, hooks) => new ToolExecutionCoordinator({ registry, hooks, permissions: { request: async () => { throw Error('Unexpected permission request'); } } });
const invoke = (runner, req, name, input = {}) => runner.execute({ protocol: 'bush.tool_call.v1', id: `call-${name}`, name, argumentsText: JSON.stringify(input) }, { requestId: req.requestId, sessionId: req.sessionId, turnId: req.turnId, round: 1, ordinal: 0 }, undefined, { request: req, contextMessages: req.messages });

test('inherited child input extends the exact cached prefix with frozen definitions in parent order', () => {
  const registry = new ToolRegistry();
  registry.register(registration('read_file'));
  registry.register(registration('root_only', { visibleToChild: false }));
  registry.register(registration('subagent'));
  const parent = request(registry, {
    tools: registry.definitions().reverse().map(tool => ({ ...tool, description: `frozen: ${tool.name}` })),
    maxOutputTokens: 4096, reasoningEffort: 'high',
    messages: [
      { role: 'system', content: 'Shared system instructions.' },
      { role: 'user', name: 'global_instructions', content: 'User AGENTS.md preferences.' },
      { role: 'developer', name: 'runtime_context', content: 'Workspace: C:/fixture' },
      { role: 'user', name: 'turn_runtime_context', visibility: 'internal', content: 'ui_language_fallback: zh-CN\nMode: concise' },
      { role: 'user', content: '修复并验证这个问题。' },
      { role: 'assistant', content: '已经读取实现。', toolCalls: [{ id: 'read', name: 'read_file', argumentsText: '{}' }] },
      { role: 'tool', toolCallId: 'read', name: 'read_file', content: 'verified evidence' },
    ],
    metadata: { subagentChildPrefixMessages: [{ role: 'system', content: 'Obsolete alternate prompt must not replace the inherited prefix.' }] },
  });
  const before = structuredClone(parent);
  const context = { sessionId: parent.sessionId, turnId: parent.turnId, turn: { request: parent, contextMessages: parent.messages } };
  const child = buildChildTurnRequest({ context, registry, ids, prompt: '请验证修改；我将处理界面，接口结果稍后提供。', inherited: inheritedChildMessages(context, true), metadata: {}, additionalPrefixMessages: [{ role: 'developer', name: 'plugin_agent_role', content: 'Verify the implementation.' }] });
  assert.deepEqual(child.prefixMessages.slice(0, parent.messages.length), parent.messages);
  assert.equal(child.prefixMessages.at(-1).name, 'plugin_agent_role');
  assert.deepEqual(child.tools, parent.tools);
  assert.equal(child.inputMessages[0].message.content, '你当前处于子agent状态\n\n请验证修改；我将处理界面，接口结果稍后提供。');
  const tracker = new CacheChainTracker();
  const baseline = tracker.observe(parent);
  const observation = tracker.observe({ ...child, messages: [...child.prefixMessages, ...child.inputMessages.map(item => item.message)] });
  assert.equal(observation.stableInputDigest, baseline.stableInputDigest);
  assert.equal(observation.frozenPrefixBreak, false);
  assert.equal(observation.sharedPrefixMessages, parent.messages.length);
  assert.equal(observation.appendedMessages, 2);
  child.tools[0].description = 'child-local edit';
  child.prefixMessages[0].content = 'child-local edit';
  assert.deepEqual(parent, before, 'constructing or modifying the child must not change the parent chain');
});

test('child restrictions reject calls before hooks or execution, including full-control and empty disabledTools', async () => {
  const registry = new ToolRegistry();
  let executions = 0, hookCalls = 0;
  for (const name of ['subagent', 'team_delegate', 'await_subagents', 'update_goal', 'request_permission', 'schedule_task', 'restricted', 'root_only', 'ordinary']) {
    registry.register(registration(name, { visibleToChild: name !== 'root_only', execute: () => { executions++; return {}; } }));
  }
  registry.register(registration('indirect', { execute: context => context.invokeTool('subagent', { prompt: 'nested' }) }));
  const runner = coordinator(registry, { before: async () => { hookCalls++; return { messages: [] }; }, after: async () => ({ messages: [] }) });
  const child = request(registry, { metadata: { agentRole: 'child', disabledTools: [] } });
  for (const name of ['subagent', 'team_delegate', 'await_subagents']) {
    const outcome = await invoke(runner, child, name);
    assert.equal(outcome.kind, 'failed');
    assert.equal(outcome.error.code, 'child_agent_dispatch_unavailable');
    assert.match(outcome.error.message, /currently a child Agent/);
  }
  assert.equal((await invoke(runner, child, 'root_only')).error.code, 'child_agent_tool_unavailable');
  for (const name of ['update_goal', 'request_permission', 'schedule_task']) {
    assert.equal((await invoke(runner, { ...child, metadata: { agentRole: 'child' } }, name)).error.code, 'child_agent_tool_unavailable');
  }
  assert.equal((await invoke(runner, { ...child, metadata: { agentRole: 'child', disabledTools: ['restricted'] } }, 'restricted')).error.code, 'child_agent_tool_unavailable');
  assert.equal(executions, 0);
  assert.equal(hookCalls, 0, 'blocked calls must not run plugin hooks');
  assert.equal((await invoke(runner, child, 'indirect')).error.code, 'child_agent_dispatch_unavailable');
  assert.equal(executions, 0);
  assert.equal((await invoke(runner, child, 'ordinary')).kind, 'returned');
  assert.equal((await invoke(runner, request(registry), 'root_only')).kind, 'returned');
  assert.equal(executions, 2, 'normal child work and parent tools still execute');
});

test('direct dispatch and child construction reject nested work without allocating tasks', async () => {
  const registry = new ToolRegistry(), tasks = new SubagentTaskStore();
  let allocated = 0;
  registerSubagentTool(registry, tasks, async () => { throw Error('Unexpected child run'); }, {
    createTaskId: () => { allocated++; return 'unexpected'; },
    awaitAsyncResults: async () => { throw Error('Unexpected join'); },
  });
  const req = request(registry, { metadata: { agentRole: 'child', disabledTools: [] } });
  const context = { sessionId: req.sessionId, turnId: req.turnId, turn: { request: req, contextMessages: [] }, input: { prompt: 'nested', inheritContext: true } };
  for (const name of ['subagent', 'await_subagents']) await assert.rejects(registry.resolve(name).execute(context), { code: 'child_agent_dispatch_unavailable' });
  assert.throws(() => buildChildTurnRequest({ context, registry, ids, prompt: 'nested', inherited: [], metadata: {} }), { code: 'child_agent_dispatch_unavailable' });
  assert.equal(allocated, 0);
  assert.equal(tasks.list(req.sessionId).length, 0);
});

test('forking Skills and Commands reject child dispatch before dynamic context; inline Skills remain usable', async () => {
  for (const skill of [false, true]) {
    const registry = new ToolRegistry();
    let forks = 0, invocations = 0, terminalAdmissions = 0;
    registry.register(registration('terminal_exec', { authorize: () => { terminalAdmissions++; return { kind: 'allow' }; } }));
    const command = { id: 'fixture:work', pluginId: 'fixture', name: 'work', path: 'C:/fixture/SKILL.md', root: 'C:/fixture', arguments: [], prompt: 'Verify the result.', shell: 'powershell', userInvocable: true };
    registerPluginCommandTools(registry, async () => [
      { ...command, id: 'fixture:fork', context: 'fork', prompt: '!`throw "must never run"`' },
      command,
      { ...command, id: 'fixture:dynamic', prompt: '!`throw "must never run"`' },
    ], { skill, fork: async () => { forks++; return ''; }, onInvoke: async () => { invocations++; } });
    const runner = coordinator(registry), req = request(registry, { metadata: { agentRole: 'child', disabledTools: ['terminal_exec'] } });
    const name = skill ? 'run_skill' : 'run_plugin_command';
    assert.equal((await invoke(runner, req, name, { command: 'fixture:fork' })).error.code, 'child_agent_dispatch_unavailable');
    assert.equal((await invoke(runner, req, name, { command: 'fixture:dynamic' })).error.code, 'child_agent_tool_unavailable');
    assert.equal(forks, 0);
    assert.equal(invocations, 0);
    assert.equal(terminalAdmissions, 0);
    assert.equal((await invoke(runner, req, name, { command: 'fixture:work' })).kind, 'returned');
    assert.equal(invocations, 1);
  }
});

test('runtime child receives a restriction result and finishes without starting a grandchild', async () => {
  const requests = [], counts = new Map();
  const provider = { async *stream(req) {
    requests.push(structuredClone(req));
    const round = (counts.get(req.sessionId) ?? 0) + 1; counts.set(req.sessionId, round);
    const base = { protocol: 'bush.model_event.v1', requestId: req.requestId, createdAt: '2026-09-12T00:00:00Z' };
    yield { ...base, sequence: 0, kind: 'response_started' };
    if (round === 1) {
      yield { ...base, sequence: 1, kind: 'tool_call_delta', index: 0, toolCallId: `dispatch-${req.sessionId}`, nameDelta: 'subagent', argumentsDelta: JSON.stringify({ prompt: '验证结果；主 agent 继续实现。' }) };
      yield { ...base, sequence: 2, kind: 'response_completed', finishReason: 'tool_calls' };
    } else {
      if (req.metadata.agentRole === 'child') assert.ok(req.messages.some(message => message.role === 'tool' && message.content.includes('child_agent_dispatch_unavailable')));
      yield { ...base, sequence: 1, kind: 'text_delta', delta: '验证完成。' };
      yield { ...base, sequence: 2, kind: 'response_completed', finishReason: 'stop' };
    }
  } };
  const host = new InMemoryRuntimeHost({ provider });
  const tools = await host.sendCommand({ kind: 'runtime.get_tool_catalog', payload: {} });
  const terminal = await host.runModelTurn({ protocol: 'bush.model_request.v1', requestId: 'parent-request', sessionId: 'parent', turnId: 'parent-turn', model: 'fixture', tools, messages: [{ role: 'system', content: 'Shared root and child policy.' }, { role: 'user', content: '并行检查。' }], permissionMode: 'all_free', metadata: {} });
  assert.equal(terminal.payload.status, 'completed');
  assert.equal(counts.size, 2, 'only the parent and one child may call the provider');
  const parent = requests.find(req => req.sessionId === 'parent'), child = requests.find(req => req.metadata.agentRole === 'child');
  assert.deepEqual(child.tools, parent.tools);
  assert.deepEqual(child.messages.slice(0, parent.messages.length), parent.messages);
  assert.ok(child.messages[parent.messages.length].content.startsWith('你当前处于子agent状态\n'));
});
