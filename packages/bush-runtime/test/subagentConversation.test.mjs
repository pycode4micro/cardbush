import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRuntimeHost, SessionStore, SubagentTaskStore, ToolRegistry } from '../dist/index.js';
import { childConversationPage } from '../dist/subagentConversation.js';

function* response(request, tool, args, content = 'done') {
  const base = { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: new Date().toISOString() };
  yield { ...base, sequence: 0, kind: 'response_started' };
  if (tool) yield { ...base, sequence: 1, kind: 'tool_call_delta', index: 0, toolCallId: crypto.randomUUID(), nameDelta: tool, argumentsDelta: JSON.stringify(args) };
  else yield { ...base, sequence: 1, kind: 'text_delta', delta: content };
  yield { ...base, sequence: 2, kind: 'response_completed', finishReason: tool ? 'tool_calls' : 'stop' };
}
function setup(childGate) {
  const sessions = new SessionStore(), tasks = new SubagentTaskStore(), registry = new ToolRegistry(), seen = [], rounds = new Map();
  const host = new InMemoryRuntimeHost({ sessionStore: sessions, subagentTaskStore: tasks, toolRegistry: registry,
    provider: { async *stream(request) {
      seen.push(request);
      const round = (rounds.get(request.turnId) ?? 0) + 1; rounds.set(request.turnId, round);
      if (request.metadata.agentRole === 'child') { if (childGate && round === 1) await childGate; yield* response(request, null, null, 'child reply'); }
      else if (request.turnId === 'dispatch' && round === 1) yield* response(request, 'subagent', { prompt: 'parent assignment', mode: 'clean', system_prompt: 'private child role' });
      else yield* response(request);
    } },
  });
  const start = () => host.runModelTurn({ protocol: 'bush.model_request.v1', requestId: 'dispatch-r', sessionId: 'parent', turnId: 'dispatch', model: 'fixture',
    tools: registry.definitions(), messages: [{ role: 'system', content: 'parent secret prefix' }, { role: 'user', content: 'delegate' }], metadata: {}, permissionMode: 'task_free' });
  const read = (taskId, parent = 'parent', cursor) => registry.resolve('read_subagent_conversation').execute({ sessionId: parent, input: { taskId, cursor }, turn: { request: { metadata: {} } } });
  return { host, sessions, tasks, registry, seen, start, read };
}

test('human continuation keeps child ownership, original role and policy; parent reads ordered dialogue', async () => {
  const { host, sessions, tasks, registry, seen, start, read } = setup();
  await start();
  const task = tasks.list('parent')[0];
  const terminal = await host.runSessionTurn({ protocol: 'bush.session_turn_request.v1', requestId: 'human-r', sessionId: task.childSessionId, turnId: 'human-turn', model: 'fixture',
    prefixMessages: [{ role: 'system', content: 'ordinary root role must not replace child role' }], tools: registry.definitions(),
    inputMessages: [{ messageId: 'human-message', message: { role: 'user', content: '用户补充：只修改颜色' } }],
    permissionMode: 'all_free', metadata: { projectDir: '/wrong', workspaceDir: '/wrong' } });
  assert.equal(terminal.payload.status, 'completed');
  const request = seen.find(item => item.turnId === 'human-turn');
  assert.equal(request.metadata.agentRole, 'child');
  assert.equal(request.metadata.parentSessionId, 'parent');
  assert.equal(request.permissionMode, 'task_free');
  assert.equal(request.metadata.permissionRouting, 'user');
  assert.equal(request.metadata.permissionEventSessionId, task.childSessionId);
  assert.equal(request.metadata.permissionEventTurnId, 'human-turn');
  assert.ok(request.messages.some(item => item.content === 'private child role'));
  assert.ok(request.messages.some(item => item.content === 'child reply'));
  assert.ok(!request.messages.some(item => item.content.includes('ordinary root role') || item.content === 'parent secret prefix'));
  assert.notEqual(request.metadata.workspaceDir, '/wrong');
  assert.equal(sessions.snapshot(task.childSessionId).metadata.agentRole, 'child');
  assert.equal(sessions.snapshot(task.childSessionId).metadata.parentSessionId, 'parent');
  assert.equal(tasks.list('parent').length, 2);
  assert.equal(tasks.list('parent')[1].resumedFromTaskId, task.taskId);
  const page = await read(task.taskId);
  assert.deepEqual(page.messages.filter(item => item.role === 'user').map(item => [item.author, item.content]), [
    ['parent_agent', 'parent assignment'], ['user', '用户补充：只修改颜色'],
  ]);
  assert.equal(page.messages.filter(item => item.role === 'assistant').length, 2);
  await assert.rejects(read(task.taskId, 'unrelated'), /does not belong/);
  await host.runSessionTurn({ protocol: 'bush.session_turn_request.v1', requestId: 'parent-follow-r', sessionId: 'parent', turnId: 'parent-follow', model: 'fixture',
    prefixMessages: [], inputMessages: [{ messageId: 'parent-follow-msg', message: { role: 'user', content: '继续主任务' } }], tools: registry.definitions(), metadata: {} });
  assert.ok(seen.find(item => item.turnId === 'parent-follow').messages.some(item => item.name === 'subagent_conversation_updates' && item.content.includes('human-message')));
});

