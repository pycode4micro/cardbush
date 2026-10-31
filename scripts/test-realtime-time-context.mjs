import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { createTurnTimeContext } from '../packages/bush-product-agent/dist/index.js';
import { RealtimeVoiceTime } from '../dist-electron/realtimeVoiceTime.mjs';
import { RealtimeVoiceService, connectRealtimeVoice } from '../dist-electron/realtimeVoiceService.js';
import { realtimeVoiceCatalog } from '../dist-electron/realtimeVoiceCatalog.js';
import { defaultRealtimeVoiceSettings } from '../dist-electron/realtimeVoiceTypes.js';

const pause = () => new Promise(resolve => setImmediate(resolve));
const snapshot = instructions => instructions.match(/<time_context>[\s\S]*?<\/time_context>/)?.[0];
const started = (provider, id) => ({ type: provider === 'qwen' ? 'input_audio_buffer.speech_started' : 'conversation.item.input_audio_transcription.started', item_id: id });
const clockAt = (at, timeZone = 'Asia/Shanghai') => createTurnTimeContext({ createdAt: at, timeZone });
const crypto = { encrypt: value => Buffer.from(value).toString('base64'), decrypt: value => Buffer.from(value, 'base64').toString() };
const waitFor = async predicate => { for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(predicate(), 'expected protocol progress'); };
class Socket {
  readyState = 1; bufferedAmount = 0; sent = []; listeners = new Map();
  addEventListener(type, fn) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  fire(type, event = {}) { for (const fn of this.listeners.get(type) ?? []) fn(event); }
  event(event) { this.fire('message', { data: JSON.stringify(event) }); }
  close() { this.readyState = 3; this.fire('close', { code: 1006, wasClean: false }); }
  send(data) {
    const event = JSON.parse(data); this.sent.push(event);
    if (event.type === 'session.create' || event.type === 'session.update') queueMicrotask(() => this.event({
      type: event.type === 'session.create' ? 'session.created' : 'session.updated', session: event.session,
    }));
    if (event.type === 'session.close') queueMicrotask(() => this.event({ type: 'session.closed' }));
  }
}
function fixture(t, provider, connect) {
  fs.mkdirSync(path.resolve('tmp'), { recursive: true });
  const directory = fs.mkdtempSync(path.resolve('tmp/realtime-time-')), sockets = [], events = [];
  const service = new RealtimeVoiceService(path.join(directory, 'settings.json'), { ...crypto, connect: connect ?? (async () => {
    const socket = new Socket(); sockets.push(socket);
    setImmediate(() => { socket.fire('open'); if (provider === 'qwen') socket.event({ type: 'session.created' }); });
    return { socket, dispose() {} };
  }) });
  service.save({ ...defaultRealtimeVoiceSettings, ...realtimeVoiceCatalog[provider].defaults, provider, apiKey: 'synthetic-key',
    ...(provider === 'qwen' ? { endpoint: 'wss://fixture.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime' } : {}) });
  t.after(() => { service.closeAll(); for (const socket of sockets) socket.close(); });
  const start = (owner = 1, timeZone = 'Asia/Shanghai') => service.start(owner, { id: `time-${owner}`, voice: 'female', timeZone, context: [] }, event => events.push(event));
  return { service, sockets, events, start };
}

test('speech snapshots reuse text-turn clock validation and bind anonymous start to later item IDs', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-31T00:00:00Z') });
  const clock = new RealtimeVoiceTime('</time_context>fake');
  assert.equal(clock.context, createTurnTimeContext({ createdAt: new Date().toISOString() }));
  assert.doesNotMatch(clock.context, /fake/);
  t.mock.timers.tick(1000);
  assert.equal(clock.observe(started('volcengine')), true); const first = clock.context;
  t.mock.timers.tick(1000);
  assert.equal(clock.observe({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'bound', delta: 'Hello' }), false);
  assert.equal(clock.observe({ type: 'conversation.item.input_audio_transcription.delta', delta: ' there' }), false);
  assert.equal(clock.observe({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'bound', transcript: 'Hello there' }), false);
  assert.equal(clock.context, first);
  assert.equal(clock.observe({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'empty', transcript: '' }), false);
  assert.equal(clock.observe({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'fallback', delta: 'Next' }), true);
  const second = clock.context;
  assert.equal(clock.observe(started('qwen', 'bound')), false, 'late old starts cannot replace the current clock');
  assert.equal(clock.context, second);
});

