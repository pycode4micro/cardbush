import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { AssistantConversation } from '../dist/assistantConversation.js';
import { ConversationJournal } from '../dist/conversationJournal.js';
import { RuntimeTaskTools } from '../dist/taskTools.js';
import { ToolRegistry } from '../dist/toolRegistry.js';
import { assistantProfileSchema, conversationalSubagentTools, PERSONAL_ASSISTANT_SESSION as id } from '@cardbush/bush-protocol';
import { TaskResultDelivery, resultDelivery } from '../dist/taskResultDelivery.js';
import { AssistantModelHistory } from '../dist/assistantModelHistory.js';
import { InMemoryRuntimeHost, SubagentTaskStore, SessionStore, FileSubagentTaskPersistence } from '../dist/index.js';

for (const stage of ['pending', 'reserved', 'committed', 'reset']) test(`Assistant restores ${stage} result subscriptions from the existing task journal`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const root = temporary(t), taskRoot = join(root, 'tasks'), journalRoot = join(root, 'journal');
  const profile = assistantProfileSchema.parse({});
  const parent = { protocol: 'bush.session_turn_request.v1', requestId: 'request', sessionId: id, turnId: 'dispatch-turn', model: 'fixture',
    prefixMessages: [], inputMessages: [{ messageId: 'initial', message: { role: 'user', content: 'Start work' } }], tools: [], metadata: {} };
  let persistence = new FileSubagentTaskPersistence({ root: taskRoot }), tasks = new SubagentTaskStore({ persistence });
  let requests = [];
  const create = () => new AssistantConversation(new ConversationJournal(journalRoot), { exists: () => true, tasks: () => tasks.list(id),
    resultDelivery: tasks.delivery, checkpoint: () => ({}), delegate: async () => {
      const task = tasks.start({ parentSessionId: id, parentTurnId: 'dispatch-turn', taskId: 'child', childSessionId: 'child-session',
        childTurnId: 'child-turn', prompt: 'Check', inheritContext: false, inheritedMessageCount: 0 });
      return { taskId: task.taskId, status: task.status };
    }, provider: { async *stream(request) {
      requests.push(request);
      if (request.messages.some(message => message.name === 'background_task_result')) yield* response(request, 'Verified result delivered.');
      else if (requests.length === 1) yield* response(request, '', [{ id: 'dispatch', name: 'subagent', args: { prompt: 'Check' } }]);
      else yield* response(request, 'Started.');
    } } });
  let assistant = create();
  t.after(() => { assistant.close(); persistence.close(); });
  assistant.command({ action: 'turn', sessionId: id, parent, profile,
    entry: { id: 'initial', role: 'user', source: 'text', visibility: 'conversation', content: 'Start work', createdAt: new Date().toISOString() } });
  await until(() => requests.length === 2 && !assistant.command({ action: 'read', sessionId: id }).busy);
  assert.equal(tasks.get(id, 'child').resultWatched, true);
  const observation = activeObservation(tasks.get(id, 'child'));
  tasks.observe(id, 'child', observation);
  const writes = persistence.load(id).length;
  const revision = tasks.get(id, 'child').revision;
  for (let cursor = 2; cursor <= 2319; cursor++) tasks.observe(id, 'child', { ...observation, cursor });
  assert.throws(() => tasks.observe(id, 'child', { ...observation, cursor: NaN }), /Invalid child observation cursor/);
  assert.throws(() => tasks.observe(id, 'child', observation), /cursor moved backwards/);
  assert.equal(persistence.load(id).length, writes, 'cursor-only events from the 5EPlay replay never append a task revision');
  assert.equal(tasks.get(id, 'child').observation.cursor, 2319);
  assert.equal(tasks.get(id, 'child').revision, revision);
  assistant.close(); persistence.close();
  persistence = new FileSubagentTaskPersistence({ root: taskRoot }); tasks = new SubagentTaskStore({ persistence });
  assert.equal(tasks.get(id, 'child').observation.cursor, 1, 'the source can replay from the last durable task change');
  assert.equal(tasks.get(id, 'child').resultWatched, true);
  tasks.delivery.restoreWatching(id, tasks.list(id));
  tasks.observe(id, 'child', { ...observation, cursor: 2320, progress: { ...observation.progress, completedActions: 1 } });
  assert.equal(persistence.load(id).at(-1).task.observation.cursor, 2320);
  const finished = tasks.finish({ parentSessionId: id, taskId: 'child', status: 'completed', finalResponse: 'Verified result', errorMessage: '', usage: {} });
  assistant = create();
  if (stage === 'reserved') assert.ok(tasks.delivery.reserve(id, finished));
  if (stage === 'committed') { assistant.restore(parent, profile); t.mock.timers.tick(1200); await until(() => requests.length === 3 && !assistant.command({ action: 'read', sessionId: id }).busy); }
  if (stage === 'reset') assistant.forget(id);
  assistant.close(); persistence.close();
  persistence = new FileSubagentTaskPersistence({ root: taskRoot }); tasks = new SubagentTaskStore({ persistence }); requests = [];
  assistant = create(); assistant.restore(parent, profile); assistant.restore(parent, profile);
  if (['pending', 'reserved'].includes(stage)) await until(() => requests.length === 1 && !assistant.command({ action: 'read', sessionId: id }).busy);
  t.mock.timers.tick(4800); await yieldTurn();
  assert.equal(requests.length, ['pending', 'reserved'].includes(stage) ? 1 : 0);
  if (requests.length) assert.equal(requests[0].messages.filter(message => message.name === 'background_task_result').length, 1);
  const replies = new ConversationJournal(journalRoot).read(id).filter(entry => entry.content === 'Verified result delivered.');
  assert.equal(replies.length, stage === 'reset' ? 0 : 1);
});