test('live child guidance is visible to the parent and concurrent sends cannot replace the running child', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const { host, tasks, seen, start, read } = setup(gate);
  const running = start();
  for (let i = 0; !tasks.list('parent').length && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
  const task = tasks.list('parent')[0]; assert.ok(task);
  for (let i = 0; !seen.some(item => item.sessionId === task.childSessionId) && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
  await host.sendCommand({ kind: 'runtime.enqueue_guidance', payload: { protocol: 'bush.runtime_guidance.v1', sessionId: task.childSessionId, turnId: task.childTurnId,
    messageId: 'user-guide', content: '先确认边界再继续', createdAt: new Date().toISOString() } });
  const page = await read(task.taskId);
  assert.ok(page.messages.some(item => item.author === 'user' && item.content === '先确认边界再继续'));
  await assert.rejects(host.runSessionTurn({ sessionId: task.childSessionId, turnId: 'conflicting' }), /active|running|admission/i);
  release(); await running;
  assert.ok((await read(task.taskId)).messages.some(item => item.author === 'user' && item.content === '先确认边界再继续'));
  assert.ok(seen.filter(item => item.sessionId === 'parent').some(item => item.messages.some(message => message.name === 'subagent_result' && message.content.includes('direct user message'))));
});

test('conversation pagination is lossless for long messages and omits internal/hidden history', () => {
  const content = '长内容'.repeat(18000);
  const entry = (id, message, metadata) => ({ messageId: id, turnId: 'turn', turnSequence: 1, messageIndex: 0, createdAt: '2026-09-28T00:00:00Z', message, metadata });
  const source = { sessionId: 'child', supersededMessageIds: ['old'], finalMessageIds: ['answer'], messages: [
    entry('system', { role: 'system', content: 'private prefix' }), entry('old', { role: 'user', content: 'superseded' }),
    entry('internal', { role: 'user', visibility: 'internal', content: 'maintenance' }),
    entry('human', { role: 'user', content }, { subagentAuthor: 'user' }), entry('answer', { role: 'assistant', content: 'reply', toolCalls: [] }),
  ] };
  let cursor, collected = '', reads = 0;
  do { const page = childConversationPage(source, cursor); reads++; collected += page.messages.filter(item => item.messageId === 'human').map(item => item.content).join('');
    assert.ok(page.messages.every(item => ['human', 'answer'].includes(item.messageId))); cursor = page.nextCursor;
  } while (cursor);
  assert.ok(reads > 1); assert.equal(collected, content);
  assert.throws(() => childConversationPage(source, '-1:0'), /cursor/);
});

test('parent sees only ordered inputs and terminal answers across multiple turns, never loop activity', () => {
  const entry = (id, turnId, message, metadata) => ({ messageId: id, turnId, message, metadata, createdAt: '2026-09-28T00:00:00Z' });
  const messages = [
    entry('assignment', 'one', { role: 'user', content: 'check layout' }, { subagentAuthor: 'parent' }),
    entry('commentary', 'one', { role: 'assistant', content: 'I will read files', toolCalls: [] }),
    entry('call', 'one', { role: 'assistant', content: 'reading', reasoning: 'private reasoning', toolCalls: [{ name: 'read_file', arguments: '{}' }] }),
    entry('tool', 'one', { role: 'tool', content: 'raw source contents', toolCallId: 'call' }),
    entry('guide', 'one', { role: 'user', name: 'turn_guidance', content: 'only colors' }, { subagentAuthor: 'user' }),
    entry('final-one', 'one', { role: 'assistant', content: 'colors fixed', reasoning: 'hidden', toolCalls: [] }),
    entry('followup', 'two', { role: 'user', content: 'check spacing' }, { subagentAuthor: 'user' }),
    entry('loop-two', 'two', { role: 'assistant', content: 'checking spacing', toolCalls: [] }),
    entry('final-two', 'two', { role: 'assistant', content: 'spacing fixed', toolCalls: [] }),
    entry('next', 'active', { role: 'user', content: 'check fonts' }, { subagentAuthor: 'user' }),
    entry('active-loop', 'active', { role: 'assistant', content: 'not a final answer', toolCalls: [] }),
  ];
  const expected = ['assignment', 'guide', 'final-one', 'followup', 'final-two', 'next'];
  const source = { sessionId: 'child', messages, supersededMessageIds: [], finalMessageIds: ['final-one', 'final-two'] };
  const page = childConversationPage(source);
  assert.deepEqual(page.messages.map(item => item.messageId), expected);
  assert.ok(page.messages.every(item => !('reasoning' in item) && !('toolCalls' in item)));
  const snapshot = { sessionId: 'child', supersededMessageIds: [], turns: [
    { turnId: 'one', status: 'completed', messages: messages.filter(item => item.turnId === 'one') },
    { turnId: 'two', status: 'completed', messages: messages.filter(item => item.turnId === 'two') },
    { turnId: 'active', status: 'stopped', messages: messages.filter(item => item.turnId === 'active') },
  ] };
  assert.deepEqual(childConversationPage(snapshot).messages.map(item => item.messageId), expected);
});
