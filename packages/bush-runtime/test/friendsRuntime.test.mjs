import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { InMemoryRuntimeHost, InMemoryRuntimeEventLog, ToolRegistry, SessionStore } from '../dist/index.js';
import { AssistantEvents } from '../dist/assistantEvents.js';
import { CollectorReadError } from '../dist/eventCollector.js';
import { FRIENDS_COMMAND, FRIENDS_SESSION, PERSONAL_ASSISTANT_SESSION } from '@cardbush/bush-protocol';

const now = () => new Date().toISOString();
const modelEvent = (request, sequence, kind, extra = {}) => ({ protocol: 'bush.model_event.v1', requestId: request.requestId, sequence, createdAt: now(), kind, ...extra });
const data = request => JSON.parse(request.messages.find(message => message.name === 'friends_event_data').content);
const decide = disposition => ({ name: 'friends_decide', input: { disposition, basis: 'Observed event evidence.', habitRefs: [] } });
test('a successful event turn publishes its desktop pages durably alongside the actual result', async t => {
  const presentation = { summary: 'Release checks complete', cover: 'prism',
    pages: [{ id: 'checks', title: 'Checks', layout: 'facts', items: [{ label: 'Renderer', text: 'Passed' }] }] };
  const f = await fixture(t, (_request, round) => round === 1
    ? { calls: [{ name: 'friends_decide', input: { ...decide('completed').input, presentation } }] }
    : { text: 'The renderer passed.' });
  await f.configure(); await f.send('desktop-fixture');
  const snapshot = await until(f.read, s => s.events.some(e => e.status === 'completed'));
  assert.deepEqual(snapshot.events[0].presentation, presentation);
  assert.equal(snapshot.events[0].result.text, 'The renderer passed.');
  const persisted = JSON.parse(await readFile(join(f.root, 'friends', 'events.json'), 'utf8'));
  assert.deepEqual(persisted.events[0].presentation, presentation);
});
async function until(read, predicate) {
  for (let i = 0; i < 200; i++) { const value = await read(); if (predicate(value)) return value; await sleep(10); }
  throw Error('Timed out waiting for Friends state');
}
async function fixture(t, handle, options = {}) {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'cardbush-friends-test-'));
  const requests = [], rounds = new Map(), registry = options.registry ?? new ToolRegistry(), sessions = new SessionStore();
  sessions.ensureSession(FRIENDS_SESSION, { hidden: true, friends: true });
  const host = new InMemoryRuntimeHost({ dataRoot: root, registerDefaultWorkspaceTools: false, toolRegistry: registry, sessionStore: sessions,
    provider: { async *stream(request, streamOptions) {
      requests.push(request); const round = (rounds.get(request.turnId) ?? 0) + 1; rounds.set(request.turnId, round);
      const output = await handle(request, round, streamOptions.signal);
      let n = 0;
      for (const [index, call] of (output.calls ?? []).entries()) yield modelEvent(request, n++, 'tool_call_delta', {
        index, toolCallId: `call-${request.turnId}-${round}-${index}`, nameDelta: call.name, argumentsDelta: JSON.stringify(call.input) });
      if (output.text) yield modelEvent(request, n++, 'text_delta', { delta: output.text });
      yield modelEvent(request, n++, 'response_completed', { finishReason: output.calls?.length ? 'tool_calls' : 'stop' });
    } }, ...options.host });
  const command = payload => host.sendCommand({ kind: FRIENDS_COMMAND, payload });
  const read = () => command({ action: 'read' });
  const configure = (profile = {}, parent = {}) => command({ action: 'configure', profile: { name: 'Fixture friend', language: 'zh', timeZone: 'Asia/Shanghai', recognition: { context: 'Only fixture work.' }, confirmedAt: now(), ...profile },
    parent: { protocol: 'bush.session_turn_request.v1', requestId: 'configuration', sessionId: FRIENDS_SESSION, turnId: 'configuration',
      model: 'fixture', tools: registry.definitions().filter(tool => !tool.name.startsWith('friends_')), prefixMessages: [],
      inputMessages: [{ messageId: 'old-input', message: { role: 'user', content: 'UNRELATED_CHAT_MUST_NOT_BE_INHERITED' } }], metadata: {}, permissionMode: 'task_free',
      requestCapabilities: { interactiveRequests: true, vision: false }, ...parent } });
  const send = (id, text = 'Do this event', relatesTo) => command({ action: 'submit', input: { id, text, createdAt: '2026-11-06T02:00:00.000Z', ...(relatesTo ? { relatesTo } : {}) } });
  const close = () => host.sendCommand({ kind: 'runtime.shutdown', payload: {} });
  t.after(async () => { await close(); if (!options.keep) { assert.equal(dirname(resolve(root)), resolve(tmpdir())); await rm(root, { recursive: true, force: true }); } });
  return { root, host, registry, requests, command, read, configure, send, close };
}
const simple = async (_request, round) => round === 1 ? { calls: [decide('completed')] } : { text: 'A real terminal result.' };

test('confirmed recognition starts an event with no habit or user input; reconnecting and waiting do not repeat inference', async t => {
  const f = await fixture(t, async (request, round) => {
    if (round === 1) return { calls: [{ name: 'check_habit', input: { topics: ['fixture sport'] } }] };
    if (round === 2) return { calls: [{ name: 'friends_create_event', input: { logicalKey: 'first-observation', title: 'One modest observation', intent: 'Observe the explicitly agreed fixture interest once.' } }] };
    if (round === 3) {
      const event = (await f.read()).events.find(event => event.logicalKey === 'first-observation');
      return { calls: [{ name: 'friends_watch_time', input: { eventId: event.id, at: new Date(Date.now() + 60_000).toISOString() } }, decide('completed')] };
    }
    return { text: 'One agreed observation is registered. Further events depend on feedback.' };
  }, { keep: true });
  const profile = { recognition: { context: 'I follow fixture sport; check once at the agreed time.' }, interactionPreferences: { beforeExecution: 'within-scope', report: 'important' } };
  await f.configure(profile, { metadata: { individuation: { habits: false, predictions: false } } });
  const state = await until(f.read, state => state.events[0]?.status === 'completed');
  assert.equal(state.events.length, 2); assert.equal(state.events[1].status, 'watching');
  assert.ok(state.events.every(event => event.inputs.length === 0));
  assert.deepEqual(state.events[0].decision.habitRefs, []);
  assert.equal(state.detections.length, 1);
  assert.deepEqual(data(f.requests[0]).profile.interactionPreferences, profile.interactionPreferences);
  assert.match(data(f.requests[0]).event.intent, /even when no saved habits exist/);
  assert.ok(f.requests.some(request => request.messages.some(message => message.role === 'tool' && /"memories"\s*:\s*\[\]/.test(message.content))));
  const count = f.requests.length;
  await f.configure(profile); await f.configure(profile); await f.read(); await sleep(40);
  assert.equal(f.requests.length, count, 'reading and reconnecting cannot create a discovery loop');
  await f.close();
  const restarted = await fixture(t, simple, { root: f.root });
  await restarted.configure(profile); await sleep(40);
  assert.equal(restarted.requests.length, 0, 'durable discovery does not replay after restart');
  assert.equal((await restarted.read()).detections.length, 1);
});