test('ordinary conversation restores a watched result once without redispatching its child', async t => {
  const root = temporary(t), persistence = new FileSubagentTaskPersistence({ root: join(root, 'tasks') });
  const tasks = new SubagentTaskStore({ persistence }), sessions = new SessionStore();
  t.after(() => persistence.close());
  sessions.ensureSession('parent');
  const task = tasks.start({ parentSessionId: 'parent', parentTurnId: 'old', taskId: 'finished-child', childSessionId: 'child',
    childTurnId: 'child-turn', prompt: 'Check', inheritContext: false, inheritedMessageCount: 0 });
  tasks.delivery.watch('parent', task);
  const observation = activeObservation(task);
  tasks.observe('parent', task.taskId, observation);
  tasks.observe('parent', task.taskId, { ...observation, cursor: 1468 });
  const resumed = new SubagentTaskStore({ persistence });
  assert.equal(resumed.get('parent', task.taskId).observation.cursor, 1);
  assert.ok(resumed.restoredLocalRuns('parent', task.taskId).length);
  resumed.finish({ parentSessionId: 'parent', taskId: task.taskId, status: 'completed', finalResponse: 'Durable result', errorMessage: '', usage: {} });
  const requests = [];
  for (const turnId of ['next', 'after-restart']) {
    const registry = new ToolRegistry();
    const host = new InMemoryRuntimeHost({ dataRoot: root, sessionStore: sessions, subagentTaskStore: new SubagentTaskStore({ persistence }),
      toolRegistry: registry, provider: { async *stream(request) { requests.push(request); yield* response(request, 'Acknowledged.'); } } });
    try {
      const terminal = await host.runSessionTurn({ protocol: 'bush.session_turn_request.v1', requestId: turnId, sessionId: 'parent', turnId, model: 'fixture',
        prefixMessages: [], inputMessages: [{ messageId: turnId, message: { role: 'user', content: 'Continue' } }], tools: registry.definitions(), metadata: {} });
      assert.equal(terminal.payload.status, 'completed');
    } finally { await host.sendCommand({ kind: 'runtime.shutdown', payload: {} }); }
  }
  assert.equal(requests.length, 2, 'one model request per user turn, with no separate duplicate notification round');
  assert.equal(sessions.snapshot('parent').turns.flatMap(turn => turn.messages).filter(fact => fact.message.name === 'subagent_result').length, 1);
  assert.match(JSON.stringify(requests[0].messages), /Durable result/);
});