for (const provider of ['volcengine', 'qwen']) {
  test(`${provider}: one clock per user utterance across midnight, no refresh from ASR revisions or assistant output`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-31T15:59:50Z') });
    const f = fixture(t, provider); await f.start(); const socket = f.sockets[0];
    assert.equal(snapshot(socket.sent[0].session.instructions), clockAt('2026-10-31T15:59:50Z'));
    t.mock.timers.tick(9000); const before = socket.sent.length;
    socket.event(started(provider, 'first')); await pause();
    const frame = socket.sent[before], first = clockAt('2026-10-31T15:59:59Z');
    assert.equal(frame.type, 'session.update'); assert.equal(snapshot(frame.session.instructions), first);
    if (provider === 'qwen') assert.deepEqual(Object.keys(frame.session), ['instructions'], 'no audio/VAD/tool reconfiguration on each utterance');
    else { assert.equal(frame.session.model, '1.2.6.1'); assert.equal(frame.session.audio.input.format.rate, 16000); }
    t.mock.timers.tick(11_000);
    socket.event(started(provider, 'first'));
    socket.event({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'first', text: '今天', delta: '今天' });
    socket.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'first', transcript: '今天星期几？' });
    socket.event({ type: 'response.created', response: { id: 'answer' }, response_id: 'answer' });
    socket.event({ type: provider === 'qwen' ? 'response.audio_transcript.delta' : 'response.output_text.delta', response_id: 'answer', item_id: 'answer', delta: '今天是周六。' });
    assert.equal(socket.sent.length, before + 1);
    assert.equal(f.events.find(event => event.type === 'transcript' && event.role === 'user' && event.final).text, '今天星期几？');
    assert.ok(!JSON.stringify(f.events).includes('<time_context>'), 'clock facts stay out of visible transcripts');
    f.service.setVoice(1, 'time-1', 'male'); await pause();
    if(provider==='qwen') assert.deepEqual(socket.sent.at(-1).session,{audio:{output:{voice:'Raymond'}}},'voice changes leave existing instructions and audio formats intact');
    assert.equal(snapshot(socket.sent.findLast(e=>e.session?.instructions).session.instructions), first, 'changing voice retains the current input timestamp');
    socket.event(started(provider, 'second')); await pause();
    assert.equal(snapshot(socket.sent.at(-1).session.instructions), clockAt('2026-10-31T16:00:10Z'));
    assert.equal((socket.sent.at(-1).session.instructions.match(/<time_context>/g) ?? []).length, 1);
    assert.ok(!f.events.some(event => event.type === 'error'));
  });

  test(`${provider}: transcript-only services refresh once and failed recognition does not manufacture speech`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-31T00:00:00Z') });
    const f = fixture(t, provider); await f.start(); const socket = f.sockets[0], before = socket.sent.length;
    t.mock.timers.tick(1000);
    socket.event({ type: 'conversation.item.input_audio_transcription.failed', item_id: 'noise' });
    socket.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'empty', transcript: '' });
    assert.equal(socket.sent.length, before);
    socket.event({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'fallback', text: '时间', delta: '时间' });
    const first = socket.sent.at(-1).session.instructions;
    t.mock.timers.tick(5000);
    socket.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'fallback', transcript: '时间？' });
    assert.equal(socket.sent.length, before + 1); assert.equal(socket.sent.at(-1).session.instructions, first);
    socket.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'final-only', transcript: '现在呢？' });
    assert.equal(socket.sent.length, before + 2);
    assert.equal(snapshot(socket.sent.at(-1).session.instructions), clockAt('2026-10-31T00:00:06Z'));
    await pause(); assert.ok(!f.events.some(event => event.type === 'error'));
  });

  test(`${provider}: owner clocks are isolated and reconnect permits reused item IDs without stale-socket updates`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-31T12:00:00Z') });
    const f = fixture(t, provider); await f.start(); await f.start(2, 'America/New_York');
    const [first, other] = f.sockets;
    first.event(started(provider, 'same-id')); other.event(started(provider, 'same-id')); await pause();
    const prior = snapshot(first.sent.at(-1).session.instructions);
    assert.equal(snapshot(other.sent.at(-1).session.instructions), clockAt('2026-10-31T12:00:00Z', 'America/New_York'));
    t.mock.timers.tick(5000); first.close();
    await waitFor(() => f.events.filter(event => event.type === 'connection-state' && event.state === 'connected').length === 3);
    const recovered = f.sockets[2]; assert.equal(snapshot(recovered.sent[0].session.instructions), prior);
    const count = recovered.sent.length;
    first.event(started(provider, 'old-socket')); assert.equal(recovered.sent.length, count);
    recovered.event(started(provider, 'same-id')); await pause();
    assert.equal(snapshot(recovered.sent.at(-1).session.instructions), clockAt('2026-10-31T12:00:05Z'));
    assert.equal(snapshot(other.sent.at(-1).session.instructions), clockAt('2026-10-31T12:00:00Z', 'America/New_York'));
    assert.ok(!f.events.some(event => event.type === 'error'));
  });

  test(`${provider}: speech-start time reaches a real loopback WebSocket before the next response`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-31T12:00:00Z') });
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
    t.after(() => { for (const peer of server.clients) peer.terminate(); server.close(); });
    const frames = [], errors = []; let peer;
    server.on('connection', socket => {
      peer = socket;
      if (provider === 'qwen') socket.send(JSON.stringify({ type: 'session.created' }));
      socket.on('message', bytes => {
        try {
          const event = JSON.parse(String(bytes)); frames.push(event);
          if (event.type === 'session.create' || event.type === 'session.update') socket.send(JSON.stringify({
            type: event.type === 'session.create' ? 'session.created' : 'session.updated', session: event.session,
          }));
        } catch (error) { errors.push(error); }
      });
    });
    const f = fixture(t, provider, async (_url, headers) => connectRealtimeVoice('', `ws://127.0.0.1:${server.address().port}/realtime`, headers));
    await f.start(); t.mock.timers.tick(2500);
    peer.send(JSON.stringify(started(provider, 'wire-input')));
    await waitFor(() => frames.filter(event => event.type === 'session.update').length === (provider === 'qwen' ? 2 : 1));
    assert.equal(snapshot(frames.findLast(event => event.type === 'session.update').session.instructions), clockAt('2026-10-31T12:00:02.500Z'));
    assert.ok(!frames.some(event => ['response.create', 'speech_text_buffer.commit', 'conversation.item.create'].includes(event.type)));
    f.service.audio(1, 'time-1', new ArrayBuffer(640));
    await waitFor(() => frames.some(event => event.type === 'input_audio_buffer.append'));
    assert.deepEqual(errors, []); assert.ok(!f.events.some(event => event.type === 'error'));
  });
}
