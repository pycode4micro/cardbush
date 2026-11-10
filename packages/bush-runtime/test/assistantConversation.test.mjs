import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, appendFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { delegatedRequestContext } from '../dist/assistantDelegationOrigins.js';
import { ConversationJournal } from '../dist/conversationJournal.js';
import { AssistantConversation } from '../dist/assistantConversation.js';
import { InMemoryRuntimeEventLog, InMemoryRuntimeHost, SessionStore, ToolRegistry, SubagentTaskStore } from '../dist/index.js';
import { assistantProfileSchema, PERSONAL_ASSISTANT_SESSION as id, REPORT_DELIVERY_INSTRUCTIONS } from '@cardbush/bush-protocol';
import { withToolDisplayTitle } from '../dist/toolDisplay.js';

const temporary = () => mkdtempSync(join(tmpdir(), 'assistant-conversation-'));
test('stopped child with a surviving running receipt is idle in the toolbar and stopped in task history', async () => {
  const events = [];
  const persistence = { load: () => events, append: event => events.push(event) };
  const previous = new SubagentTaskStore({ persistence });
  const child = previous.start({ parentSessionId: id, parentTurnId: 'parent-turn', taskId: 'old-task',
    childSessionId: 'child', childTurnId: 'child-turn', prompt: 'fixture', inheritContext: false, inheritedMessageCount: 0 });
  const log = new InMemoryRuntimeEventLog();
  log.append({ sessionId: child.childSessionId, turnId: child.childTurnId, requestId: 'fixture' },
    { kind: 'turn_terminal', payload: { status: 'stopped', reason: 'user', details: {} } });
  const restored = new SubagentTaskStore({ persistence });
  const host = new InMemoryRuntimeHost({ dataRoot: temporary(), eventLog: log, subagentTaskStore: restored,
    provider: { async *stream() { assert.fail('checking activity must not run a model'); } } });
  try {
    assert.equal(restored.get(id, child.taskId).status, 'running');
    const activity = await host.sendCommand({ kind: 'runtime.assistant_conversation', payload: { sessionId: id, action: 'activity' } });
    assert.equal(activity.activity, 'idle');
    const receipt = await host.sendCommand({ kind: 'runtime.get_subagent_task', payload: { parentSessionId: id, taskId: child.taskId } });
    assert.equal(receipt.status, 'stopped');
    assert.equal(new SubagentTaskStore({ persistence }).get(id, child.taskId).status, 'stopped');
  } finally { await host.sendCommand({ kind:'runtime.shutdown', payload:{} }); }
});
test('the title bar observes only personal Assistant work without opening a conversation or reading its history', () => {
  let running = 0, waiting = false, event = false;
  const assistant = new AssistantConversation({ read: () => assert.fail('read the transcript') }, {
    exists: () => false, tasks: () => assert.fail('copied complete task records'),
    runningTaskCount: session => { assert.equal(session, id); return running; },
    eventNeedsResponse: () => waiting, eventRunning: () => event,
  });
  const activity = () => assistant.command({ action: 'activity', sessionId: id }).activity;
  assert.equal(activity(), 'idle');
  running = 1; assert.equal(activity(), 'working');
  waiting = true; assert.equal(activity(), 'waiting');
  running = 0; waiting = false; event = true; assert.equal(activity(), 'working');
  event = false; assert.equal(activity(), 'idle');
  assert.throws(() => assistant.command({ action:'activity', sessionId:'ordinary-chat' }));
});
const entry = (key, content = '请帮我检查文件', role = 'user', source = 'text') => ({ id: key, content, role, source, visibility: 'conversation', createdAt: new Date().toISOString() });
const gate = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
const until = async fn => { for (let i = 0; i < 400; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 10)); } assert.fail('condition timed out'); };
async function* response(request, { text = '', calls = [] } = {}) {
  const base = { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: new Date().toISOString() };
  let sequence = 0;
  yield { ...base, sequence: sequence++, kind: 'response_started' };
  if (text) yield { ...base, sequence: sequence++, kind: 'text_delta', delta: text };
  for (const [index, call] of calls.entries()) yield { ...base, sequence: sequence++, kind: 'tool_call_delta', index, toolCallId: call.id,
    nameDelta: call.name, argumentsDelta: JSON.stringify(call.args) };
  yield { ...base, sequence, kind: 'response_completed', finishReason: calls.length ? 'tool_calls' : 'stop' };
}
const parent = (registry, voice = false) => ({ protocol: 'bush.session_turn_request.v1', requestId: 'assistant-request', sessionId: id,
  turnId: 'assistant-turn', model: 'fixture', prefixMessages: [{ role: 'system', content: 'Execution instructions only.' }],
  inputMessages: [{ messageId: 'input', message: { role: 'user', content: 'Check the files' } }], tools: registry?.definitions() ?? [],
  metadata: { assistantOutputMode: voice ? 'voice' : 'text' }, permissionMode: 'task_free' });

test('assistant journals keep authored text and selection identity while the model receives the full context', async () => {
  const directory = temporary(), journal = new ConversationJournal(directory), requests = [];
  const promptContext = [{ kind: 'preview-selection', requestId: 'selected-request', content: 'Selected file C:/work/slides.pptx, page 3, shape heading.' }];
  const input = { ...entry('selected', '修改这一处'), promptContext };
  const assistant = new AssistantConversation(journal, { exists: () => true, tasks: () => [], checkpoint: () => ({}),
    delegate: async () => { throw Error('No delegation expected'); }, provider: { async *stream(request) {
      requests.push(request); yield* response(request, { text: '已了解选区。' });
    } } });
  try {
    assistant.command({ action: 'turn', sessionId: id, entry: input, parent: parent(), profile: assistantProfileSchema.parse({}) });
    await until(() => !assistant.command({ action: 'read', sessionId: id }).busy);
    assert.equal(assistant.command({ action: 'read', sessionId: id }).error, '');
    assert.ok(requests[0].messages.some(message => message.role === 'user' && message.content.includes(promptContext[0].content)));
    const saved = new ConversationJournal(directory).read(id)[0];
    assert.equal(saved.content, '修改这一处'); assert.deepEqual(saved.promptContext, promptContext);
    assert.throws(() => journal.append(id, { ...input, promptContext: [{ ...promptContext[0], content: 'different target' }] }), /different content/);
  } finally { assistant.close(); }
});