function activeObservation(task) {
  return { contextId: task.childSessionId, taskId: task.taskId, cursor: 1, state: 'working',
    progress: { phase: 'model', text: '', completedActions: 0, failedActions: 0 }, interactions: [] };
}

test('resident startup restores Assistant notifications without a new user turn', async t => {
  const root = temporary(t), sessions = new SessionStore(), tasks = new SubagentTaskStore();
  sessions.ensureSession(id);
  const profile = assistantProfileSchema.parse({});
  const parent = { protocol: 'bush.session_turn_request.v1', requestId: 'configuration', sessionId: id, turnId: 'configuration', model: 'fixture',
    prefixMessages: [], inputMessages: [{ messageId: 'configuration', message: { role: 'user', content: 'Configuration only' } }], tools: [], metadata: {} };
  let requests = 0;
  const provider = { async *stream(request) { requests++; assert.match(JSON.stringify(request.messages), /Recovered completion/); yield* response(request, 'Recovered completion delivered.'); } };
  let host = new InMemoryRuntimeHost({ dataRoot: root, sessionStore: sessions, subagentTaskStore: tasks, provider });
  t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  await host.sendCommand({ kind: 'runtime.friends', payload: { action: 'configure', parent, assistant: profile,
    profile: { name: 'Assistant', language: 'en', timeZone: 'UTC', recognition: {}, confirmedAt: new Date().toISOString() } } });
  const task = tasks.start({ parentSessionId: id, parentTurnId: 'old', taskId: 'watched', childSessionId: 'child', childTurnId: 'child-turn',
    prompt: 'Check', inheritContext: false, inheritedMessageCount: 0 });
  tasks.delivery.watch(id, task);
  tasks.finish({ parentSessionId: id, taskId: task.taskId, status: 'completed', finalResponse: 'Recovered completion', errorMessage: '', usage: {} });
  await host.sendCommand({ kind: 'runtime.shutdown', payload: {} });
  host = new InMemoryRuntimeHost({ dataRoot: root, sessionStore: sessions, subagentTaskStore: tasks, provider });
  await host.restoreAssistantEvents(async saved => saved, new AbortController().signal);
  await until(() => requests === 1);
  const journal = new ConversationJournal(join(root, 'conversation-journal'));
  await until(() => new ConversationJournal(join(root, 'conversation-journal')).read(id).some(entry => entry.role === 'assistant'));
  assert.equal(journal.read(id).filter(entry => entry.role === 'assistant').length, 1);
  await host.restoreAssistantEvents(async saved => saved, new AbortController().signal);
  await yieldTurn(); assert.equal(requests, 1);
});

