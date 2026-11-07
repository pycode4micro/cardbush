import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { InMemoryRuntimeHost, ToolRegistry, SessionStore } from '../dist/index.js';
import { FRIENDS_COMMAND, FRIENDS_SESSION } from '@cardbush/bush-protocol';

const now = () => new Date().toISOString();
const modelEvent = (request, sequence, kind, extra = {}) => ({ protocol: 'bush.model_event.v1', requestId: request.requestId, sequence, createdAt: now(), kind, ...extra });
const data = request => JSON.parse(request.messages.find(message => message.name === 'friends_event_data').content);
const decide = disposition => ({ name: 'friends_decide', input: { disposition, basis: 'Observed event evidence.', habitRefs: [] } });
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
  const question = pending.solutions[0];
  const payload = { selectionId: question.selectionId, sessionId: FRIENDS_SESSION, turnId: question.turnId,
    kind: 'answers', answers: [{ questionId: 'format', kind: 'option', optionIndex: 0 }] };
  await assert.rejects(() => f.host.sendCommand({ kind: 'runtime.answer_solution_selection', payload: { ...payload, sessionId: 'personal-assistant' } }), /different session/);
  await f.host.sendCommand({ kind: 'runtime.answer_solution_selection', payload }); waiting.resolve();
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