test('assistant accepts provider display metadata on all four tools, including await without task_ids', async () => {
  const journal = new ConversationJournal(temporary()), tasks = [], delegated = [], receipts = [];
  const title = { zh: '核对后台任务', en: 'Check background tasks' };
  const batches = [
    [{ name: 'subagent', args: { prompt: 'Read only: inspect the plugin' } }],
    [{ name: 'tasks', args: {} }, { name: 'page_write', args: { content: '已派出任务。' } }],
    [{ name: 'subagent', args: { task_id: 'child', prompt: 'Include the supported parameters' } },
      { name: 'tasks', args: { action: 'conversation', task_ids: ['child'] } }],
  ];
  let round = 0;
  const assistant = new AssistantConversation(journal, { exists: () => true, tasks: () => tasks, checkpoint: () => ({}),
    delegate: async input => {
      assert.equal(assistant.command({ action: 'activity', sessionId: id }).activity, 'working');
      delegated.push(input);
      if (input.action === 'subagent' && !input.taskId) tasks.push({ taskId: 'child', status: 'running', finalResponse: '' });
      return { taskId: 'child', status: 'running' };
    }, provider: { async *stream(request) {
      assert.equal(assistant.command({ action: 'activity', sessionId: id }).activity, 'thinking');
      const index = round++;
      receipts.push(...request.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content)));
      for (const definition of request.tools) assert.ok(withToolDisplayTitle(definition).inputSchema.properties._display_title);
      yield* response(request, { calls: (batches[index] ?? []).map((call, i) => ({ ...call, id: `${index}-${i}`, args: { ...call.args, _display_title: title } })) });
    } } });
  try {
    assistant.command({ action: 'turn', sessionId: id, entry: entry('decorated', 'Inspect', 'user', 'voice'), parent: parent(undefined, true), profile: assistantProfileSchema.parse({}) });
    await until(() => !assistant.command({ action: 'read', sessionId: id }).busy);
    assert.equal(assistant.command({ action: 'read', sessionId: id }).error, '');
    assert.deepEqual(receipts.filter(receipt => receipt.status === 'failed'), []);
    assert.deepEqual(delegated.map(input => input.action), ['subagent', 'subagent', 'read_subagent_conversation']);
    assert.ok(delegated.every(input => !('_display_title' in input)));
    assert.ok(receipts.some(receipt => receipt.status === 'watching' && receipt.tasks[0].taskId === 'child'));
    assert.equal(journal.read(id).filter(item => item.source === 'page').length, 1);
  } finally { assistant.close(); }
});

test('assistant distinguishes malformed arguments, foreign tasks and disabled delegation', async () => {
  const journal = new ConversationJournal(temporary()), results = new Map(), delegated = [];
  const calls = [
    { id: 'all', name: 'tasks', args: {} },
    { id: 'wrong-type', name: 'tasks', args: { task_ids: 'child' } },
    { id: 'bad-id', name: 'tasks', args: { task_ids: [123] } },
    { id: 'foreign', name: 'tasks', args: { task_ids: ['foreign'] } },
    { id: 'unknown-field', name: 'subagent', args: { prompt: 'Inspect', approved: true } },
    { id: 'missing-prompt', name: 'subagent', args: {} },
    { id: 'missing-task', name: 'subagent', args: { prompt: 'Continue', task_id: '' } },
    { id: 'invalid-cursor', name: 'tasks', args: { action: 'conversation', task_ids: ['child'], cursor: 'broken' } },
    { id: 'disabled', name: 'subagent', args: { prompt: 'Inspect' } },
  ];
  let round = 0;
  const assistant = new AssistantConversation(journal, { exists: () => true, tasks: () => [], checkpoint: () => ({}),
    delegate: async input => { delegated.push(input); throw Object.assign(Error('Subagent delegation is disabled for this parent.'), { code: 'realtime_subagent_disabled' }); },
    provider: { async *stream(request) {
      for (const message of request.messages) if (message.role === 'tool') results.set(message.toolCallId, JSON.parse(message.content));
      yield* response(request, { calls: round++ ? [] : calls.map(call => ({ ...call, args: { ...call.args, _display_title: { zh: '查询任务', en: 'Inspect tasks' } } })) });
    } } });
  try {
    assistant.command({ action: 'turn', sessionId: id, entry: entry('validation'), parent: parent(), profile: assistantProfileSchema.parse({}) });
    await until(() => !assistant.command({ action: 'read', sessionId: id }).busy);
    assert.deepEqual(results.get('all'), { status: 'settled', tasks: [] });
    for (const key of ['wrong-type', 'bad-id', 'unknown-field', 'missing-prompt', 'missing-task', 'invalid-cursor'])
      assert.equal(results.get(key)?.code, 'invalid_tool_arguments', key);
    assert.match(results.get('wrong-type').error, /task_ids/);
    assert.equal(results.get('foreign').code, 'subagent_not_owned');
    assert.equal(results.get('disabled').code, 'realtime_subagent_disabled');
    assert.equal(delegated.length, 1, 'invalid calls never reach execution');
  } finally { assistant.close(); }
});

test('a delayed result gets later corrections only from its originating bridge account and chat', () => {
  const original = { ...entry('original'), botSourceRef: 'webhook:1', botRecipientKey: 'account-room-A' };
  const newer = { ...entry('correction', 'Cancel the check'), botSourceRef: 'webhook:2', botRecipientKey: 'account-room-A' };
  const other = { ...entry('foreign'), botSourceRef: 'webhook:3', botRecipientKey: 'account-room-B' };
  const journal = [original, other, entry('desktop'), newer];
  const brief = JSON.parse(delegatedRequestContext([original], journal).content);
  assert.deepEqual(brief.laterUserMessages.map(item => item.messageId), ['correction']);
  assert.deepEqual(JSON.parse(delegatedRequestContext([], journal).content).requests, []);
});