test('automatic discovery allows one new event and idempotent reuse, while explicit user batches remain possible', async t => {
  const create = key => ({ name: 'friends_create_event', input: { logicalKey: key, title: key, intent: 'Fixture event.' } });
  const f = await fixture(t, async (request, round) => {
    if (data(request).signals.some(signal => signal.kind === 'input')) return round === 1 ? { calls: [create('requested-one'), create('requested-two'), decide('completed')] } : { text: 'Both requested events recorded.' };
    if (round === 1) return { calls: [create('first')] };
    if (round === 2) return { calls: [create('first'), create('too-many')] };
    return round === 3 ? { calls: [decide('completed')] } : { text: 'One exploratory event recorded.' };
  });
  await f.configure(); await until(f.read, state => state.events[0]?.status === 'completed');
  assert.deepEqual((await f.read()).events.map(event => event.logicalKey), ['startup', 'first']);
  assert.ok(f.requests.some(request => JSON.stringify(request.messages).includes('FRIENDS_DISCOVERY_EVENT_LIMIT')));
  const eventId = (await f.read()).events.find(event => event.logicalKey === 'first').id;
  await f.send('batch', 'Create both explicitly requested fixture events.', eventId);
  await until(f.read, state => state.events.find(event => event.id === eventId)?.status === 'completed');
  assert.ok((await f.read()).events.some(event => event.logicalKey === 'requested-one'));
  assert.ok((await f.read()).events.some(event => event.logicalKey === 'requested-two'));
});

test('a timed activation of a user-created event also expands by at most one new event', async t => {
  const f = await fixture(t, async (request, round) => {
    const context = data(request);
    if (context.event.id !== 'scheduled') return simple(request, round);
    if (round > 1) return { text: 'The concrete observation is handled.' };
    if (context.signals.some(signal => signal.kind === 'input')) return { calls: [
      { name: 'friends_watch_time', input: { eventId: context.event.id, at: new Date(Date.now() + 200).toISOString() } }, decide('watching')] };
    return { calls: ['clock-one', 'clock-two'].map(key => ({ name: 'friends_create_event', input: { logicalKey: key, title: key, intent: 'One related opportunity.' } })).concat(decide('completed')) };
  });
  await f.configure(); await until(f.read, state => state.events[0]?.status === 'completed');
  await f.send('scheduled', 'Observe this event at its agreed time.');
  await until(f.read, state => state.events.find(event => event.id === 'scheduled')?.status === 'completed');
  assert.deepEqual((await f.read()).events.filter(event => event.origin === 'agent').map(event => event.logicalKey), ['clock-one']);
});

test('an old empty completed setup receives one discovery activation, while paused or pending work stays untouched', async t => {
  const old = await fixture(t, simple, { keep: true });
  await old.configure(); await until(old.read, state => state.events[0]?.status === 'completed'); await old.close();
  const path = join(old.root, 'friends/events.json'), seed = JSON.parse(await readFile(path, 'utf8'));
  delete seed.discoveryStarted;
  await writeFile(path, JSON.stringify(seed));
  const upgraded = await fixture(t, simple, { root: old.root, keep: true });
  await upgraded.configure(); await until(upgraded.read, state => state.events[1]?.status === 'completed');
  assert.equal((await upgraded.read()).events[1].logicalKey, 'recognition-discovery');
  const count = upgraded.requests.length;
  await upgraded.configure(); await sleep(30); assert.equal(upgraded.requests.length, count); await upgraded.close();
  for (const status of ['paused', 'failed', 'waiting_user', 'archived', 'answered']) {
    const root = await mkdtemp(join(tmpdir(), 'cardbush-friends-test-'));
    const unchanged = structuredClone(seed);
    if (status === 'archived') unchanged.events[0].archived = true;
    else if (status === 'answered') unchanged.events[0].inputs.push({ id: 'answered', text: 'No more suggestions for now.', createdAt: now(), relatesTo: unchanged.events[0].id });
    else unchanged.events[0].status = status;
    await mkdir(join(root, 'friends')); await writeFile(join(root, 'friends/events.json'), JSON.stringify(unchanged));
    const f = await fixture(t, simple, { root }); await f.configure(); await sleep(20);
    assert.equal(f.requests.length, 0, status); assert.deepEqual((await f.read()).events, unchanged.events);
  }
  // The final fixture owns cleanup of the shared temporary root.
  await fixture(t, simple, { root: old.root });
});

test('accepted inputs are durable before inference, and each activation uses event evidence rather than chat history', async t => {
  const release = Promise.withResolvers(), entered = Promise.withResolvers();
  const f = await fixture(t, async (request, round) => {
    if (data(request).event.origin === 'user' && round === 1) { entered.resolve(request); await release.promise; }
    return simple(request, round);
  });
  await f.configure(); await until(f.read, state => state.events[0]?.status === 'completed');
  await f.send('user-one'); const request = await entered.promise;
  const state = await f.read(); assert.equal(state.events.find(e => e.id === 'user-one').inputs[0].text, 'Do this event');
  assert.equal(state.events.find(e => e.id === 'user-one').result, undefined);
  assert.ok(!JSON.stringify(request.messages).includes('UNRELATED_CHAT'));
  assert.equal(request.messages.some(m => m.role === 'user' && m.visibility !== 'internal'), false);
  const environment = await f.host.readEnvironment(FRIENDS_SESSION);
  assert.equal(environment.sections.agents.self.status, 'running');
  assert.equal(environment.sections.friends.active.eventId, 'user-one');
  const persisted = JSON.parse(await readFile(join(f.root, 'friends/events.json'), 'utf8'));
  assert.equal(persisted.events.find(e => e.id === 'user-one').inputs.length, 1);
  release.resolve(); await until(f.read, state => state.events.find(e => e.id === 'user-one').status === 'completed');
  await f.send('user-one'); await sleep(30);
  assert.equal((await f.read()).events.filter(e => e.id === 'user-one').length, 1);
  await assert.rejects(() => f.send('user-one', 'changed'), /ID_CONFLICT/);
});

test('follow-up arriving during execution is retained and processed once after the current safe return', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(); let first = true;
  const f = await fixture(t, async (request, round) => {
    if (data(request).event.id === 'work' && first && round === 1) { first = false; entered.resolve(); await release.promise; }
    return simple(request, round);
  });
  await f.configure(); await until(f.read, state => state.events[0]?.status === 'completed');
  await f.send('work'); await entered.promise; await f.send('followup', 'Additional evidence', 'work');
  release.resolve(); await until(f.read, state => state.events.find(e => e.id === 'work')?.status === 'completed' && !state.active);
  const activations = f.requests.filter(r => data(r).event.id === 'work' && !r.messages.some(m => m.role === 'tool'));
  assert.equal(activations.length, 2);
  assert.deepEqual(data(activations[1]).event.inputs.map(x => x.id), ['work', 'followup']);
  assert.equal(data(activations[1]).signals.length, 1);
});

test('future detection survives host restart; no inference while waiting, no duplicate delivery after firing', async t => {
  const at = new Date(Date.now() + 650).toISOString();
  const handler = async (request, round) => {
    const context = data(request);
    if (round === 1) return { calls: context.signals[0].kind === 'startup'
      ? [{ name: 'friends_watch_time', input: { eventId: context.event.id, at } }, decide('watching')]
      : [decide('completed')] };
    return { text: context.signals[0].kind === 'startup' ? 'Waiting.' : 'Due event delivered.' };
  };
  const a = await fixture(t, handler, { keep: true }); await a.configure();
  await until(a.read, state => state.events[0]?.status === 'watching'); const count = a.requests.length;
  await sleep(40); await a.read(); assert.equal(a.requests.length, count); await a.close();
  const b = await fixture(t, handler, { root: a.root });
  const before = await b.read(); assert.equal(before.detections.length, 1); assert.equal(b.requests.length, 0);
  await b.configure(); await until(b.read, state => state.events[0]?.result?.text === 'Due event delivered.');
  assert.equal((await b.read()).detections.length, 0);
  const after = b.requests.length; await sleep(50); assert.equal(b.requests.length, after);
});