function temporary(t) {
  const root = mkdtempSync(join(tmpdir(), 'cardbush-confirm-issues-'));
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(root.includes('cardbush-confirm-issues-'));
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

async function until(predicate) {
  for (let index = 0; index < 500; index++) {
    if (predicate()) return;
    await yieldTurn();
  }
  assert.fail('Expected state did not settle');
}

async function* response(request, text = '', calls = []) {
  const base = { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: new Date().toISOString() };
  let sequence = 0;
  yield { ...base, sequence: sequence++, kind: 'response_started' };
  if (text) yield { ...base, sequence: sequence++, kind: 'text_delta', delta: text };
  for (const [index, call] of calls.entries()) {
    yield { ...base, sequence: sequence++, kind: 'tool_call_delta', index, toolCallId: call.id,
      nameDelta: call.name, argumentsDelta: JSON.stringify(call.args) };
  }
  yield { ...base, sequence, kind: 'response_completed', finishReason: calls.length ? 'tool_calls' : 'stop' };
}

for (const sessionId of [id, 'ordinary-parent']) test(`${sessionId} delivers one child package lookup automatically while retaining explicit inspection`, async t => {
  const dataRoot = temporary(t), registry = new ToolRegistry(), sessions = new SessionStore(), tasks = new SubagentTaskStore();
  const assistant = sessionId === id;
  const childGate = gate();
  const parentRequests = [], childRequests = [], catalogReads = [];
  const host = new InMemoryRuntimeHost({ dataRoot, toolRegistry: registry, sessionStore: sessions, subagentTaskStore: tasks,
    loadPluginPackages: async () => {
      catalogReads.push('installed packages');
      return { packages: [{ name: 'fixture-plugin', displayName: 'Fixture plugin', description: 'Fixture', version: '0.8.0',
        installed: true, enabled: true, source: 'user' }] };
    }, provider: { async *stream(request) {
      if (request.metadata.agentRole === 'child') {
        childRequests.push(request);
        if (childRequests.length === 1) {
          assert.match(request.tools.find(tool => tool.name === 'search_plugins').description, /Answer from that entry without repeating/);
          await childGate.promise;
          yield* response(request, '', [{ id: 'look-up-package', name: 'search_plugins', args: { mode: 'plugins', query: 'fixture-plugin' } }]);
        } else {
          const receipt = JSON.parse(request.messages.find(message => message.role === 'tool' && message.toolCallId === 'look-up-package').content);
          assert.deepEqual(receipt.matches.map(({ name, version, installed }) => ({ name, version, installed })),
            [{ name: 'fixture-plugin', version: '0.8.0', installed: true }]);
          yield* response(request, 'Installed fixture-plugin version is 0.8.0.');
        }
        return;
      }
      parentRequests.push(request);
      assert.ok(request.tools.some(tool => tool.name === 'tasks'), 'Explicit status and recovery stay available');
      if (parentRequests.length === 1) {
        yield* response(request, '', [{ id: 'delegate', name: 'subagent', args: { prompt: 'Look up fixture-plugin in the installed package catalog.' } }]);
      } else if (parentRequests.length === 2) {
        const receipt = JSON.parse(request.messages.find(message => message.role === 'tool' && message.toolCallId === 'delegate').content);
        assert.equal(receipt.result_delivery, 'automatic');
        assert.match(receipt.instructions, /Do not call tasks inspect, await/);
        yield* response(request, 'Started.');
      } else {
        const results = request.messages.filter(message => message.name === (assistant ? 'background_task_result' : 'subagent_result'));
        assert.equal(results.length, 1);
        assert.match(results[0].content, /0\.8\.0/);
        yield* response(request, 'Version 0.8.0.');
      }
    } } });
  let running;
  const command = payload => host.sendCommand({ kind: 'runtime.assistant_conversation', payload: { sessionId, ...payload } });
  try {
    sessions.ensureSession(sessionId);
    const parent = { protocol: 'bush.session_turn_request.v1', requestId: 'request', sessionId, turnId: 'turn', model: 'fixture',
      prefixMessages: [], inputMessages: [{ messageId: 'question', message: { role: 'user', content: 'Check the installed plugin version.' } }],
      tools: registry.definitions(), metadata: { individuation: { habits: false, predictions: false } } };
    if (assistant) await command({ action: 'turn', parent, profile: assistantProfileSchema.parse({}),
      entry: { id: 'question', role: 'user', content: 'Check the installed plugin version.', source: 'text', visibility: 'conversation', createdAt: new Date().toISOString() } });
    else running = host.runSessionTurn(parent);
    await until(() => parentRequests.length >= 2);
    await yieldTurn();
    assert.equal(parentRequests.length, 2, 'Waiting does not require a model status request');
    const [task] = tasks.list(sessionId);
    assert.equal(task.resultWatched, true);
    childGate.release();
    if (assistant) {
      await tasks.waitForCompletion(sessionId, task.taskId, new AbortController().signal);
      for (let i = 0; i < 500 && (await command({ action: 'read' })).entries.every(entry => entry.content !== 'Version 0.8.0.'); i++) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      const state = await command({ action: 'read' });
      assert.equal(state.entries.filter(entry => entry.source === 'task').length, 1);
      assert.equal(state.entries.filter(entry => entry.content === 'Version 0.8.0.').length, 1);
    } else {
      assert.equal((await running).payload.status, 'completed');
      const history = sessions.snapshot(sessionId).turns.flatMap(turn => turn.messages.map(item => item.message));
      assert.equal(history.filter(message => message.name === 'subagent_result').length, 1);
      assert.equal(history.filter(message => message.content === 'Version 0.8.0.').length, 1);
    }
    assert.equal(tasks.list(sessionId).length, 1);
    assert.equal(parentRequests.length, 3);
    assert.equal(childRequests.length, 2);
    assert.equal(catalogReads.length, 1);
  } finally {
    childGate.release();
    await host.sendCommand({ kind: 'runtime.shutdown', payload: {} });
    await running?.catch(() => {});
  }
});

for (const action of ['stop', 'inspect']) {
  for (const timing of ['during-reply', 'after-reply', 'before-context-commit', 'history-failure', 'concurrent-user']) {
    test(`task lifecycle delivers a terminal result once through ${action} receipt, ${timing}`, async t => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const journal = new ConversationJournal(temporary(t));
      const requests = [], tasks = [], controls = [], executions = [];
      const delivery = new TaskResultDelivery();
      const replyStarted = gate(), releaseReply = gate();
      const registry = new ToolRegistry();
      const facade = new RuntimeTaskTools(async () => assert.fail('No wait requested'));
      const child = { taskId: 'isolated-child', parentTurnId: 'dispatch-turn', originMessageIds: ['dispatch-input'],
        childSessionId: 'child-session', childTurnId: 'child-turn', createdAt: '2026-11-14T00:00:00.000Z',
        status: 'running', finalResponse: '', errorMessage: '' };
      facade.addSource(() => tasks.map(task => ({ task_id: task.taskId, kind: 'subagent', status: task.status,
        reserveResult: () => delivery.reserve(id, task),
        revision: task.status === 'running' ? '1' : '2', result: { finalResponse: task.finalResponse, errorMessage: task.errorMessage },
        readResult: async () => {
          if (timing === 'before-context-commit') t.mock.timers.tick(1200);
          return { finalResponse: task.finalResponse, errorMessage: task.errorMessage };
        },
        stop: async () => {
          controls.push(task.taskId);
          Object.assign(task, { status: 'stopped', errorMessage: 'turn_stop_requested' });
          return { status: 'stopped' };
        } })));
      facade.register(registry);
      const subagent = conversationalSubagentTools.find(tool => tool.name === 'subagent');
      const definitions = [subagent, ...registry.definitions()];
      const assistant = new AssistantConversation(journal, {
        exists: () => true, tasks: () => tasks, resultDelivery: delivery, checkpoint: () => ({}), delegationTools: () => definitions,
        agents: { begin: request => executions.push(request.turnId), update() {} },
        delegate: async input => {
          if (input.action === 'subagent') {
            tasks.push(child);
            return { taskId: child.taskId, status: 'running' };
          }
          assert.equal(input.action, 'tasks');
          const handler = registry.resolve('tasks');
          return handler.execute({ input: handler.decodeInput(input.nativeArguments),
            request: input.parent, signal: new AbortController().signal });
        },
        provider: { async *stream(request) {
          const index = requests.length;
          requests.push(request);
          if (index === 0) yield* response(request, '', [{ id: 'dispatch', name: 'subagent', args: { prompt: 'Inspect a fixture' } }]);
          else if (index === 1) yield* response(request, 'Task accepted.');
          else if (index === 2) yield* response(request, '', [{ id: 'control', name: 'tasks', args: { action, task_ids: [child.taskId] } }]);
          else if (index === 3) {
            replyStarted.release();
            await releaseReply.promise;
            yield* response(request, 'Terminal result acknowledged.');
          } else yield* response(request, timing === 'concurrent-user' ? 'Fresh request handled.' : 'Same terminal result acknowledged again.');
        } },
      });
      t.after(() => { releaseReply.release(); assistant.close(); });
      const state = () => assistant.command({ action: 'read', sessionId: id });
      function send(messageId, turnId, content) {
        assistant.command({ action: 'turn', sessionId: id,
          entry: { id: messageId, content, role: 'user', source: 'text', visibility: 'conversation', createdAt: new Date().toISOString() },
          parent: { protocol: 'bush.session_turn_request.v1', requestId: messageId, sessionId: id, turnId, model: 'fixture',
            prefixMessages: [{ role: 'system', content: 'Fixture.' }], inputMessages: [{ messageId, message: { role: 'user', content } }],
            tools: definitions, metadata: { assistantOutputMode: 'text' }, permissionMode: 'ask_for_approval' },
          profile: assistantProfileSchema.parse({}),
        });
      }
      send('dispatch-input', 'dispatch-turn', 'Inspect the fixture.');
      await until(() => requests.length === 2 && !state().busy);
      if (action === 'inspect') Object.assign(child, { status: 'completed', finalResponse: 'Fixture result.' });
      if (timing === 'history-failure') {
        const history = journal.modelHistory(id), append = history.append.bind(history); let failed = false;
        t.mock.method(history, 'append', (messages, ...rest) => {
          if (!failed && messages.some(message => message.toolCallId === 'control')) { failed = true; throw Error('fixture context write failed'); }
          return append(messages, ...rest);
        });
      }
      send('control-input', 'control-turn', action === 'stop' ? 'Cancel the task.' : 'Read the completed result.');
      await until(() => requests.length >= 4 || Boolean(state().error));
      if (timing === 'history-failure') {
        await until(() => !state().busy);
        assert.match(state().error, /fixture context write failed/);
        assert.equal(delivery.phase(id, child), 'ready');
        assert.equal(journal.modelHistory(id).read().taskResults.length, 0);
        t.mock.timers.tick(1200); releaseReply.release();
        await until(() => requests.length === 4 && !state().busy);
        assert.equal(state().error, '');
        assert.equal(state().entries.filter(entry => entry.source === 'task').length, 1);
        assert.ok(requests[3].messages.some(message => message.name === 'background_task_result'));
        assert.equal(delivery.phase(id, child), 'delivered');
        assert.equal(journal.modelHistory(id).read().taskResults.length, 1);
        t.mock.timers.tick(3600); await yieldTurn(); assert.equal(requests.length, 4);
        return;
      }
      assert.equal(state().error, '');
      await replyStarted.promise;
      const receipt = JSON.parse(requests[3].messages.find(message => message.toolCallId === 'control').content);
      assert.equal(receipt.tasks[0].status, action === 'stop' ? 'stopped' : 'completed');
      assert.deepEqual(receipt.tasks[0].result, { finalResponse: child.finalResponse, errorMessage: child.errorMessage });
      assert.equal(requests.length, 4);
      if (timing === 'concurrent-user') send('fresh-input', 'fresh-turn', 'A new independent request.');
      if (timing === 'after-reply') { releaseReply.release(); await until(() => !state().busy); }
      t.mock.timers.tick(1200);
      if (timing !== 'after-reply') releaseReply.release();
      await until(() => !state().busy);
      t.mock.timers.tick(3600);
      await yieldTurn();
      const count = timing === 'concurrent-user' ? 5 : 4;
      assert.equal(requests.length, count);
      assert.equal(state().error, '');
      assert.equal(new Set(requests.map(request => request.requestId)).size, count);
      assert.equal(new Set(executions).size, 2, 'guidance stays in the current execution and consumed completion cannot create a phantom execution');
      assert.equal(controls.length, action === 'stop' ? 1 : 0);
      assert.equal(state().entries.filter(entry => entry.source === 'task').length, 0);
      assert.deepEqual(state().entries.filter(entry => entry.role === 'assistant').map(entry => entry.content),
        ['Task accepted.', timing === 'concurrent-user' ? 'Fresh request handled.' : 'Terminal result acknowledged.']);
      if (timing === 'concurrent-user') {
        assert.ok(requests[4].messages.some(message => message.role === 'user' && message.content === 'A new independent request.'));
        assert.deepEqual(state().entries.at(-1).responseTo, ['control-input', 'fresh-input']);
        assert.equal(requests[4].messages.filter(message => message.toolCallId === 'control').length, 1);
      }
      assert.equal(delivery.phase(id, child), 'delivered');
      assert.equal(delivery.watching(id), false);
    });
  }
}