test('text assistant dispatch reaches the actual child loop and reports completion asynchronously', async () => {
  const sessions = new SessionStore(), registry = new ToolRegistry(), tasks = new SubagentTaskStore(), childGate = gate(), childRequests = [];
  sessions.ensureSession(id);
  let rounds = 0;
  const host = new InMemoryRuntimeHost({ dataRoot: temporary(), sessionStore: sessions, toolRegistry: registry, subagentTaskStore: tasks,
    provider: { async *stream(request) {
      if (request.metadata.agentRole === 'child') {
        childRequests.push(request); await childGate.promise;
        yield* response(request, { text: 'Verified plugin parameters.' }); return;
      }
      const index = rounds++;
      if (index === 0) yield* response(request, { calls: [{ id: 'real-dispatch', name: 'subagent', args: {
        prompt: 'Read only: inspect the plugin parameters', _display_title: { zh: '检查插件参数', en: 'Inspect plugin parameters' } } }] });
      else if (index === 1) yield* response(request, { text: '已交给后台处理。' });
      else if (!request.messages.some(message => message.name === 'background_task_result')) {
        yield* response(request, { text: '已了解新话题。' });
      } else {
        const original = request.messages.findLast(message => message.name === 'delegated_user_request');
        assert.equal(original.role, 'user'); assert.equal(original.visibility, 'internal');
        assert.deepEqual(JSON.parse(original.content).requests.map(({ messageId, text }) => ({ messageId, text })),
          [{ messageId: 'actual-child', text: '请帮我检查文件' }]);
        assert.deepEqual(JSON.parse(original.content).laterUserMessages.map(item => item.messageId), ['new-topic']);
        assert.deepEqual(request.metadata.assistantEventEvidence.map(item => item.id), ['actual-child']);
        assert.equal(request.metadata.assistantUserRequest, false);
        yield* response(request, { text: '后台已核实插件参数。' });
      }
    } } });
  const command = payload => host.sendCommand({ kind: 'runtime.assistant_conversation', payload: { sessionId: id, ...payload } });
  try {
    await command({ action: 'turn', entry: entry('actual-child'), parent: parent(registry), profile: assistantProfileSchema.parse({}) });
    await until(() => childRequests.length > 0);
    await until(async () => !(await command({ action: 'read' })).busy);
    assert.equal(tasks.list(id).length, 1);
    assert.equal(tasks.list(id)[0].status, 'running', 'the assistant can reply while the child works');
    assert.equal(childRequests[0].model, 'fixture');
    assert.equal(childRequests[0].permissionMode, 'task_free');
    assert.ok(childRequests[0].messages.some(message => message.content.includes('Read only: inspect')));
    await command({ action: 'turn', entry: entry('new-topic', '换一个话题'), parent: { ...parent(registry), turnId: 'second-turn' }, profile: assistantProfileSchema.parse({}) });
    await until(async () => (await command({ action: 'read' })).entries.some(item => item.content === '已了解新话题。'));
    childGate.resolve();
    await until(async () => (await command({ action: 'read' })).entries.some(item => item.content === '后台已核实插件参数。'));
    const result = (await command({ action: 'read' })).entries.find(item => item.content === '后台已核实插件参数。');
    assert.deepEqual(result.responseTo, ['actual-child']);
    assert.equal(tasks.list(id)[0].status, 'completed');
    assert.equal((await command({ action: 'read' })).error, '');
  } finally { childGate.resolve(); await host.sendCommand({ kind: 'runtime.shutdown', payload: {} }); }
});

for (const voice of [false, true]) test(`assistant ${voice ? 'conversational' : 'native'} tool queues a later turn and interrupts only child reasoning`, async () => {
  const sessions = new SessionStore(), registry = new ToolRegistry(), tasks = new SubagentTaskStore();
  sessions.ensureSession(id);
  const oldStream = gate(), releaseTool = gate(), requests = [];
  let oldSignal, toolSignal, toolRuns = 0, nextCall;
  registry.register({
    definition: { name: 'check_inventory', description: 'Check inventory', inputSchema: { type: 'object', properties: {} } },
    manifest: { effect_kind: 'observation', operation: 'fixture.inventory', risk: 'low', owner: 'test', dispatch_scope: 'turn', mutating: false },
    visibleToChild: true, decodeInput: value => value,
    async execute(context) { toolRuns++; toolSignal = context.signal; await releaseTool.promise; return { count: 17 }; },
  });
  const host = new InMemoryRuntimeHost({ dataRoot: temporary(), sessionStore: sessions, toolRegistry: registry, subagentTaskStore: tasks,
    provider: { async *stream(request, { signal }) {
      if (request.metadata.agentRole !== 'child') {
        const call = nextCall; nextCall = undefined;
        yield* response(request, call ? { calls: [call] } : { text: 'Acknowledged.' }); return;
      }
      requests.push(request);
      if (requests.length === 1) {
        oldSignal = signal;
        yield { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: new Date().toISOString(),
          sequence: 0, kind: 'reasoning_delta', delta: 'Checking the original scope.' };
        await oldStream.promise;
        yield { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: new Date().toISOString(),
          sequence: 1, kind: 'text_delta', delta: 'Obsolete answer.' };
      } else if (requests.length === 2) {
        yield* response(request, { calls: [{ id: 'inventory', name: 'check_inventory', args: {} }] });
      } else {
        yield* response(request, { text: 'Finished.' });
      }
    } } });
  const command = payload => host.sendCommand({ kind: 'runtime.assistant_conversation', payload: { sessionId: id, ...payload } });
  async function ask(callId, args) {
    nextCall = { id: callId, name: 'subagent', args };
    await command({ action: 'turn', entry: entry(callId), parent: { ...parent(registry, voice), turnId: callId, requestId: callId },
      profile: assistantProfileSchema.parse({}) });
    await until(async () => !(await command({ action: 'read' })).busy);
    assert.equal((await command({ action: 'read' })).error, '');
  }
  try {
    await ask('dispatch', { prompt: 'Check stock.' });
    await until(() => oldSignal);
    const [child] = tasks.list(id);
    const events = () => host.events(child.childSessionId, child.childTurnId);
    await ask('later', { task_id: child.taskId, delivery: 'queue', prompt: 'Review the final inventory.' });
    const queued = tasks.list(id).find(task => task.queuedAfterTaskId === child.taskId);
    assert.ok(queued); assert.equal(queued.childSessionId, child.childSessionId);
    assert.equal(oldSignal.aborted, false); assert.equal(requests.length, 1);

    await ask('now', { task_id: child.taskId, delivery: 'insert', prompt: 'Only count available items.' });
    await until(() => toolRuns === 1);
    assert.equal(oldSignal.aborted, true);
    assert.equal(requests[1].turnId, child.childTurnId);
    assert.equal(requests[1].messages.at(-1).role, 'user');
    assert.equal(requests[1].messages.at(-1).content, 'Only count available items.');

    await ask('during-tool', { task_id: child.taskId, delivery: 'insert', prompt: 'Include the count in your reply.' });
    const pending = events().find(e => e.kind === 'guidance_queued' && e.payload.content === 'Include the count in your reply.');
    assert.equal(pending?.payload.metadata.subagentAuthor, 'parent', 'show the parent message while the tool is running');
    assert.equal(events().some(e => e.kind === 'guidance_applied' && e.payload.messageId === pending.payload.messageId), false);
    assert.equal(toolSignal.aborted, false); assert.equal(requests.length, 2);
    releaseTool.resolve();
    await until(() => tasks.list(id).every(task => task.status === 'completed'));
    assert.equal(toolRuns, 1); assert.equal(requests.length, 4);
    assert.equal(requests[2].turnId, child.childTurnId);
    assert.deepEqual(requests[2].messages.filter(m => m.name === 'turn_guidance').map(m => m.content),
      ['Only count available items.', 'Include the count in your reply.']);
    assert.match(requests[2].messages.find(m => m.role === 'tool' && m.toolCallId === 'inventory').content, /17/);
    assert.equal(requests[2].messages.some(m => m.content.includes('Review the final inventory.')), false);
    assert.equal(requests[3].turnId, queued.childTurnId); assert.notEqual(queued.childTurnId, child.childTurnId);
    assert.ok(requests[3].messages.some(m => m.role === 'user' && m.content.includes('Review the final inventory.')));
  } finally {
    oldStream.resolve(); releaseTool.resolve(); await host.sendCommand({ kind: 'runtime.shutdown', payload: {} });
  }
});

