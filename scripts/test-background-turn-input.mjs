import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { InMemoryRuntimeHost } from '../packages/bush-runtime/dist/index.js';
import { loadChatTranscript } from './helpers/load-chat-transcript.mjs';

const api = await loadChatTranscript({
  source: [
    ['src/backend/runtimeChat.ts', 'streamRuntimeTurnEvents'],
    ['src/features/chatMessages/transcript/messageProjection.ts', 'mergeMessages, mergeFinalStreamMessages, normalizeChatMessagesForDisplay'],
    ['src/features/chatMessages/transcript/liveMessageUpdates.ts', 'ensureBackgroundTurnAssistant, appendAssistantDelta'],
  ].map(([file, names]) => `export { ${names} } from ${JSON.stringify(path.resolve(file))};`).join('\n'),
  globals: { console, AbortController, DOMException, structuredClone, setTimeout, clearTimeout,
    process: { env: { NODE_ENV: 'test' } }, window: { setTimeout, clearTimeout } },
});
const now = '2026-11-04T07:00:00.000Z';
const plain = value => JSON.parse(JSON.stringify(value));
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('detaching during input hydration leaves acceptance unacknowledged for replay', async () => {
  const controller = new AbortController(), cursors = [], starts = [];
  await assert.rejects(api.streamRuntimeTurnEvents({ sessionId: 's', turnId: 't', signal: controller.signal,
    onEventCursor: cursor => cursors.push(cursor), onStart: start => starts.push(start),
  }, { dispose() {}, interactions: {}, client: {
    async *events() { yield { kind: 'turn_accepted', eventId: 'accepted', sequence: 1, sessionId: 's', turnId: 't', createdAt: now,
      payload: { status: 'accepted', input: { turnSequence: 1, messages: [{ messageId: 'u', messageIndex: 0 }] } } }; },
    async getUserMessage() { controller.abort(); throw controller.signal.reason; },
  } }), { name: 'AbortError' });
  assert.deepEqual(cursors, []);
  assert.deepEqual(starts, []);
});

test('an externally submitted turn exposes its authored inputs before any model reply, including replay and final reconciliation', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cardbush-live-input-'));
  t.after(async () => {
    assert.ok(directory.startsWith(path.join(tmpdir(), 'cardbush-live-input-')));
    await rm(directory, { recursive: true, force: true });
  });
  const file = path.join(directory, 'sample.pdf');
  await writeFile(file, '%PDF-1.4\nfixture for attachment retention\n%%EOF');
  const providerGate = gate(), visible = gate();
  const request = {
    protocol: 'bush.session_turn_request.v1', requestId: 'request', sessionId: 'webhook-session', turnId: 'webhook-turn',
    model: 'fixture', tools: [], prefixMessages: [{ role: 'system', content: 'private system context' }], metadata: {},
    inputMessages: [
      { messageId: 'clock', createdAt: now, message: { role: 'user', visibility: 'internal', content: 'private runtime clock' } },
      { messageId: 'webhook-user', createdAt: now, message: { role: 'user', content: '请看这个文件' }, metadata: {
        attachments: [{ id: 'attachment', name: 'sample.pdf', type: 'document', path: file }],
      } },
      { messageId: 'webhook-followup', createdAt: now, message: { role: 'user', content: '并概括内容' } },
    ],
  };
  const host = new InMemoryRuntimeHost({ dataRoot: directory, provider: { async *stream(model) {
    await providerGate.promise;
    yield { protocol: 'bush.model_event.v1', requestId: model.requestId, sequence: 0, createdAt: now, kind: 'text_delta', delta: '收到文件' };
    yield { protocol: 'bush.model_event.v1', requestId: model.requestId, sequence: 1, createdAt: now, kind: 'response_completed', finishReason: 'stop' };
  } } });
  const reads = [], facts = [];
  const client = {
    async *events(options) { for await (const event of host.openEventStream(options)) { facts.push(event); yield event; } },
    getUserMessage(sessionId, turnId, messageId) {
      reads.push(messageId);
      return host.sendCommand({ kind: 'runtime.get_user_message', payload: { sessionId, turnId, messageId } });
    },
    getSession(sessionId) { return host.sendCommand({ kind: 'runtime.get_session', payload: { sessionId } }); },
  };
  const runtime = { client, interactions: {}, dispose() {} };
  const sessionId = request.sessionId, turnId = request.turnId, assistantId = 'background-placeholder';
  let state = { [sessionId]: [] }, final = false, started;
  const observe = signal => api.streamRuntimeTurnEvents({ sessionId, turnId, signal,
    onStart(start) {
      started = start;
      if (start.userMessages?.length) state = api.mergeMessages(state, sessionId, start.userMessages);
      state = api.ensureBackgroundTurnAssistant(state, sessionId, assistantId, turnId, { createdAt: start.createdAt, startedAt: start.createdAt });
      visible.resolve();
    },
    onDelta(delta, route) { state = api.appendAssistantDelta(state, sessionId, assistantId, delta, route); },
    onMessages(messages, finalSnapshot) {
      final = finalSnapshot;
      state = api.mergeFinalStreamMessages(state, sessionId, messages, { turnId, temporaryMessageIds: [assistantId], toolSourceMessageId: assistantId });
    },
  }, runtime);
  const firstController = new AbortController();
  // Subscribe before admission to catch publication/checkpoint ordering regressions.
  const first = observe(firstController.signal);
  let completed = false;
  const run = host.runSessionTurn(request).then(result => { completed = true; return result; });
  let replay;
  try {
    await visible.promise;
    assert.equal(completed, false);
    assert.equal(final, false);
    assert.equal(facts.some(event => event.kind === 'assistant_segment_delta'), false);
    assert.deepEqual(reads, ['webhook-user', 'webhook-followup'], 'internal context must not be requested');
    assert.equal(started.userMessageId, 'webhook-user');
    assert.deepEqual(plain(started.userMessages.map(message => [message.id, message.messageIndex, message.turnSequence])),
      [['webhook-user', 2, 1], ['webhook-followup', 3, 1]]);
    assert.equal(state[sessionId][0].attachments[0].name, 'sample.pdf');
    assert.deepEqual(plain(state[sessionId].map(message => message.role)), ['user', 'user', 'assistant']);
    assert.ok(!JSON.stringify(started).includes('private'));
    firstController.abort();
    await first;
    replay = observe(new AbortController().signal);
    // The next model event cannot be consumed before accepted-input hydration.
    providerGate.resolve();
    assert.equal((await run).payload.status, 'completed');
    await replay;
    assert.equal(final, true);
    const rows = plain(api.normalizeChatMessagesForDisplay(state[sessionId]));
    assert.equal(rows.filter(row => row.id === 'webhook-user').length, 1);
    assert.equal(rows.filter(row => row.id === 'webhook-followup').length, 1);
    assert.equal(rows[0].content, '请看这个文件');
    assert.equal(rows[0].attachments[0].name, 'sample.pdf');
    assert.ok(rows.some(row => row.role === 'assistant' && row.content.includes('收到文件')));
  } finally {
    providerGate.resolve(); firstController.abort();
    await Promise.allSettled([run, first, replay]);
    await host.sendCommand({ kind: 'runtime.shutdown', payload: {} });
  }
});