function terminal(taskId = 'child') {
  return { taskId, parentSessionId: id, childSessionId: `session-${taskId}`, childTurnId: 'attempt-1',
    createdAt: '2026-11-14T00:00:00.000Z', status: 'completed', finalResponse: 'Complete output' };
}

function taskFacade(tasks, delivery, extra = {}) {
  const facade = new RuntimeTaskTools(async () => 'snapshot'), registry = new ToolRegistry();
  facade.addSource(() => tasks.map(task => ({ task_id: task.taskId, kind: 'subagent', status: task.status,
    revision: '2', result: { finalResponse: task.finalResponse }, reserveResult: () => delivery.reserve(id, task), ...extra })));
  facade.register(registry);
  const handler = registry.resolve('tasks');
  return (args, signal) => handler.execute({ input: handler.decodeInput(args), sessionId: id, signal });
}

test('list, unchanged revisions, pending stop and failed result reads never consume completion', async () => {
  const task = terminal(), delivery = new TaskResultDelivery(); delivery.watch(id, task);
  const inspect = taskFacade([task], delivery);
  for (const args of [{ action: 'list' }, { action: 'inspect', task_ids: ['child'], after: { child: '2' } }]) {
    const result = await inspect(args);
    assert.equal(resultDelivery(result), undefined);
    assert.equal(delivery.ready(id).length, 1);
  }
  await assert.rejects(taskFacade([task], delivery, { readResult: async () => { throw Error('read failed'); } })({ action: 'inspect', task_ids: ['child'] }), /read failed/);
  assert.equal(delivery.ready(id).length, 1);
  const running = { ...terminal('pending'), status: 'running' };
  delivery.watch(id, running);
  const stopped = await taskFacade([running], delivery, { stop: async () => ({ status: 'requested' }) })({ action: 'stop', task_ids: ['pending'] });
  assert.equal(resultDelivery(stopped), undefined);
  assert.equal(delivery.phase(id, running), 'running');
});