for (const [foregroundRead, followUp] of [[false, false], [true, false], [true, true]]) test(`text assistant reads Team results once with ${foregroundRead ? 'foreground read' : 'asynchronous completion'}${followUp ? ' and new user input' : ''}`, async () => {
  const sessions = new SessionStore(), registry = new ToolRegistry(), childGate = gate(), children = [], receipts = [];
  sessions.ensureSession(id);
  const batches = [
    { name: 'subagent', args: { action: 'save', expected_revision: 0, agent: { id: 'clerk', name: 'Clerk', system_prompt: 'Check verified inventory only.' } } },
    { name: 'team', args: { action: 'save', expected_revision: 0, definition: { id: 'inventory', name: 'Inventory', nodes: [{ id: 'check', agent_id: 'clerk', prompt: 'Check inventory' }] } } },
    { name: 'team', args: { action: 'run', team_id: 'inventory', input: 'Order 42' } },
  ];
  let round = 0;
  const host = new InMemoryRuntimeHost({ dataRoot: temporary(), sessionStore: sessions, toolRegistry: registry, provider: { async *stream(request) {
    if (request.metadata.agentRole === 'child') {
      children.push(request); await childGate.promise;
      yield* response(request, { text: 'Inventory verified for order 42.' }); return;
    }
    receipts.push(...request.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content)));
    assert.ok(request.tools.some(tool => tool.name === 'team'));
    assert.ok(request.tools.some(tool => tool.name === 'list_subagent_options'));
    const index = round++;
    if (followUp && index === 5) {
      assert.ok(request.messages.some(message => message.role === 'user' && message.content === '同时到达的补充要求'));
      yield* response(request, { text: '已处理补充要求。' }); return;
    }
    if (index < batches.length) {
      yield* response(request, { calls: [{ ...batches[index], id: `native-${index}` }] }); return;
    }
    if (index === batches.length && !foregroundRead) {
      yield* response(request, { text: '团队正在后台执行。' }); return;
    }
    const notices = request.messages.filter(message => message.name === 'background_task_result').map(message => JSON.parse(message.content));
    const result = receipts.flatMap(receipt => (receipt.tasks ?? []).map(task => task.result)).find(result => result?.output_node_ids) ?? notices.find(notice => notice.type === 'team_result');
    if (!result) {
      const run = receipts.find(receipt => receipt.run_id);
      // Simulate a foreground reply arriving as the background result settles.
      // The conversational assistant only reads; it never exposes a wait tool.
      await childGate.promise;
      const reader = registry.resolve('tasks');
      await until(async () => (await reader.execute({ sessionId: id, turnId: request.turnId,
        input: reader.decodeInput({ action: 'inspect', task_ids: [run.run_id] }) })).tasks[0]?.status === 'completed');
      yield* response(request, { calls: [{ id: 'read-team-result', name: 'tasks', args: { action: 'inspect', task_ids: [run.run_id] } }] }); return;
    }
    assert.equal(result.nodes[0].output, 'Inventory verified for order 42.');
    assert.equal(request.messages.filter(message => message.content.includes('Inventory verified for order 42.')).length, 1);
    yield* response(request, { text: '团队已确认库存。' });
  } } });
  const command = payload => host.sendCommand({ kind: 'runtime.assistant_conversation', payload: { sessionId: id, ...payload } });
  try {
    await command({ action: 'turn', entry: entry('native-team'), parent: parent(registry), profile: assistantProfileSchema.parse({}) });
    if (!foregroundRead) await until(async () => (await command({ action: 'read' })).entries.some(item => item.content === '团队正在后台执行。'));
    await until(() => children.length === 1);
    assert.equal(children[0].metadata.registeredAgentId, 'clerk');
    assert.doesNotMatch(JSON.stringify(children[0].messages), /Execution instructions only/);
    assert.deepEqual(receipts.filter(receipt => receipt.status === 'failed'), []);
    if (followUp) await command({ action: 'turn', entry: entry('follow-up', '同时到达的补充要求'), parent: parent(registry), profile: assistantProfileSchema.parse({}) });
    childGate.resolve();
    await until(async () => (await command({ action: 'read' })).entries.some(item => item.content === '团队已确认库存。'));
    await until(async () => !(await command({ action: 'read' })).busy);
    assert.equal(round, followUp ? 6 : 5, 'async delivery needs no extra fetch, and deduplication must preserve new user input');
    if (followUp) assert.equal((await command({ action: 'read' })).entries.filter(item => item.content === '已处理补充要求。').length, 1);
    assert.equal((await command({ action: 'read' })).entries.filter(item => item.content === '团队已确认库存。').length, 1);
    assert.equal((await command({ action: 'read' })).error, '');
  } finally { childGate.resolve(); await host.sendCommand({ kind: 'runtime.shutdown', payload: {} }); }
});