test('a staged decision and partial text cannot publish a failed Runtime execution', async t => {
  const f = await fixture(t, async (request, round) => {
    if (round === 1) return { calls: [decide('completed')] };
    throw Error('fixture provider failed');
  });
  await f.configure(); const state = await until(f.read, state => state.events[0]?.status === 'failed');
  assert.equal(state.events[0].result, undefined); assert.equal(state.active, undefined);
  const count = f.requests.length; await sleep(40); assert.equal(f.requests.length, count);
});

test('pause waits for the execution to settle and never labels a cancelled event complete', async t => {
  const entered = Promise.withResolvers();
  const f = await fixture(t, async (_request, _round, signal) => {
    entered.resolve(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    return { text: 'Discarded output.' };
  });
  await f.configure(); await entered.promise; const id = (await f.read()).events[0].id;
  await f.command({ action: 'pause', eventId: id });
  const state = await until(f.read, state => !state.active);
  assert.equal(state.events[0].status, 'paused'); assert.equal(state.events[0].result, undefined);
});

test('model content is not rewritten or filtered by semantic heuristics', async t => {
  const f = await fixture(t, async (_request, round) => round === 1 ? { calls: [decide('completed')] } : { text: 'A model-authored factual claim, preserved verbatim.' });
  await f.configure(); const state = await until(f.read, state => state.events[0]?.status === 'completed');
  assert.equal(state.events[0].result.text, 'A model-authored factual claim, preserved verbatim.');
});

test('archiving is presentation-only, and unrelated inputs do not enter each other\'s context', async t => {
  const f = await fixture(t, simple); await f.configure(); await until(f.read, state => state.events[0]?.status === 'completed');
  await f.send('first', 'FIRST_SECRET'); await until(f.read, state => state.events.find(e => e.id === 'first')?.status === 'completed');
  await f.command({ action: 'archive', eventId: 'first' }); await f.send('second', 'SECOND_INPUT');
  await until(f.read, state => state.events.find(e => e.id === 'second')?.status === 'completed');
  assert.equal((await f.read()).events.find(e => e.id === 'first').status, 'completed');
  assert.ok(f.requests.filter(r => data(r).event.id === 'second').every(r => !JSON.stringify(r.messages).includes('FIRST_SECRET')));
  await assert.rejects(() => f.send('orphan', 'x', 'unknown'), /EVENT_NOT_FOUND/);
});

test('event tools reject foreign sessions and require a live Friends execution', async t => {
  const f = await fixture(t, simple);
  const tool = f.registry.resolve('friends_decide');
  assert.equal(tool.modelAvailable({ sessionId: 'personal-assistant', metadata: {} }), false);
  assert.throws(() => tool.execute({ sessionId: FRIENDS_SESSION, turnId: 'not-running', input: decide('completed').input }), /ACTIVE_EXECUTION_REQUIRED/);
});

for (const decision of ['allow_once', 'deny', 'cancel']) test(`Friends forwards ordinary tool permissions and handles ${decision}`, async t => {
  let executed = 0;
  const f = await fixture(t, async (_request, round) => round === 1 ? { calls: [{ name: 'fixture_protected', input: {} }] }
    : round === 2 ? { calls: [decide('completed')] } : { text: 'Permission result received.' });
  f.registry.register({ definition: { name: 'fixture_protected', description: 'Fixture action', inputSchema: { type: 'object', properties: {} } },
    manifest: { effect_kind: 'mutation', operation: 'fixture', risk: 'low', owner: 'fixture', dispatch_scope: 'turn', mutating: true },
    decodeInput: value => value,
    authorize: () => ({ kind: 'ask', request: { reason: 'Fixture permission', actions: ['fixture.action'], targets: [{ kind: 'filesystem_path', value: f.root }], capabilityIds: ['fixture.action'] } }),
    execute: () => { executed++; return { ok: true }; } });
  await f.configure(); const state = await until(f.read, value => {
    if (['completed', 'failed'].includes(value.events[0]?.status)) assert.fail(JSON.stringify({ event: value.events[0], tools: f.requests.at(-1)?.messages.filter(message => message.role === 'tool') }));
    return value.permissions.length === 1;
  });
  assert.equal(executed, 0); assert.equal(state.events[0].result, undefined);
  assert.equal((await f.host.readEnvironment(FRIENDS_SESSION)).sections.agents.self.status, 'waiting');
  const permission = state.permissions[0];
  await f.host.sendCommand({ kind: 'runtime.answer_permission', payload: { protocol: 'bush.runtime_permission_answer.v1',
    permissionId: permission.permissionId, answerId: crypto.randomUUID(), decision,
    ...(decision === 'allow_once' ? { grantedCapabilityIds: permission.request.requestedCapabilityIds } : {}) } });
  const done = await until(f.read, value => value.events[0]?.status === 'completed');
  assert.equal(done.permissions.length, 0); assert.equal(executed, decision === 'allow_once' ? 1 : 0);
});

test('interrupted execution stays paused across restart until an explicit resume, preserving its receipt identity', async t => {
  const a = await fixture(t, simple, { keep: true }); await a.configure(); await until(a.read, state => state.events[0]?.status === 'completed');
  await a.close(); const path = join(a.root, 'friends/events.json'), persisted = JSON.parse(await readFile(path, 'utf8'));
  const event = persisted.events[0]; event.status = 'running'; delete event.result;
  persisted.active = { eventId: event.id, turnId: 'interrupted-real-turn', signalIds: ['pending-signal'] };
  persisted.signals = [{ id: 'pending-signal', eventId: event.id, kind: 'resume', createdAt: now() }];
  await writeFile(path, JSON.stringify(persisted));
  const b = await fixture(t, simple, { root: a.root }); await b.configure(); await sleep(40);
  assert.equal(b.requests.length, 0); const paused = (await b.read()).events[0];
  assert.equal(paused.status, 'paused'); assert.equal(paused.interruptedTurnId, 'interrupted-real-turn');
  await b.command({ action: 'resume', eventId: event.id }); await until(b.read, state => state.events[0]?.status === 'completed');
  assert.equal(data(b.requests[0]).event.interruptedTurnId, 'interrupted-real-turn');
  assert.equal((await b.read()).events[0].interruptedTurnId, undefined);
});

test('recovery freezes an interrupted bridge receipt; explicit local resume never gets inbound permissions or emits a second reply', async t => {
  const first = await fixture(t, simple, { keep: true }); await first.configure();
  await until(first.read, s => s.events[0]?.status === 'completed');
  const receiptId = crypto.randomUUID(), id = `webhook-input-${receiptId}`;
  const input = { action: 'receive_webhook', receiptId, text: 'Fixture update', createdAt: now() };
  await first.command(input); await until(first.read, s => s.events.find(e => e.id === id)?.status === 'completed'); await first.close();
  const path = join(first.root, 'friends/events.json'), disk = JSON.parse(await readFile(path, 'utf8'));
  disk.events.find(e => e.id === id).status = 'running';
  disk.webhookReceipts[id] = { status: 'pending', reply: '' };
  disk.active = { eventId: id, turnId: 'uncertain-execution', signalIds: [`input:${id}`] };
  disk.signals = [{ id: `input:${id}`, eventId: id, kind: 'input', createdAt: now() }];
  await writeFile(path, JSON.stringify(disk));
  const restarted = await fixture(t, simple, { root: first.root });
  const interrupted = { status: 'interrupted', reply: '', errorCode: 'runtime_restart_interrupted' };
  assert.deepEqual(await restarted.command({ action: 'read_webhook', receiptId }), interrupted);
  await restarted.configure(); assert.deepEqual(await restarted.command(input), interrupted); assert.equal(restarted.requests.length, 0);
  await restarted.command({ action: 'resume', eventId: id });
  await until(restarted.read, s => s.events.find(e => e.id === id)?.status === 'completed');
  assert.equal(restarted.requests[0].permissionMode, 'task_free');
  assert.deepEqual(restarted.requests[0].metadata.botSourceRefs, [`webhook:${receiptId}`]);
  assert.deepEqual(await restarted.command({ action: 'read_webhook', receiptId }), interrupted);
});

test('invalid persisted state fails closed without being replaced by an empty store', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-friends-test-')); await mkdir(join(root, 'friends'));
  const path = join(root, 'friends/events.json'), invalid = JSON.stringify({ version: 1, events: [], signals: [{ id: 'bad', eventId: 'missing' }], detections: [] });
  await writeFile(path, invalid); const f = await fixture(t, simple, { root });
  await assert.rejects(f.read, /STATE_INVALID/); await assert.rejects(f.configure, /STATE_INVALID/);
  assert.equal(await readFile(path, 'utf8'), invalid); assert.equal(f.requests.length, 0);
});

