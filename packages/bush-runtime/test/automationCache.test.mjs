import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { InMemoryRuntimeHost, ToolRegistry, SessionStore, FileSessionEventPersistence, InMemoryRuntimeCheckpointStore, InMemoryRuntimeEventLog } from '../dist/index.js';
import { toResponsesCreateParams } from '../../bush-provider-openai/dist/index.js';
import { responsesInputFingerprint } from '../../bush-provider-openai/dist/responsesInputFingerprint.js';

const reminders = request => request.messages.filter(message => message.name === 'automation_unread_reminder');
const state = message => JSON.parse(message.content.split('\n').at(-1));
const until = async check => { const end = Date.now() + 3000; while (!check()) { if (Date.now() > end) throw Error('Condition timed out'); await new Promise(resolve => setTimeout(resolve, 5)); } };
const event = (request, kind, rest = {}) => ({ protocol: 'bush.model_event.v1', kind, requestId: request.requestId, sequence: kind === 'response_completed' ? 2 : 1, createdAt: new Date().toISOString(), ...rest });
function assertExtension(before, after) {
  assert.deepEqual(after.params.tools, before.params.tools, 'the wire tool declarations are unchanged');
  assert.deepEqual(after.params.input.slice(0, before.params.input.length), before.params.input, 'the entire transmitted prefix is preserved');
}
async function fixture(t, recoveredEvents = []) {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-automation-cache-'));
  const f = { root, requests: [], handler: undefined, checkpoints: new InMemoryRuntimeCheckpointStore(), total: 0, tick: 0 };
  const automation = { reminder: async () => ({ asOf: new Date(Date.UTC(2026, 8, 17, 0, 0, f.tick++)).toISOString(), total: f.total,
    items: f.total ? [{ jobId: 'job', runId: 'run', sessionId: 'session', title: 'Result', status: 'completed', finishedAt: '2026-09-17T00:00:00.000Z' }] : [] }),
    remember: async () => {}, emit: async () => {}, notify: () => {}, manage: async () => ({ results: [], total: 0 }) };
  f.open = () => {
    f.persistence = new FileSessionEventPersistence({ root: join(root, 'sessions') });
    f.store = new SessionStore({ persistence: f.persistence });
    const registry = new ToolRegistry();
    f.host = new InMemoryRuntimeHost({ dataRoot: join(root, 'runtime'), automation, toolRegistry: registry, sessionStore: f.store, checkpointStore: f.checkpoints, registerDefaultWorkspaceTools: false,
      eventLog: new InMemoryRuntimeEventLog({ persistence: { load: (session, turn) => recoveredEvents.filter(e => e.sessionId === session && e.turnId === turn), append: () => {} } }),
      provider: { async *stream(request, options) {
        const params = toResponsesCreateParams(request, { toolSearchMode: 'native', disableProviderState: true });
        const record = { request: structuredClone(request), params }; f.requests.push(record);
        options.onInputProjection?.(responsesInputFingerprint(params, params, request.providerBinding));
        if (f.handler) { yield* f.handler(request, options); return; }
        yield event(request, 'text_delta', { delta: 'Done.' }); yield event(request, 'response_completed', { finishReason: 'stop' });
      } } });
    f.tools = registry.definitions().filter(tool => ['checkpoint_context', 'scheduled_results', 'mcp_search', 'mcp_call'].includes(tool.name)).sort((a, b) => a.name.localeCompare(b.name));
  };
  f.close = async () => { await f.host.sendCommand({ kind: 'runtime.shutdown', payload: {} }); f.persistence.close(); };
  f.run = (id, overrides = {}) => f.host.runSessionTurn({ protocol: 'bush.session_turn_request.v1', requestId: `request-${id}`, sessionId: 'session', turnId: id, model: 'offline-fixture',
    prefixMessages: [{ role: 'system', content: 'Follow the user.' }], inputMessages: [{ messageId: `input-${id}`, message: { role: 'user', content: `Continue ${id}` } }], tools: f.tools, metadata: {}, permissionMode: 'task_free', ...overrides });
  f.open();
  t.after(async () => { await f.close(); assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'cardbush-automation-cache-')); await rm(root, { recursive: true, force: true }); });
  return f;
}

test('unread changes append once and survive complete turns and a journal restart on the actual wire', async t => {
  const f = await fixture(t);
  await f.run('empty'); assert.equal(reminders(f.requests.at(-1).request).length, 0);
  f.total = 1; await f.run('unread');
  const original = structuredClone(reminders(f.requests.at(-1).request)[0]);
  await f.run('same-unread'); assert.equal(reminders(f.requests.at(-1).request).length, 1, 'asOf alone does not cause another injection');
  f.total = 0; await f.run('read');
  assert.deepEqual(reminders(f.requests.at(-1).request).map(state).map(s => s.total), [1, 0]);
  await f.run('same-read'); assert.equal(reminders(f.requests.at(-1).request).length, 2);
  await f.close(); f.open(); await f.run('after-restart');
  assert.deepEqual(reminders(f.requests.at(-1).request)[0], original);
  assert.equal(reminders(f.requests.at(-1).request).length, 2);
  for (let i = 1; i < f.requests.length; i++) assertExtension(f.requests[i - 1], f.requests[i]);
  const history = f.store.snapshot('session');
  assert.deepEqual(history.turns.flatMap(turn => turn.messages).filter(item => item.message.name === 'automation_unread_reminder').map(item => item.message), reminders(f.requests.at(-1).request));
  assert.equal(history.turns[1].messages[0].message.content, 'Continue unread');
  assert.ok(f.host.events('session', 'after-restart').filter(e => e.kind === 'provider_input_observed').every(e => !e.payload.frozenPrefixBreak));
});