test('text assistant new and resumed children use its current model and publish the same execution model to the UI', async () => {
  const sessions = new SessionStore(), tasks = new SubagentTaskStore(), childRequests = [];
  sessions.ensureSession(id);
  let dispatch = true, resumeId;
  const host = new InMemoryRuntimeHost({ dataRoot: temporary(), sessionStore: sessions, subagentTaskStore: tasks,
    provider: { async *stream(request) {
      if (request.metadata.agentRole === 'child') {
        childRequests.push(request); yield* response(request, { text: `Verified with ${request.model}` }); return;
      }
      if (dispatch) {
        dispatch = false;
        yield* response(request, { calls: [{ id: `delegate-${request.requestId}`, name: 'subagent', args: {
          prompt: 'Read only: inspect the current page', ...(resumeId ? { task_id: resumeId } : {}),
        } }] });
      } else yield* response(request, { text: '后台执行中。' });
    } } });
  const command = payload => host.sendCommand({ kind: 'runtime.assistant_conversation', payload: { sessionId: id, ...payload } });
  try {
    for (const [index, model] of ['first-model', 'second-model'].entries()) {
      dispatch = true;
      const request = { ...parent(), requestId: `assistant-${index}`, turnId: `assistant-turn-${index}`, model,
        tools: await host.sendCommand({ kind: 'runtime.get_tool_catalog', payload: {} }),
        providerBinding: { bindingId: `config-${index}`, revision: `revision-${index}` },
        maxOutputTokens: 8192 + index * 1024, reasoningEffort: index ? 'high' : 'low',
        metadata: { assistantOutputMode: 'text', contextWindowTokens: 64000 + index * 16000 } };
      await command({ action: 'turn', entry: entry(`switch-${index}`), parent: request, profile: assistantProfileSchema.parse({}) });
      await until(async () => childRequests.length === index + 1 && tasks.list(id).every(task => task.status === 'completed') && !(await command({ action: 'read' })).busy);
      assert.equal((await command({ action: 'read' })).error, '');
      const child = childRequests[index];
      assert.equal(child.model, model);
      assert.deepEqual(child.providerBinding, request.providerBinding);
      assert.equal(child.reasoningEffort, request.reasoningEffort);
      assert.equal(child.maxOutputTokens, request.maxOutputTokens);
      assert.equal(child.metadata.contextWindowTokens, request.metadata.contextWindowTokens);
      const projection = await host.sendCommand({ kind: 'runtime.get_session', payload: { sessionId: child.sessionId } });
      assert.deepEqual(projection.metadata.executionModel, { model, modelConfigId: `config-${index}`, turnId: child.turnId });
      resumeId = tasks.list(id).at(-1).taskId;
    }
    assert.equal(childRequests[0].sessionId, childRequests[1].sessionId, 'model changes do not create a duplicate child');
    assert.ok(childRequests[1].messages.some(message => message.content.includes('Verified with first-model')), 'child history is retained');
  } finally { await host.sendCommand({ kind: 'runtime.shutdown', payload: {} }); }
});

test('conversation journal survives restart, deduplicates retries and repairs only an incomplete final append', () => {
  const root = temporary(), journal = new ConversationJournal(root), message = entry('speech', '中文语音');
  journal.append('chat-a', message);
  journal.append('chat-a', { ...message, createdAt: new Date(Date.now() + 1000).toISOString() });
  assert.equal(journal.read('chat-a').length, 1);
  assert.throws(() => journal.append('chat-a', { ...message, content: 'different' }), /reused/);
  appendFileSync(join(root, readdirSync(root)[0]), '{"id":"incomplete');
  const restored = new ConversationJournal(root);
  assert.equal(restored.read('chat-a')[0].content, message.content);
  restored.append('chat-a', entry('next'));
  assert.equal(new ConversationJournal(root).read('chat-a').length, 2);
  assert.deepEqual(restored.read('chat-b'), []);
  restored.forget('chat-a'); assert.deepEqual(new ConversationJournal(root).read('chat-a'), []);
});