test('an explicit final disposition cancels its previous detector instead of waking completed work again', async t => {
  const f = await fixture(t, async (request, round) => round === 1 ? { calls: [
    { name: 'friends_watch_time', input: { eventId: data(request).event.id, at: new Date(Date.now() + 120).toISOString() } }, decide('completed')]
  } : { text: 'No future work remains.' });
  await f.configure(); await until(f.read, state => state.events[0]?.status === 'completed');
  assert.equal((await f.read()).detections.length, 0); const count = f.requests.length;
  await sleep(160); assert.equal(f.requests.length, count);
});

test('async questions use the common answer broker and cannot be answered from another session', async t => {
  const waiting = Promise.withResolvers();
  const f = await fixture(t, async (request, round) => {
    if (round === 1) return { calls: [{ name: 'request_user_input_async', input: { questions: [{ id: 'format', prompt: 'Choose a format.', options: ['Text', 'PDF'] }] } }] };
    if (round === 2) { await waiting.promise; return { calls: [decide('completed')] }; }
    return { text: 'Answer received.' };
  });
  await f.configure(); const pending = await until(f.read, state => state.solutions.length === 1);
  await f.host.sendCommand({ kind: 'runtime.create_session', payload: { sessionId: 'personal-assistant' } });
  const status = () => f.host.sendCommand({ kind: 'runtime.assistant_conversation', payload: { action: 'read', sessionId: 'personal-assistant' } });
  assert.equal((await status()).eventNeedsResponse, true, 'the Assistant exposes the pending event interaction');
  const question = pending.solutions[0];
  const payload = { selectionId: question.selectionId, sessionId: FRIENDS_SESSION, turnId: question.turnId,
    kind: 'answers', answers: [{ questionId: 'format', kind: 'option', optionIndex: 0 }] };
  await assert.rejects(() => f.host.sendCommand({ kind: 'runtime.answer_solution_selection', payload: { ...payload, sessionId: 'personal-assistant' } }), /different session/);
  await f.host.sendCommand({ kind: 'runtime.answer_solution_selection', payload }); waiting.resolve();
  assert.equal((await status()).eventNeedsResponse, false);
  const done = await until(f.read, state => state.events[0]?.status === 'completed');
  assert.equal(done.solutions.length, 0);
  assert.ok(f.requests.some(request => request.messages.some(message => message.name === 'background_tool_result' && message.content.includes('Text'))));
});

test('a failed event does not silently consume or execute follow-ups queued during its interrupted action', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(); let fail = true;
  const f = await fixture(t, async (request, round) => {
    if (data(request).event.id === 'work' && fail) {
      if (round === 1) { entered.resolve(); await release.promise; }
      else throw Error('fixture interrupted action');
    }
    return simple(request, round);
  }, { host: { maxAttempts: 1 } });
  await f.configure(); await until(f.read, state => state.events[0]?.status === 'completed');
  await f.send('work'); await entered.promise; await f.send('later', 'Follow-up evidence', 'work'); release.resolve();
  await until(f.read, state => state.events.find(e => e.id === 'work')?.status === 'failed');
  const count = f.requests.length; await sleep(50); assert.equal(f.requests.length, count);
  fail = false; await f.command({ action: 'resume', eventId: 'work' });
  await until(f.read, state => state.events.find(e => e.id === 'work')?.status === 'completed');
  assert.deepEqual(data(f.requests.at(-1)).event.inputs.map(input => input.id), ['work', 'later']);
});

test('user input IDs cannot replace technical events or suppress system signals', async t => {
  const f = await fixture(t, simple); const configured = await f.configure();
  await assert.rejects(() => f.send(configured.events[0].id), /INPUT_ID_CONFLICT/);
  await f.send('startup', 'An independent input with a reserved-looking ID');
  await until(f.read, state => state.events.find(event => event.id === 'startup')?.status === 'completed');
  assert.equal((await f.read()).events.length, 2);
});

test('Assistant adopts persisted detections, archived work and recognition without replaying them', async t => {
  const old = await fixture(t, async (req, round) => {
    if (data(req).event.id !== 'original-watch') return simple(req, round);
    if (round === 1) return { calls: [{ name: 'friends_watch_time', input: { eventId: 'original-watch', at: '2099-03-04T05:00:00Z' } }, decide('watching')] };
    return { text: 'Monitoring the original event.' };
  }, { keep: true });
  await old.configure({ recognition: { context: 'First confirmed routine' } });
  await until(old.read, s => s.events[0]?.status === 'completed');
  await old.send('original-watch', 'Follow the original schedule');
  await until(old.read, s => s.events.some(e => e.id === 'original-watch' && e.status === 'watching'));
  await old.command({ action: 'archive', eventId: 'original-watch' });
  const previous = await old.read(); await old.close();
  const merged = await fixture(t, simple, { root: old.root });
  const prefs = await merged.command({ action: 'preferences' });
  assert.deepEqual(prefs.recognition, { context: 'First confirmed routine' });
  const { configuration } = JSON.parse(await readFile(join(old.root, 'friends/events.json'), 'utf8'));
  await merged.command({ action: 'configure', parent: { ...configuration.parent, sessionId: 'personal-assistant',
    model: 'current-assistant-model', inputMessages: [{ messageId: 'bootstrap', message: { role: 'user', content: 'Bootstrap' } }] },
    profile: configuration.profile, assistant: { name: 'Existing Assistant', proactive: prefs } });
  const after = await merged.read(), binding = await merged.command({ action: 'binding' });
  assert.deepEqual(after.events, previous.events); assert.deepEqual(after.detections, previous.detections);
  assert.equal(binding.parent.model, 'current-assistant-model');
  assert.equal(binding.profile.name, 'Existing Assistant'); assert.equal(merged.requests.length, 0);
});