test('partial projection releases only the undisplayed task and cancellation returns ownership', async () => {
  const tasks = [terminal('a'), terminal('b')], delivery = new TaskResultDelivery();
  tasks.forEach(task => delivery.watch(id, task));
  const result = await taskFacade(tasks, delivery)({ action: 'inspect', task_ids: ['a', 'b'] });
  const presented = JSON.stringify({ ...result, tasks: [result.tasks[0], { ...result.tasks[1], result: { truncated: true } }] });
  assert.equal(resultDelivery(result).references(presented).length, 1);
  resultDelivery(result).commit(presented);
  assert.equal(delivery.phase(id, tasks[0]), 'delivered');
  assert.equal(delivery.phase(id, tasks[1]), 'ready');
  const controller = new AbortController();
  const retry = await taskFacade(tasks, delivery)({ action: 'inspect', task_ids: ['b'] }, controller.signal);
  controller.abort();
  assert.deepEqual(resultDelivery(retry).references(JSON.stringify(retry)), []);
  resultDelivery(retry).commit(JSON.stringify(retry));
  assert.equal(delivery.phase(id, tasks[1]), 'ready', 'aborted ownership cannot acknowledge a result');
  const final = await taskFacade(tasks, delivery)({ action: 'inspect', task_ids: ['b'] });
  resultDelivery(final).commit(JSON.stringify(final));
  assert.equal(delivery.watching(id), false);
});