test('text assistant reports a child deliverable in one final reply even if the provider attempts a page write', async () => {
  const journal = new ConversationJournal(temporary()), tasks = [], seen = [], modelGate = gate();
  let round = 0;
  const assistant = new AssistantConversation(journal, { exists: () => true, tasks: () => tasks,
    checkpoint: () => ({}), delegate: async input => {
      assert.equal(input.targetAgent, undefined, 'legacy direct-host settings migrate to local parent dispatch; remote workers use registered roles');
      tasks.push({ taskId: 'child-task', status: 'running', finalResponse: '', errorMessage: '' });
      return { taskId: 'child-task', status: 'running' };
    }, provider: { async *stream(request) {
      seen.push(request); const index = round++;
      if (index === 0) { await modelGate.promise; yield* response(request, { text: '我会检查文件。', calls: [{ id: 'dispatch', name: 'subagent', args: { prompt: 'Read only: inspect files' } }] }); }
      else if (index === 1) yield* response(request, { calls: [{ id: 'watch', name: 'tasks', args: { task_ids: ['child-task'] } }] });
      else if (index === 2) yield* response(request, { text: '已经交给后台处理，我们可以继续聊。' });
      else if (index === 3) yield* response(request, { calls: [{ id: 'page', name: 'page_write', args: { content: '# Full report\n\n| A | B |\n|---|---|\n| 1 | 2 |' } }] });
      else yield* response(request, { text: '已核对：[报告](C:/work/report.html)' });
    } } });
  const command = { action: 'turn', sessionId: id, entry: entry('first'), parent: parent(), profile: assistantProfileSchema.parse({ targetAgent: 'saved-ssh-agent' }) };
  try {
    assert.equal(assistant.command(command).status, 'accepted');
    assert.equal(assistant.command({ action: 'read', sessionId: id }).busy, true);
    modelGate.resolve(); await until(() => !assistant.command({ action: 'read', sessionId: id }).busy);
    assert.equal(tasks[0].status, 'running', 'main response finishes while child still executes');
    assert.equal(round, 3); assistant.command(command); await new Promise(r => setTimeout(r, 20)); assert.equal(round, 3, 'retry does not re-execute');
    assert.deepEqual(seen[0].tools.map(tool => tool.name).sort(), ['subagent', 'tasks']);
    assert.ok(seen[0].messages.some(m => m.role === 'system' && m.content.includes(REPORT_DELIVERY_INSTRUCTIONS)));
    assert.ok(!journal.read(id).some(item => item.content === '我会检查文件。'), 'loop commentary is not a page message');
    tasks[0].status = 'completed'; tasks[0].finalResponse = 'Verified C:/work/report.html';
    await until(() => journal.read(id).some(item => item.source === 'text' && item.content.includes('report.html')));
    assert.equal(JSON.parse(seen.at(-1).messages.find(message => message.toolCallId === 'page').content).code, 'tool_unavailable');
    const visible = journal.read(id).filter(item => item.visibility !== 'internal');
    assert.deepEqual(visible.map(item => item.role), ['user', 'assistant', 'assistant']);
    assert.equal(visible.at(-1).content, '已核对：[报告](C:/work/report.html)');
    assert.ok(!visible.some(item => item.source === 'page' || item.content.includes('Full report')));
    assert.equal(journal.read(id).filter(item => item.source === 'task').length, 1);
  } finally { modelGate.resolve(); assistant.close(); }
});

test('chained assistant speech is retained internally while page_write remains visible', async () => {
  const journal = new ConversationJournal(temporary()); let calls = 0;
  const assistant = new AssistantConversation(journal, { exists: () => true, tasks: () => [], checkpoint: () => ({}), delegate: async () => ({}),
    provider: { async *stream(request) { const index = calls++; yield* response(request, index % 2 ? { text: '我把重点写在页面上了。' } : { calls: [{ id: 'written', name: 'page_write', args: { content: `## 重点\n这里是第 ${index / 2 + 1} 份资料。` } }] }); } } });
  try {
    assistant.command({ action: 'turn', sessionId: id, entry: entry('spoken', '需要一份资料', 'user', 'voice'), parent: parent(undefined, true), profile: assistantProfileSchema.parse({}) });
    await until(() => !assistant.command({ action: 'read', sessionId: id }).busy);
    assert.deepEqual(journal.read(id).map(item => [item.role, item.visibility]), [['user', 'conversation'], ['assistant', 'conversation'], ['assistant', 'internal']]);
    assistant.command({ action: 'turn', sessionId: id, entry: entry('spoken-again', '再整理另一份资料', 'user', 'voice'), parent: parent(undefined, true), profile: assistantProfileSchema.parse({}) });
    await until(() => !assistant.command({ action: 'read', sessionId: id }).busy);
    assert.equal(assistant.command({ action: 'read', sessionId: id }).error, '');
    assert.equal(journal.read(id).filter(item => item.source === 'page').length, 2, 'reused provider call IDs in later turns do not collide');
  } finally { assistant.close(); }
});

test('long assistant history checkpoints through the text model, retaining original messages and loading no maintenance tools normally', async () => {
  const root = temporary(), journal = new ConversationJournal(root), seen = [];
  for (let i = 0; i < 12; i++) journal.append(id, entry(`old-${i}`, `Record ${i}: 保留项目的关键约束。`.repeat(220), i % 2 ? 'assistant' : 'user'));
  const registry = new ToolRegistry();
  const host = new InMemoryRuntimeHost({ dataRoot: temporary(), toolRegistry: registry, provider: { async *stream() {} } });
  const assistant = new AssistantConversation(journal, { exists: () => true, tasks: () => [], checkpoint: () => registry.definitions().find(tool => tool.name === 'checkpoint_context'), delegate: async () => ({}),
    provider: { async *stream(request) { seen.push(request); yield* response(request, request.tools.length === 1 && request.tools[0].name === 'checkpoint_context'
      ? { calls: [{ id: `memory-${seen.length}`, name: 'checkpoint_context', args: { updates: [{ source: 0, summary: '记录了项目约束，尚无执行结果。' }] } }] }
      : { text: '已记住约束。' }); } } });
  try {
    assistant.command({ action: 'turn', sessionId: id, entry: entry('recent', '请记住'), parent: { ...parent(), maxOutputTokens: 1000, metadata: { contextWindowTokens: 8000 } }, profile: assistantProfileSchema.parse({}) });
    await until(() => !assistant.command({ action: 'read', sessionId: id }).busy);
    assert.equal(assistant.command({ action: 'read', sessionId: id }).error, '');
    assert.ok(seen.some(request => request.tools[0]?.name === 'checkpoint_context'));
    assert.ok(seen.every(request => request.maxOutputTokens === 1000), 'assistant compaction inherits the same explicit output allowance');
    assert.ok(seen.at(-1).messages.some(message => message.name === 'conversation_memory'));
    assert.ok(!seen.at(-1).tools.some(tool => tool.name === 'checkpoint_context'));
    assert.equal(new ConversationJournal(root).read(id).filter(item => item.id.startsWith('old-')).length, 12);
  } finally { assistant.close(); await host.sendCommand({ kind: 'runtime.shutdown', payload: {} }); }
});