test('Assistant-owned event pins the selected notification account even after its preference changes', async t => {
  const sources = new Map(['personal', 'work'].map(id => ['webhook:' + id, {
    sourceRef: 'webhook:' + id, connectionId: id, senderId: 'same-user', conversationId: 'same-chat', available: true }]));
  const fixtureHost = { botMessaging: { catalog: async () => [], context: async (_root, ref) => ({ discovery: 'mcp_search', available: true,
    source: sources.get(ref), targets: [...sources.values()] }), call: async () => { throw Error('Unexpected platform call'); } } };
  const f = await fixture(t, async (req, round) => {
    if (data(req).event.id === 'pinned' && round === 1 && data(req).signals[0].kind === 'input') return { calls: [
      { name: 'friends_watch_time', input: { eventId: 'pinned', at: '2099-03-04T05:00:00Z' } }, decide('watching')] };
    return simple(req, round);
  }, { host: fixtureHost });
  const configure = ref => f.command({ action: 'configure', assistant: { name: 'Assistant',
    proactive: { recognition: {}, beforeExecution: 'ask', report: 'always', notificationSourceRef: ref } },
    profile: { name: 'Assistant', recognition: {}, language: 'en', timeZone: 'UTC', confirmedAt: now() },
    parent: { protocol: 'bush.session_turn_request.v1', requestId: 'setup', sessionId: 'personal-assistant', turnId: 'setup',
      model: 'fixture', tools: [], prefixMessages: [], inputMessages: [{ messageId: 'private-chat', message: { role: 'user', content: 'Secret chat context' } }], metadata: {}, permissionMode: 'task_free' } });
  await configure('webhook:work'); assert.equal(f.requests.length, 0, 'preparing the Assistant does not invent a user event');
  await f.send('pinned'); await until(f.read, s => s.events.find(e => e.id === 'pinned')?.status === 'watching');
  await configure('webhook:personal'); await f.command({ action: 'resume', eventId: 'pinned' });
  const done = await until(f.read, s => s.events.find(e => e.id === 'pinned')?.status === 'completed');
  assert.ok(done.events[0].deliveryRoute.recipientKey);
  for (const request of f.requests) {
    assert.deepEqual(request.metadata.botSourceRefs, ['webhook:work']);
    assert.ok(!JSON.stringify(request.messages).includes('Secret chat context'));
  }
});

const assistantConfiguration = () => ({ action: 'configure', assistant: { name: 'Assistant' },
    profile: { name: 'Assistant', language: 'en', timeZone: 'UTC', confirmedAt: now(), recognition: {} },
    parent: { protocol: 'bush.session_turn_request.v1', sessionId: PERSONAL_ASSISTANT_SESSION, requestId: 'config', turnId: 'config',
      model: 'fixture', tools: [], metadata: {}, permissionMode: 'task_free', prefixMessages: [], inputMessages: [{ messageId: 'config', message: { role: 'user', content: 'configure' } }] } });

function eventTool(registry, args) {
  const tool = registry.resolve('assistant_event');
  return tool.execute({ sessionId: PERSONAL_ASSISTANT_SESSION, toolCall: { id: crypto.randomUUID() },
    turn: { request: { turnId: 'user-turn', metadata: { assistantUserRequest: true } } }, input: tool.decodeInput(args) });
}

test('local predicate sees only Assistant-owned outcome metadata and wakes without a clock', async t => {
  const log = new InMemoryRuntimeEventLog(), sessions = new SessionStore();
  for (const [id, parent] of [['other', undefined], ['local-child', PERSONAL_ASSISTANT_SESSION], ['event-child', FRIENDS_SESSION]]) {
    sessions.ensureSession(id, parent ? { parentSessionId: parent } : {});
  }
  const f = await fixture(t, simple, { host: { eventLog: log, sessionStore: sessions } });
  await f.command(assistantConfiguration());
  const trigger = { source: 'runtime', code: "return Number(observation.kind === 'turn_terminal' && observation.status === 'failed' && Object.keys(observation).sort().join(',') === 'kind,nowMs,status')" };
  const { eventId } = await eventTool(f.registry, { action: 'subscribe', topic: 'Failure', text: 'Report a failed turn.', trigger, destination: 'here', reminderText: 'Failed.' });
  const emit = (id, status = 'failed') => log.append({ sessionId: id, turnId: crypto.randomUUID(), requestId: crypto.randomUUID() },
    { kind: 'turn_terminal', payload: { status, reason: 'private details', details: { private: true } } });
  emit('other'); emit(FRIENDS_SESSION); emit('event-child'); emit('local-child', 'completed');
  await sleep(60);
  assert.equal((await f.read()).events[0].result, undefined);
  emit('local-child');
  const state = await until(f.read, s => s.events[0].result?.text === 'Failed.');
  assert.deepEqual(state.detections, []); assert.equal(state.events[0].status, 'watching');
  assert.equal(f.requests.length, 0);
  await eventTool(f.registry, { action: 'pause', eventId }); emit('local-child');
  assert.equal((await f.read()).events[0].status, 'paused');
  await eventTool(f.registry, { action: 'delete', eventId }); emit('local-child');
  assert.equal((await f.read()).events.length, 0);
});

test('edited reminders keep the same pending clock and exact chat wording across restart and time-only edits', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-edited-event-'));
  let time = Date.parse('2026-11-01T00:00Z'), timer;
  const clock = { schedule(wake, delay) { timer = { wake, at: time + delay }; }, cancel(wake) { if (timer?.wake === wake) timer = undefined; } };
  const notices = [], calls = [];
  const configure = assistantConfiguration();
  configure.assistant.proactive = { notificationSourceRef: 'saved-external', recognition: {}, beforeExecution: 'ask', report: 'always' };
  const open = () => {
    const tools = new ToolRegistry();
    const events = new AssistantEvents(join(root, 'events.json'), { tools, clock, now: () => time, publish: notice => notices.push(notice),
      run: async request => {
        calls.push(request); await tools.resolve('friends_decide').execute({ turnId: request.turnId, sessionId: FRIENDS_SESSION,
          input: { ...decide('watching').input, notifyUser: true } });
        return { terminal: { kind: 'turn_terminal', payload: { status: 'completed' } }, text: 'fresh result' };
      } });
    return { events, manage: args => eventTool(tools, args) };
  };
  let current = open();
  t.after(async () => { await current.events.close(); await rm(root, { recursive: true, force: true }); });
  await current.events.command(configure);
  const original = { unit: 'week', interval: 1, startLocal: '2026-11-02T09:00', timeZone: 'America/New_York' };
  const first = await current.manage({ action: 'subscribe', topic: 'Reports', text: 'Original New York rule', recurrence: original, reminderText: 'old words', destination: 'here' });
  const eventId = first.eventId;
  const revised = { unit: 'minute', interval: 5, startLocal: '2026-11-01T08:05', timeZone: 'Asia/Shanghai' };
  const edit = await current.manage({ action: 'continue', eventId, text: 'Report on the local five-minute schedule.', recurrence: revised });
  assert.equal((await current.manage({ action: 'read', eventId })).reminderText, 'old words');
  const before = (await current.events.snapshot()).detections;
  await current.manage({ action: 'continue', eventId, text: 'Report using the revised words.', reminderText: '  新原文。  ' });
  assert.deepEqual((await current.events.snapshot()).detections, before);
  await current.events.close(); current = open(); await current.events.command(configure);
  const fireAt = async (at, expectedNotices) => {
    await until(async () => timer, value => value?.at === Date.parse(at));
    time = Date.parse(at); timer.wake();
    await until(async () => notices, value => value.length === expectedNotices);
  };
  await fireAt(edit.nextAt, 1);
  assert.equal(notices[0].text, '  新原文。  '); assert.deepEqual(calls, []);
  const record = await current.manage({ action: 'read', eventId });
  assert.equal(record.inputs.length, 3); assert.equal(record.logicalKey, 'Reports'); assert.equal(record.deliveryRoute, undefined);
  await current.manage({ action: 'continue', eventId, text: 'Generate the current report.', reminderText: null });
  await fireAt(record.nextAt, 2);
  const request = calls[0], evidence = data(request);
  assert.equal(request.metadata.botDeliveryLocalOnly, true);
  assert.ok(!request.messages.some(m => m.content.includes('If no bridge is bound')));
  assert.equal(evidence.destination, 'conversation');
  assert.deepEqual(evidence.event.inputs.map(input => input.text), ['Generate the current report.']);
  assert.ok(!JSON.stringify(evidence).includes('Original New York rule')); assert.equal(notices[1].text, 'fresh result');
});