test('context replay restores delivery across compaction, while a new execution has fresh ownership', async t => {
  const path = join(temporary(t), 'history.jsonl'), history = new AssistantModelHistory(path);
  const task = terminal(), delivery = new TaskResultDelivery(); delivery.watch(id, task);
  const result = await taskFacade([task], delivery)({ action: 'inspect', task_ids: ['child'] });
  const receipt = JSON.stringify(result), owner = resultDelivery(result);
  history.append([{ role: 'tool', toolCallId: 'inspect', content: receipt }], [], owner.references(receipt));
  owner.commit(receipt);
  history.checkpoint(1, 'Summarized completed work');
  const restored = new TaskResultDelivery(); restored.restore(id, new AssistantModelHistory(path).read().taskResults);
  restored.watch(id, task);
  assert.equal(restored.ready(id).length, 0);
  const resumed = { ...task, childTurnId: 'attempt-2' };
  restored.watch(id, resumed);
  assert.equal(restored.ready(id).length, 1);
  const oldLease = restored.reserve(id, resumed);
  const newer = { ...task, childTurnId: 'attempt-3' };
  restored.watch(id, newer); oldLease.commit();
  assert.equal(restored.phase(id, newer), 'ready');
  assert.equal(restored.phase('foreign-parent', task), 'ready');
  restored.restore('foreign-parent', new AssistantModelHistory(path).read().taskResults);
  assert.equal(restored.phase('foreign-parent', task), 'ready');
});