test('queued guidance appends the changed observation after existing tool history without resending equal snapshots', async t => {
  const f = await fixture(t); f.total = 1;
  let rounds = 0;
  f.handler = async function* (request) {
    if (++rounds <= 2) {
      if (rounds === 2) f.total = 0;
      await f.host.sendCommand({ kind: 'runtime.enqueue_guidance', payload: { protocol: 'bush.runtime_guidance.v1', sessionId: 'session', turnId: 'guidance', messageId: `guidance-${rounds}`, content: `Scope ${rounds}`, createdAt: new Date().toISOString() } });
      yield event(request, 'tool_call_delta', { index: 0, toolCallId: `inbox-${rounds}`, nameDelta: 'scheduled_results', argumentsDelta: '{}' });
      yield event(request, 'response_completed', { finishReason: 'tool_calls' }); return;
    }
    yield event(request, 'text_delta', { delta: 'Done.' }); yield event(request, 'response_completed', { finishReason: 'stop' });
  };
  assert.equal((await f.run('guidance')).payload.status, 'completed');
  assert.deepEqual(f.requests.map(r => reminders(r.request).map(state).map(s => s.total)), [[1], [1], [1, 0]]);
  assertExtension(f.requests[0], f.requests[1]); assertExtension(f.requests[1], f.requests[2]);
  const history = f.store.snapshot('session').turns[0];
  assert.deepEqual(history.messages.filter(item => item.message.name === 'automation_unread_reminder').map(item => item.message), reminders(f.requests[2].request));
  f.handler = undefined; await f.run('next'); assertExtension(f.requests[2], f.requests[3]);
});

test('automatic inputs keep prior observations without adding reminders', async t => {
  const f = await fixture(t); f.total = 1; await f.run('human');
  const before = reminders(f.requests[0].request); f.total = 0;
  for (const [name, metadata] of [['goal_continuation', {}], ['automation_prompt', { automationRunId: 'run' }]]) {
    await f.run(name, { metadata, inputMessages: [{ messageId: name, message: { role: 'user', name, content: 'Continue' } }] });
    assert.deepEqual(reminders(f.requests.at(-1).request), before);
    assertExtension(f.requests.at(-2), f.requests.at(-1));
  }
});

test('compaction may remove an observation from visible context without suppressing the next current snapshot', async t => {
  const f = await fixture(t); f.total = 1; await f.run('old');
  const original = f.store.snapshot('session');
  f.store.summarizeTurns({ sessionId: 'session', expectedRevision: original.revision, summaries: [{ turnId: 'old', summary: 'Prior user work is completed.' }] });
  await f.run('after-compaction');
  assert.equal(reminders(f.requests.at(-1).request).length, 1);
  assert.notEqual(state(reminders(f.requests[0].request)[0]).asOf, state(reminders(f.requests[1].request)[0]).asOf);
  assert.deepEqual(f.store.snapshot('session').turns[0].messages, original.turns[0].messages, 'raw historical facts remain unchanged');
  assert.equal(f.host.events('session', 'after-compaction').find(e => e.kind === 'provider_input_observed').payload.messageBreakIndex, 1, 'the actual compaction rewrite is still reported');
  await f.run('continued'); assertExtension(f.requests[1], f.requests[2]);
});

test('stopping retains the sent reminder and recovery reuses its saved bytes without reading a fresh inbox', async t => {
  const f = await fixture(t); f.total = 1;
  f.handler = async function* (_request, options) { await new Promise(resolve => { if (options.signal.aborted) resolve(); else options.signal.addEventListener('abort', resolve, { once: true }); }); };
  const running = f.run('interrupted'); await until(() => f.requests.length === 1);
  const checkpoint = JSON.parse(JSON.stringify(f.checkpoints.load('session', 'interrupted')));
  const durableEvents = f.host.events('session', 'interrupted').filter(e => e.sequence <= checkpoint.lastEventSequence);
  assert.ok(checkpoint.sessionCommit.inputMessages.some(item => item.message.name === 'automation_unread_reminder'));
  await f.host.sendCommand({ kind: 'runtime.stop_turn', payload: { sessionId: 'session', turnId: 'interrupted' } });
  assert.equal((await running).payload.status, 'stopped');
  f.total = 0; f.handler = undefined; await f.run('after-stop'); assertExtension(f.requests[0], f.requests[1]);
  const recovered = await fixture(t, durableEvents); recovered.total = 0;
  recovered.checkpoints.save(checkpoint);
  const readsBefore = recovered.tick;
  const terminal = await recovered.host.resumeModelTurn('session', 'interrupted');
  assert.equal(terminal.payload.status, 'completed');
  assert.deepEqual(recovered.requests[0].params, f.requests[0].params);
  assert.equal(recovered.tick, readsBefore, 'recovery does not refresh previously sent app context');
  const observations = recovered.store.snapshot('session').turns[0].messages.filter(item => item.message.name === 'automation_unread_reminder');
  assert.equal(observations.length, 1); assert.equal(state(observations[0].message).total, 1);
});