test('a content edit while a one-time reminder is firing publishes only the latest words', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-inflight-reminder-')), tools = new ToolRegistry(), notices = [];
  const service = new AssistantEvents(join(root, 'events.json'), { tools, publish: notice => notices.push(notice),
    run: async (_request, signal) => {
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      return { terminal: { kind: 'turn_terminal', payload: { status: 'completed' } }, text: 'Obsolete result' };
    } });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  await service.command(assistantConfiguration());
  const { eventId } = await eventTool(tools, { action: 'create', text: 'Generate a local reminder',
    destination: 'here', at: new Date(Date.now() + 200).toISOString() });
  await until(() => service.snapshot(), s => s.active?.eventId === eventId);
  await eventTool(tools, { action: 'continue', eventId, text: 'Use these words', reminderText: 'Latest words' });
  await until(async () => notices, n => n.length > 0);
  assert.deepEqual(notices.map(n => n.text), ['Latest words']);
  assert.equal((await service.snapshot()).events[0].status, 'completed');
});

test('interval predicates keep their edge over restart and isolate a failed program', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-predicate-edges-'));
  let time = 0, timer;
  const notices = [], clock = { schedule(wake, delay) { timer = { wake, at: time + delay }; }, cancel(wake) { if (timer?.wake === wake) timer = undefined; } };
  const open = () => {
    const registry = new ToolRegistry();
    const events = new AssistantEvents(join(root, 'events.json'), { tools: registry, clock, now: () => time,
      run: () => assert.fail('A local literal reminder must not start inference'), publish: notice => notices.push(notice) });
    return { events, manage: args => eventTool(registry, args) };
  };
  let current = open();
  t.after(async () => { await current.events.close(); await rm(root, { recursive: true, force: true }); });
  await current.events.command(assistantConfiguration());
  const rule = { action: 'subscribe', topic: 'Edge', text: 'Report on entry.', reminderText: 'Entered',
    trigger: { source: 'interval', everySeconds: 1, code: 'return Number(Math.floor(observation.nowMs / 1000) % 4 < 3);' } };
  const { eventId } = await current.manage(rule);
  const bad = await current.manage({ ...rule, topic: 'Invalid result', trigger: { ...rule.trigger, code: 'return true;' } });
  const advance = async (nextTime, expectedNotices) => {
    await until(async () => timer, t => t?.at === nextTime);
    time = nextTime; timer.wake();
    await until(async () => timer, t => t?.at === time + 1000);
    assert.equal(notices.length, expectedNotices);
  };
  await advance(1000, 1);
  assert.equal((await current.manage({ action: 'read', eventId: bad.eventId })).error, 'EVENT_TRIGGER_EXPECTED_ZERO_OR_ONE');
  await current.events.close(); current = open(); await current.events.command(assistantConfiguration());
  await advance(2000, 1); await advance(3000, 1); await advance(4000, 2);
  await current.manage({ action: 'pause', eventId });
  assert.deepEqual((await current.events.snapshot()).detections, []);
  await current.manage({ action: 'delete', eventId }); await current.events.close();
  current = open(); await current.events.command(assistantConfiguration());
  assert.deepEqual((await current.events.snapshot()).detections, []);
});

test('event agents can register local code for newly created events without a date', async t => {
  const trigger = { source: 'runtime', code: "return Number(observation.kind === 'tool_failed');" };
  const f = await fixture(t, async (request, round) => {
    if (round === 1) return { calls: [{ name: 'friends_create_event', input: { title: 'Failures', logicalKey: 'failures', intent: 'Observe failures', subscription: true } }] };
    if (round === 2) {
      const child = (await f.read()).events.find(event => event.logicalKey === 'failures');
      return { calls: [{ name: 'friends_watch_time', input: { eventId: child.id, trigger, reminderText: 'Failed tool' } }, decide('completed')] };
    }
    return { text: 'Registered.' };
  });
  await f.command(assistantConfiguration()); await f.send('register-code');
  const state = await until(f.read, s => s.events.some(e => e.id === 'register-code' && e.status === 'completed'));
  const child = state.events.find(e => e.logicalKey === 'failures');
  assert.deepEqual(child.trigger, trigger); assert.equal(child.status, 'watching'); assert.deepEqual(state.detections, []);
});

test('verified collector baseline, changed keys, evidence and cancellation survive polling and restart without idle inference', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-collector-'));
  let now = 0, timer, version = 'v1', value = '09:00', game = 'g1', pending, reading, unavailable = false;
  const calls = [], notices = [];
  const clock = { schedule(wake, delay) { timer = { wake, at: now + delay }; }, cancel(wake) { if (timer?.wake === wake) timer = undefined; } };
  const collector = { resolve: async () => ({ version, toolCallId: 'sample', sample: { id: 'g1', start: '09:00' }, read: async signal => {
    reading = signal;
    if (unavailable) throw new CollectorReadError('Source offline');
    if (pending) await pending.promise;
    return { id: game, start: value, privateField: 'never forward raw samples' };
  } }) };
  const open = () => {
    const tools = new ToolRegistry();
    const service = new AssistantEvents(join(root, 'events.json'), { tools, clock, collector, now: () => now, publish: n => notices.push(n),
      run: async request => {
        calls.push(data(request));
        await tools.resolve('friends_decide').execute({ turnId: request.turnId, sessionId: FRIENDS_SESSION,
          input: { ...decide('watching').input, notifyUser: true } });
        return { terminal: { kind: 'turn_terminal', payload: { status: 'completed' } }, text: data(request).signals[0].observation.evidence };
      } });
    return { service, manage: args => eventTool(tools, args) };
  };
  let current = open();
  t.after(async () => { pending?.resolve(); await current.service.close(); await rm(root, { recursive: true, force: true }); });
  await current.service.command(assistantConfiguration());
  const rule = { source: 'collector', taskId: 'sample-task', tool: 'verified_read', everySeconds: 1,
    code: `const {id, start} = observation.value, key = id + ":" + start;
      if (!observation.previousKey?.startsWith(id + ":")) return remember(key);
      return match(key, "Start " + start);` };
  const registration = { action: 'subscribe', topic: 'Times', text: 'Report a time change', trigger: rule };
  await assert.rejects(current.manage({ ...registration, action: 'create' }), /ongoing collector/);
  await assert.rejects(current.manage({ ...registration, trigger: { ...rule, once: true } }), /stop after one match/);
  await assert.rejects(current.manage({ ...registration, trigger: { ...rule, code: 'return true;' } }), /ZERO_OR_ONE/);
  const { eventId } = await current.manage(registration);
  const advance = async (at, expectedCalls) => {
    await until(async () => timer, t => t?.at === at);
    now = at; timer.wake();
    await until(async () => timer, t => t?.at === at + 1000);
    assert.equal(calls.length, expectedCalls);
  };
  await advance(1000, 0); value = '11:00'; await advance(2000, 1);
  assert.equal(notices[0].text, 'Start 11:00'); assert.ok(!JSON.stringify(calls[0]).includes('never forward raw samples'));
  await current.service.close(); current = open(); await current.service.command(assistantConfiguration());
  await advance(3000, 1); value = '13:00'; await advance(4000, 2);
  assert.equal(notices[1].text, 'Start 13:00');
  unavailable = true; now = 5000; timer.wake();
  await until(async () => timer, t => t?.at === 35_000);
  assert.equal((await current.service.snapshot()).events[0].collectorFailures, 1);
  unavailable = false; game = 'g2'; value = '08:00'; await advance(35_000, 2);
  assert.equal((await current.service.snapshot()).events[0].triggerKey, 'g2:08:00');
  assert.equal((await current.service.snapshot()).events[0].error, undefined);
  pending = Promise.withResolvers(); reading = undefined; now = 36_000; timer.wake();
  await until(async () => reading, Boolean);
  await current.manage({ action: 'pause', eventId }); assert.ok(reading.aborted);
  pending.resolve(); pending = undefined; await current.manage({ action: 'resume', eventId });
  version = 'new tool revision';
  await until(async () => timer, t => t?.at === 37_000);
  now = 37_000; timer.wake();
  const after = await until(() => current.service.snapshot(), s => s.events[0].status === 'failed');
  assert.deepEqual(after.detections, []); assert.equal(after.events[0].error, 'EVENT_COLLECTOR_SOURCE_CHANGED');
  assert.equal(calls.length, 2);
  const once = await current.manage({ action: 'create', text: 'Report once.', reminderText: 'Once.',
    trigger: { ...rule, once: true, initial: 'notify', code: 'return match(observation.value.id, "Observed");' } });
  await until(async () => timer, t => t?.at === 38_000);
  now = 38_000; timer.wake();
  await until(() => current.service.snapshot(), s => s.events.find(e => e.id === once.eventId)?.status === 'completed');
  assert.equal(notices.at(-1).text, 'Once.');
  assert.deepEqual((await current.service.snapshot()).detections, []);
});