test('voice journal append during a foreground turn neither changes its revision nor breaks its commit; session deletion clears it', async () => {
  const sessions = new SessionStore(), registry = new ToolRegistry(), started = gate(), finish = gate();
  const host = new InMemoryRuntimeHost({ dataRoot: temporary(), sessionStore: sessions, toolRegistry: registry,
    provider: { async *stream(request) { started.resolve(); await finish.promise; yield* response(request, { text: 'Done' }); } } });
  const run = host.runSessionTurn(parent(registry));
  try {
    await started.promise;
    const revision = sessions.snapshot(id).revision;
    await host.sendCommand({ kind: 'runtime.assistant_conversation', payload: { action: 'append', sessionId: id, entry: entry('parallel-voice', '通话中的补充', 'user', 'voice') } });
    assert.equal(sessions.snapshot(id).revision, revision);
    finish.resolve(); await run;
    assert.equal(sessions.snapshot(id).turns.length, 1);
    assert.equal((await host.sendCommand({ kind: 'runtime.assistant_conversation', payload: { action: 'read', sessionId: id } })).entries.length, 1);
    await host.sendCommand({ kind: 'runtime.delete_session', payload: { sessionId: id } });
    await assert.rejects(host.sendCommand({ kind: 'runtime.assistant_conversation', payload: { action: 'append', sessionId: id, entry: entry('late') } }), /no longer exists/);
  } finally { finish.resolve(); await run; await host.sendCommand({ kind: 'runtime.shutdown', payload: {} }); }
});

test('remote voice children retain host identity for guidance, reads and resumption', async () => {
  const tasks = new SubagentTaskStore(), registry = new ToolRegistry(), finish = gate(), guided = [];
  const host = new InMemoryRuntimeHost({ dataRoot: temporary(), subagentTaskStore: tasks, toolRegistry: registry,
    provider: { async *stream() {} }, remoteAgents: {
      list: async () => [{ id: 'remote-1', name: 'SSH', agentId: 'server-1' }],
      run: async (input, _signal, onAccepted) => { onAccepted(); assert.equal(input.connectionId, 'remote-1'); await finish.promise; return { status: 'completed', finalResponse: 'Remote result', errorMessage: '', usage: {} }; },
      guide: async input => { guided.push(input); return { accepted: true }; },
      read: async () => undefined,
    } });
  const invoke = payload => host.sendCommand({ kind: 'runtime.realtime_agent_tool', payload: { sessionId: id, ...payload } });
  try {
    const first = await invoke({ callId: 'dispatch-remote', action: 'subagent', prompt: 'Inspect remote files', targetAgent: 'remote-1', parent: parent(registry) });
    assert.equal(first.status, 'running');
    await invoke({ callId: 'guide-remote', action: 'subagent', taskId: first.taskId, prompt: 'Read only', targetAgent: 'another-host', parent: parent(registry) });
    assert.equal(guided[0].connectionId, 'remote-1'); assert.equal(guided[0].parentSessionId, id);
    assert.equal((await invoke({ callId: 'read-remote', action: 'read_subagent_conversation', taskId: first.taskId })).status, 'starting');
    finish.resolve(); await until(() => tasks.get(id, first.taskId).status === 'completed');
    const resumed = await invoke({ callId: 'resume-remote', action: 'subagent', taskId: first.taskId, prompt: 'Explain', targetAgent: 'another-host', parent: parent(registry) });
    assert.equal(resumed.childSessionId, first.childSessionId);
  } finally { finish.resolve(); await host.sendCommand({ kind: 'runtime.shutdown', payload: {} }); }
});

test('assistant attachments survive history and enter model and child context with vision gated by settings', async () => {
  const root = temporary(), journal = new ConversationJournal(root), requests = [], dispatched = [];
  const attachments = [{ id: 'doc', name: '笔记.txt', path: 'C:/local/笔记.txt', type: 'document', execution: { connectionId: 'ssh', path: '/remote/笔记.txt' } },
    { id: 'image', name: 'screen.png', path: 'C:/local/screen.png', type: 'image' }];
  let round = 0;
  const assistant = new AssistantConversation(journal, { exists: () => true, tasks: () => [], checkpoint: () => ({}),
    delegate: async input => { dispatched.push(input); return { status: 'accepted' }; },
    provider: { async *stream(request) { requests.push(request); yield* response(request, round++ === 0
      ? { calls: [{ id:'read-file', name:'subagent', args:{ prompt:'读取附件并归纳' } }] } : { text:'已安排读取。' }); } } });
  try {
    const config = { ...parent(), requestCapabilities: { vision: true, interactiveRequests: false } };
    config.prefixMessages.push({ role:'developer', content:'Attached files:\n/remote/笔记.txt' });
    assistant.command({ action:'turn', sessionId:id, entry:{ ...entry('attached'), attachments }, parent:config, profile:assistantProfileSchema.parse({ targetAgent:'ssh' }) });
    await until(() => !assistant.command({ action:'read', sessionId:id }).busy);
    assert.match(requests[0].messages.at(-1).content, /remote\/笔记.txt/);
    assert.equal(requests[0].messages.at(-1).images[0].url, 'C:/local/screen.png');
    assert.equal(dispatched[0].targetAgent, undefined, 'a legacy profile cannot redirect the assistant to an SSH host');
    assert.ok(dispatched[0].parent.prefixMessages.some(item => item.content.includes('/remote/笔记.txt')));
    assert.deepEqual(new ConversationJournal(root).read(id)[0].attachments, attachments);
    assistant.command({ action:'turn', sessionId:id, entry:entry('followup'), parent:parent(), profile:assistantProfileSchema.parse({}) });
    await until(() => !assistant.command({ action:'read', sessionId:id }).busy);
    assert.ok(!requests.at(-1).messages.some(item => item.images?.length), 'vision-off never sends history images');
    assert.ok(requests.at(-1).messages.some(item => item.content.includes('screen.png')), 'file references remain usable');
  } finally { assistant.close(); }
});