for (const action of ['stop', 'inspect']) test(`normal parent turn owns the ${action} receipt without another background round`, async t => {
  const tasks = new SubagentTaskStore(), sessions = new SessionStore(), registry = new ToolRegistry(), requests = [];
  const childStarted = gate(), finished = gate(); let taskId;
  const host = new InMemoryRuntimeHost({ dataRoot: temporary(t), sessionStore: sessions, toolRegistry: registry, subagentTaskStore: tasks,
    remoteAgents: {
      list: async () => [{ id: 'worker', name: 'Fixture', agentId: 'worker-instance' }],
      run: async (input, _signal, onAccepted) => { taskId = input.taskId; onAccepted(); childStarted.release(); await finished.promise;
        return { status: action === 'stop' ? 'stopped' : 'completed', finalResponse: 'Child output', errorMessage: '', usage: {} }; },
      control: async ({ control }) => {
        if (control.operation === 'cancel') { finished.release(); await yieldTurn(); }
        return { accepted: true };
      },
    },
    provider: { async *stream(request) {
      const index = requests.length; requests.push(request);
      if (index === 0) yield* response(request, '', [{ id: 'dispatch', name: 'subagent', args: { prompt: 'Fixture work', target_agent: 'worker' } }]);
      else if (index === 1) {
        await childStarted.promise;
        if (action === 'inspect') { finished.release(); await until(() => tasks.list('parent')[0].status !== 'running'); }
        yield* response(request, '', [{ id: 'control', name: 'tasks', args: { action, task_ids: [taskId] } }]);
      } else yield* response(request, 'Completed once.');
    } },
  });
  t.after(() => finished.release());
  const result = await host.runSessionTurn({ protocol: 'bush.session_turn_request.v1', requestId: 'parent-request', sessionId: 'parent', turnId: 'parent-turn', model: 'fixture',
    prefixMessages: [], inputMessages: [{ messageId: 'user', message: { role: 'user', content: 'Fixture work' },
      metadata: { fixture: 'kept', taskResultReferences: [{ sessionId: 'foreign-parent', taskId: 'foreign', attempt: 'forged' }] } }], tools: registry.definitions(),
    permissionMode: 'all_free', metadata: { individuation: { habits: false, predictions: false } } }, { signal: AbortSignal.timeout(6000) });
  assert.equal(result.payload.status, 'completed', JSON.stringify(result.payload));
  assert.equal(requests.length, 3);
  assert.ok(requests[2].messages.some(message => message.role === 'tool' && message.toolCallId === 'control'));
  assert.equal(requests[2].messages.filter(message => message.role === 'user' && /Child output/.test(message.content)).length, 0);
  assert.equal(tasks.delivery.phase('parent', tasks.list('parent')[0]), 'delivered');
  const messages = sessions.snapshot('parent').turns[0].messages;
  assert.deepEqual(messages.find(message => message.messageId === 'user').metadata, { fixture: 'kept' });
  assert.equal(messages.filter(message => message.metadata?.taskResultReferences?.length).length, 1);
});