test('deleting a routed reminder cancels its durable wake and outbox across a next-day restart', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-events-delete-')), path = join(root, 'events.json');
  const start = Date.parse('2026-11-07T10:00:00Z'), tomorrow = start + 86400000;
  let clock = start;
  const notices = [], runs = [];
  const open = () => {
    const tools = new ToolRegistry();
    const events = new AssistantEvents(path, { tools, now: () => clock, publish: notice => notices.push(notice),
      botContext: async sourceRef => ({ source: { sourceRef, connectionId: 'bot', senderId: sourceRef.split('/')[0], conversationId: 'room' } }),
      run: async request => {
        runs.push(request.metadata.friendsEventId);
        await tools.resolve('friends_decide').execute({ turnId: request.turnId, sessionId: FRIENDS_SESSION,
          input: { ...decide('completed').input, notifyUser: true } });
        return { terminal: { kind: 'turn_terminal', payload: { status: 'completed' } }, text: 'Due' };
      } });
    const call = (action, source, args = {}, user = true) => {
      const tool = tools.resolve('assistant_event');
      return tool.execute({ sessionId: PERSONAL_ASSISTANT_SESSION, toolCall: { id: crypto.randomUUID() },
        turn: { request: { turnId: 'test', metadata: { assistantUserRequest: user, botSourceRef: source } } },
        input: tool.decodeInput({ action, ...args }) });
    };
    return { events, call };
  };
  let instance = open();
  t.after(async () => { await instance.events.close(); await rm(root, { recursive: true, force: true }); });
  await instance.events.command(assistantConfiguration());
  const reminder = { text: 'Check tomorrow', at: new Date(tomorrow).toISOString() };
  const subscription = { ...reminder, topic: 'Fixture releases' };
  const first = await instance.call('subscribe', 'a/1', subscription);
  const separate = await instance.call('subscribe', 'b/1', subscription);
  assert.notEqual(first.eventId, separate.eventId, 'separate accounts can follow the same topic independently');
  await instance.call('delete', 'b/1', { eventId: separate.eventId });
  const other = await instance.call('create', 'b/1', reminder);
  const repeated = await instance.call('subscribe', 'a/2', subscription);
  assert.equal(repeated.eventId, first.eventId, 'the same recipient reconnects with a new receipt');
  assert.equal(repeated.status, 'exists');
  await assert.rejects(instance.call('delete', 'b/1', { eventId: first.eventId }), /NOT_FOUND/);
  await assert.rejects(instance.call('delete', 'a/1', { eventId: first.eventId }, false), /USER_REQUEST_REQUIRED/);
  await instance.events.command({ action: 'archive', eventId: first.eventId });
  assert.deepEqual(await instance.call('list', 'a/2'), []);
  assert.deepEqual((await instance.call('list', 'a/2', { include_archived: true })).map(e => [e.id, e.archived]), [[first.eventId, true]]);
  await instance.events.disconnect();
  await instance.events.store.change(state => { state.notifications = [{ eventId: first.eventId, turnId: 'old', createdAt: now(), text: 'Undelivered' }]; });
  assert.equal((await instance.call('delete', 'a/2', { eventId: first.eventId })).status, 'deleted');
  assert.deepEqual((await instance.events.snapshot()).events.map(event => event.id), [other.eventId]);
  await instance.events.close(); clock = tomorrow + 1000;
  instance = open(); await instance.events.command(assistantConfiguration());
  await until(() => instance.events.snapshot(), state => state.events[0]?.status === 'completed');
  assert.deepEqual(runs, [other.eventId]); assert.deepEqual(notices.map(notice => notice.eventId), [other.eventId]);
  assert.deepEqual((await instance.events.snapshot()).detections, []);
});

test('deleting an active event interrupts its pending inputs and ignores a late completion', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const f = await fixture(t, async (request, round, signal) => {
    if (data(request).event.id.startsWith('webhook-input-')) { entered.resolve(signal); await release.promise; }
    return simple(request, round);
  });
  await f.configure(); await until(f.read, state => state.events[0]?.status === 'completed');
  const receiptId = crypto.randomUUID(), eventId = 'webhook-input-' + receiptId;
  await f.command({ action: 'receive_webhook', receiptId, createdAt: now(), text: 'Check an item' });
  try {
    const signal = await entered.promise;
    await f.send('more-input', 'One more observation', eventId);
    await f.command({ action: 'delete', eventId });
    assert.ok(signal.aborted);
    assert.deepEqual(await f.command({ action: 'read_webhook', receiptId }), { status: 'interrupted', reply: '', errorCode: 'friends_deleted' });
  } finally { release.resolve(); }
  await f.send('still-works');
  await until(f.read, state => state.events.find(e => e.id === 'still-works')?.status === 'completed');
  const saved = JSON.parse(await readFile(join(f.root, 'friends/events.json'), 'utf8'));
  assert.ok(![...saved.events, ...saved.signals, ...saved.detections, ...(saved.notifications ?? [])].some(item => item.id === eventId || item.eventId === eventId));
});

test('deleting the owner stops a detached child even after its event turn has completed', async t => {
  const release = Promise.withResolvers();
  let childSignal;
  const f = await fixture(t, async (request, round, signal) => {
    if (request.metadata.agentRole === 'child') {
      childSignal = signal;
      await release.promise;
      return { text: 'Late child result' };
    }
    if (data(request).event.id === 'child-owner' && round === 1) return { calls: [{ name: 'subagent',
      input: { prompt: 'Inspect fixture data', run_in_background: true } }] };
    return round === 1 || (data(request).event.id === 'child-owner' && round === 2)
      ? { calls: [decide('completed')] } : { text: 'Event turn finished.' };
  });
  try {
    await f.configure(); await until(f.read, s => s.events[0]?.status === 'completed');
    await f.send('child-owner'); await until(f.read, s => childSignal && s.events.find(e => e.id === 'child-owner')?.status === 'completed');
    assert.equal(childSignal.aborted, false);
    await f.command({ action: 'delete', eventId: 'child-owner' });
    assert.equal(childSignal.aborted, true);
  } finally { release.resolve(); }
});

