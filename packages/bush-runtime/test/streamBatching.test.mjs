import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { InMemoryRuntimeEventLog, FileRuntimeEventPersistence, RuntimeEventProjector } from '../dist/index.js';

const identity = { requestId: 'batch-r', sessionId: 'batch-s', turnId: 'batch-t' };
const model = (kind, delta) => ({ protocol: 'bush.model_event.v1', requestId: identity.requestId,
  createdAt: '2026-09-29T00:00:00Z', sequence: 0, kind, ...(delta === undefined ? {} : { delta }) });
const events = log => log.replay(identity.sessionId, identity.turnId);

test('first delta is immediate; later text is delivered within the interval without another chunk', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const log = new InMemoryRuntimeEventLog(), projector = new RuntimeEventProjector(log, identity);
  projector.accept(model('text_delta', '你'));
  projector.accept(model('text_delta', '好'));
  projector.accept(model('text_delta', '，世界'));
  assert.equal(events(log).at(-1).payload.delta, '你');
  t.mock.timers.tick(39);
  assert.equal(events(log).length, 2);
  t.mock.timers.tick(1);
  assert.equal(events(log).at(-1).payload.delta, '好，世界');
  projector.completeOpenSegment();
  assert.equal(events(log).at(-1).payload.content, '你好，世界');
});

test('channel/tool boundaries and cancellation flush exactly once with no late events', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const log = new InMemoryRuntimeEventLog(), projector = new RuntimeEventProjector(log, identity);
  projector.accept(model('reasoning_delta', 'a'));
  projector.accept(model('reasoning_delta', 'b'));
  projector.accept(model('text_delta', 'c'));
  projector.accept(model('text_delta', 'd'));
  projector.accept({ ...model('tool_call_delta'), index: 0, toolCallId: 'call', nameDelta: 'read', argumentsDelta: '{}' });
  assert.equal(events(log).at(-1).payload.delta, 'd');
  projector.accept(model('text_delta', 'e'));
  projector.completeOpenSegment(); // Runtime also calls this when aborting a round.
  const terminal = log.append(identity, { kind: 'turn_terminal', payload: { status: 'stopped', reason: 'user', details: {} } });
  t.mock.timers.tick(1000);
  assert.equal(events(log).at(-1), terminal);
  assert.deepEqual(events(log).filter(e => e.kind.endsWith('_completed')).map(e => e.payload.content), ['ab', 'cde']);
  assert.equal(projector.assistantContent, 'cde');
  assert.equal(projector.reasoningContent, 'ab');
});

test('size bound flushes bursts and durable replay preserves every character and cursor', t => {
  const root = mkdtempSync(join(tmpdir(), 'cardbush-stream-batch-'));
  const persistence = new FileRuntimeEventPersistence({ root });
  t.after(() => { persistence.close(); assert.equal(dirname(resolve(root)), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); });
  const log = new InMemoryRuntimeEventLog({ persistence }), projector = new RuntimeEventProjector(log, identity);
  const chunks = Array.from({ length: 20000 }, (_, i) => i % 5 ? 'abc' : '中文');
  for (const delta of chunks) projector.accept(model('text_delta', delta));
  projector.accept(model('response_completed'));
  log.append(identity, { kind: 'turn_terminal', payload: { status: 'completed', reason: 'test', details: {} } });
  const replay = new InMemoryRuntimeEventLog({ persistence: new FileRuntimeEventPersistence({ root }) });
  const persisted = events(replay), deltas = persisted.filter(e => e.kind === 'assistant_segment_delta');
  assert.equal(deltas.map(e => e.payload.delta).join(''), chunks.join(''));
  assert.ok(deltas.length < 40, `got ${deltas.length} events for 20000 chunks`);
  assert.deepEqual(persisted, events(log));
  const cursor = persisted[5];
  assert.deepEqual(replay.replay(identity.sessionId, identity.turnId, { afterSequence: cursor.sequence, lastEventId: cursor.eventId }), persisted.slice(6));
  const bytes = statSync(join(root, readdirSync(root)[0])).size;
  assert.ok(bytes < 250000, `batched journal unexpectedly large: ${bytes}`);
});

test('a failed timed append is surfaced to the model round instead of escaping the timer', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let fail = false;
  const log = new InMemoryRuntimeEventLog({ persistence: { load: () => [], append() { if (fail) throw Error('disk failed'); } } });
  const projector = new RuntimeEventProjector(log, identity);
  projector.accept(model('text_delta', 'first'));
  projector.accept(model('text_delta', 'pending'));
  fail = true;
  assert.doesNotThrow(() => t.mock.timers.tick(40));
  assert.throws(() => projector.accept(model('response_completed')), /disk failed/);
  assert.equal(events(log).length, 2, 'failed append must not publish');
});