test('reset forgets memory and isolates late replies and transcripts without deleting other chats',async()=>{
  const journal=new ConversationJournal(temporary()),old=gate(),fresh=gate(),requests=[];
  const assistant=new AssistantConversation(journal,{exists:()=>true,tasks:()=>[],checkpoint:()=>({}),delegate:async()=>({}),
    provider:{async *stream(request){requests.push(request);await (requests.length===1?old:fresh).promise;yield* response(request,{text:requests.length===1?'old reply':'new reply'});}}});
  const profile=assistantProfileSchema.parse({name:'Lumi',persona:'reliable',targetAgent:'ssh-fixture',microphoneMuted:true,outputMuted:true});
  journal.append('other-chat',entry('other','keep this'));
  try {
    assistant.command({action:'turn',sessionId:id,entry:entry('old-input','old private context'),parent:parent(),profile,generation:0});
    await until(()=>requests.length===1);
    const result=assistant.command({action:'reset',sessionId:id});assert.equal(result.generation,1);
    assert.equal(assistant.command({action:'read',sessionId:id}).busy,false);assert.deepEqual(journal.read(id),[]);
    assert.equal(journal.read('other-chat').length,1);
    assert.throws(()=>assistant.command({action:'append',sessionId:id,entry:entry('late-voice'),generation:0}),/reset/);
    assert.throws(()=>assistant.command({action:'turn',sessionId:id,entry:entry('late-input'),parent:parent(),profile,generation:0}),/reset/);
    assistant.command({action:'turn',sessionId:id,entry:entry('new-input','fresh start'),parent:parent(),profile,generation:1});
    await until(()=>requests.length===2);
    assert.ok(!requests[1].messages.some(message=>message.content?.includes('old private context')));
    assert.match(requests[1].messages[0].content,/Lumi/);
    old.resolve();await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(assistant.command({action:'read',sessionId:id}).busy,true,'old cleanup cannot clear the new response');
    assert.equal(assistant.command({action:'read',sessionId:id}).error,'');
    fresh.resolve();await until(()=>!assistant.command({action:'read',sessionId:id}).busy);
    assert.equal(journal.read(id).filter(message=>message.role==='assistant').length,1);
  }finally{old.resolve();fresh.resolve();assistant.close();}
});

test('ordinary chat follows the current initiative setting even when a saved profile still has it enabled', async () => {
  const requests = [], settings = { recognition: { boundaries: '晚上十点后免打扰' }, beforeExecution: 'within-scope', report: 'important', notificationSourceRef: 'test-route' };
  const confirmed = { ...settings, confirmedAt: '2026-11-07T00:00:00.000Z' };
  const saved = assistantProfileSchema.parse({ proactive: confirmed });
  let current;
  const assistant = new AssistantConversation(new ConversationJournal(temporary()), {
    exists: () => true, tasks: () => [], checkpoint: () => ({}), eventPreferences: () => current,
    delegate: async () => { throw Error('Unexpected delegation'); },
    provider: { async *stream(request) { requests.push(request); yield* response(request, { text: '收到。' }); } },
  });
  try {
    const cases = [
      { preference: undefined, profile: assistantProfileSchema.parse({}), enabled: false },
      { preference: confirmed, profile: saved, enabled: true },
      { preference: settings, profile: saved, enabled: false },
    ];
    for (const [index, { preference, profile, enabled }] of cases.entries()) {
      current = preference;
      assistant.command({ action: 'turn', sessionId: id, entry: entry('preference-' + index, '样衣已寄出，买手还没确认收到。'), parent: parent(), profile });
      await until(() => !assistant.command({ action: 'read', sessionId: id }).busy);
      assert.equal(requests.length, index + 1, 'initiative is part of the ordinary model request');
      const messages = requests[index].messages, system = messages.find(m => m.role === 'system').content;
      assert.ok(system.includes(`Proactive follow-ups in ordinary chat are ${enabled ? 'enabled' : 'disabled'}.`));
      assert.equal(system.includes('whether a later check would help'), enabled, 'an opted-out turn never receives suggestions for taking initiative');
      assert.ok(!system.includes(settings.recognition.boundaries));
      const supplied = messages.find(m => m.name === 'confirmed_preferences');
      if (preference) {
        assert.equal(supplied.role, 'user'); assert.equal(supplied.visibility, 'internal');
        assert.deepEqual(JSON.parse(supplied.content), enabled ? confirmed : { report: settings.report, notificationSourceRef: settings.notificationSourceRef });
      } else assert.equal(supplied, undefined);
    }
  } finally { assistant.close(); }
});

test('assistant defaults are English model instructions and custom personas remain unmodified', async () => {
  for (const persona of ['', '温和、可靠、自然地交流。尊重用户的停顿和思考时间。', '  自定义角色 {{value:host}}  ']) {
    const journal = new ConversationJournal(temporary()), requests = [];
    const assistant = new AssistantConversation(journal, { exists: () => true, tasks: () => [], checkpoint: () => ({}),
      delegate: async () => { throw Error('No delegation expected'); }, provider: { async *stream(request) {
        requests.push(request); yield* response(request, { text: '已完成。' });
      } } });
    try {
      assistant.command({ action: 'turn', sessionId: id, entry: entry('language'), parent: parent(), profile: assistantProfileSchema.parse({ persona }) });
      await until(() => !assistant.command({ action: 'read', sessionId: id }).busy);
      assert.equal(assistant.command({ action: 'read', sessionId: id }).error, '');
      const system = requests[0].messages.find(message => message.role === 'system').content;
      if (persona) assert.ok(system.includes(persona));
      else { assert.doesNotMatch(system, /\p{Script=Han}/u); assert.match(system, /Respect the user's pauses and thinking time/); }
      assert.ok(requests[0].messages.some(message => message.role === 'user' && message.content.includes('请帮我检查文件')));
    } finally { assistant.close(); }
  }
});

test('Assistant reads the current registered profile even with proactive events disabled', async () => {
  const requests=[], journal=new ConversationJournal(temporary());
  const registered={preferredName:'Lin',habits:'Keep updates short.'};
  const assistant=new AssistantConversation(journal,{exists:()=>true,tasks:()=>[],delegate:async()=>({}),
    checkpoint:()=>({name:'checkpoint_context',description:'',parameters:{}}),preferredName:async()=>registered.preferredName,
    provider:{async *stream(request){requests.push(request);yield* response(request,{text:'Done'});}}});
  try {
    for(const key of ['first','second']){
      assistant.command({action:'turn',sessionId:id,entry:entry(key),parent:parent(new ToolRegistry()),profile:{name:'Fixture'}});
      await until(()=>requests.length===(key==='first'?1:2)&&!assistant.command({action:'read',sessionId:id}).busy);
      const input=requests.at(-1).messages.find(m=>m.name==='registered_user_profile');
      assert.equal(input.role,'user');assert.deepEqual(JSON.parse(input.content),{preferredName:registered.preferredName});
      registered.preferredName='Lee';
    }
  } finally {assistant.close();}
});