test('one subscription renews across deliveries and restart, stays quiet without news, and stops on deletion', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-subscription-'));
  const day = 86400000, start = Date.parse('2026-11-07T10:00:00Z');
  let time = start, scheduled, observation = 'edition 1';
  const deliveries = [], activations = [];
  const clock = {
    schedule(wake, delay) { scheduled = { wake, at: time + delay }; },
    cancel(wake) { if (scheduled?.wake === wake) scheduled = undefined; },
  };
  const intent = 'Keep following new editions. Deliver each new edition and check again at the next daily release.';
  const open = () => {
    const tools = new ToolRegistry();
    const service = new AssistantEvents(join(root, 'events.json'), { tools, clock, now: () => time,
      publish: notice => deliveries.push(notice),
      run: async request => {
        const { event } = data(request);
        assert.equal(event.intent, intent); assert.equal(event.subscription, true);
        activations.push(event.id);
        const context = { turnId: request.turnId, sessionId: FRIENDS_SESSION };
        await assert.rejects(tools.resolve('friends_decide').execute({ ...context, input: decide('completed').input }), /next check/);
        await tools.resolve('friends_watch_time').execute({ ...context, input: { eventId: event.id, at: new Date(time + day).toISOString() } });
        await tools.resolve('friends_decide').execute({ ...context, input: { disposition: 'watching', basis: observation,
          habitRefs: [], notifyUser: event.decision?.basis !== observation } });
        return { terminal: { kind: 'turn_terminal', payload: { status: 'completed' } }, text: observation };
      } });
    const manage = args => {
      const tool = tools.resolve('assistant_event');
      return tool.execute({ sessionId: PERSONAL_ASSISTANT_SESSION, toolCall: { id: crypto.randomUUID() },
        turn: { request: { turnId: 'chat', metadata: { assistantUserRequest: true } } }, input: tool.decodeInput(args) });
    };
    return { service, manage };
  };
  let instance = open();
  t.after(async () => { await instance.service.close(); await rm(root, { recursive: true, force: true }); });
  await instance.service.command(assistantConfiguration());
  const command = { action: 'subscribe', topic: 'New editions', text: intent, at: new Date(time + day).toISOString() };
  const [a, b] = await Promise.all([instance.manage(command), instance.manage(command)]);
  const eventId = a.eventId; assert.equal(b.eventId, eventId);
  assert.deepEqual([a.status, b.status].sort(), ['accepted', 'exists']);
  assert.deepEqual((await instance.manage({ action: 'list' })).map(e => [e.id, e.subscription]), [[eventId, true]]);
  const nextRelease = async () => {
    const due = time + day;
    await until(async () => scheduled, job => job?.at === due);
    time = due; scheduled.wake();
    await until(() => instance.service.snapshot(), state => state.events.length === 1 && state.events[0].status === 'watching' &&
      state.detections.length === 1 && state.detections[0].eventId === eventId && Date.parse(state.detections[0].at) === time + day);
    await until(async () => scheduled, job => job?.at === time + day);
  };
  await nextRelease(); assert.deepEqual(deliveries.map(d => d.text), ['edition 1']);
  await instance.service.close(); instance = open(); await instance.service.command(assistantConfiguration());
  await nextRelease(); assert.deepEqual(deliveries.map(d => d.text), ['edition 1']);
  observation = 'edition 2'; await nextRelease();
  assert.deepEqual(deliveries.map(d => [d.eventId, d.text]), [[eventId, 'edition 1'], [eventId, 'edition 2']]);
  await instance.manage({ action: 'delete', eventId });
  await instance.service.close(); time += 2 * day; instance = open(); await instance.service.command(assistantConfiguration());
  const state = await instance.service.snapshot();
  assert.deepEqual(state.events, []); assert.deepEqual(state.detections, []);
  assert.deepEqual(activations, [eventId, eventId, eventId]); assert.equal(deliveries.length, 2);
});

test('one fixed subscription renews locally, coalesces downtime, reschedules in place and cancels durably', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-fixed-event-'));
  let time = Date.parse('2026-11-07T00:00Z'), timer;
  const runs = [];
  const clock = {
    schedule(wake, delay) { timer = { wake, at: time + delay }; },
    cancel(wake) { if (timer?.wake === wake) timer = undefined; },
  };
  const recurrence = { unit: 'week', interval: 1, startLocal: '2026-11-09T09:00', timeZone: 'Asia/Shanghai' };
  const subscribe = { action: 'subscribe', topic: 'Weekly report', text: 'Send my weekly report.', recurrence };
  const open = () => {
    const tools = new ToolRegistry();
    const service = new AssistantEvents(join(root, 'events.json'), { tools, clock, now: () => time,
      run: async request => {
        const { event, detections, signals } = data(request);
        runs.push([event.id, signals.map(signal => signal.kind)]);
        assert.equal(detections.length, 1, 'the host persisted the next occurrence before invoking the model');
        const context = { turnId: request.turnId, sessionId: FRIENDS_SESSION };
        await assert.rejects(tools.resolve('friends_watch_time').execute({ ...context, input: { eventId: event.id, at: '2099-01-01T00:00:00Z' } }), /recurrence/);
        await tools.resolve('friends_decide').execute({ ...context, input: decide('completed').input });
        return { terminal: { kind: 'turn_terminal', payload: { status: 'completed' } }, text: 'This occurrence finished.' };
      } });
    const manage = (args, callId = crypto.randomUUID()) => {
      const tool = tools.resolve('assistant_event');
      return tool.execute({ sessionId: PERSONAL_ASSISTANT_SESSION, toolCall: { id: callId },
        turn: { request: { turnId: 'chat', metadata: { assistantUserRequest: true } } }, input: tool.decodeInput(args) });
    };
    return { service, manage };
  };
  let instance = open();
  t.after(async () => { await instance.service.close(); await rm(root, { recursive: true, force: true }); });
  await instance.service.command(assistantConfiguration());
  const callId = crypto.randomUUID();
  const first = await instance.manage(subscribe, callId);
  const eventId = first.eventId;
  assert.equal(first.nextAt, '2026-11-09T01:00:00.000Z');
  assert.deepEqual(await instance.manage(subscribe, callId), first);
  assert.equal((await instance.manage(subscribe)).status, 'exists');
  assert.equal(runs.length, 0);
  const waitForTimer = at => until(async () => timer, value => value?.at === Date.parse(at));
  const fire = async (at, next) => {
    await waitForTimer(at);
    time = Date.parse(at); timer.wake();
    await waitForTimer(next);
  };
  await fire('2026-11-09T01:00Z', '2026-11-16T01:00Z');
  await fire('2026-11-16T01:00Z', '2026-11-23T01:00Z');
  await instance.service.close();
  time = Date.parse('2026-12-09T15:00Z');
  instance = open(); await instance.service.command(assistantConfiguration());
  await waitForTimer('2026-12-14T01:00Z');
  assert.deepEqual(runs, Array.from({ length: 3 }, () => [eventId, ['clock']]));
  await instance.manage({ action: 'pause', eventId });
  assert.equal((await instance.service.snapshot()).detections.length, 0);
  time = Date.parse('2026-12-22T12:00Z');
  const revised = { ...recurrence, startLocal: '2026-11-10T11:00' };
  const edit = await instance.manage({ action: 'continue', eventId, text: 'Change to Tuesdays at 11:00.', recurrence: revised });
  assert.equal(edit.nextAt, null, 'editing a paused subscription leaves it paused');
  await instance.manage({ action: 'resume', eventId });
  await waitForTimer('2026-12-29T03:00Z');
  assert.equal(runs.length, 3, 'resuming a fixed clock does not run a delivery early');
  assert.deepEqual((await instance.manage({ action: 'read', eventId })).recurrence, revised);
  await instance.manage({ action: 'delete', eventId }); await instance.service.close();
  time = Date.parse('2027-01-10T00:00Z'); instance = open();
  await instance.service.command(assistantConfiguration());
  assert.deepEqual((await instance.service.snapshot()).detections, []);
  assert.equal(runs.length, 3);
});
