// Read-only replay of one recorded turn and its children, using original event timing.
// No model requests or tools are executed; original journals are never rewritten.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { mock } from 'node:test';
import { InMemoryRuntimeEventLog, RuntimeEventProjector } from '../packages/bush-runtime/dist/index.js';

const args = Object.fromEntries(Array.from({ length: (process.argv.length - 2) / 2 }, (_, i) => process.argv.slice(2 + i * 2, 4 + i * 2)));
const root = args['--root'], sessionId = args['--session'], turnId = args['--turn'];
if (!root || !sessionId || !turnId) throw Error('Usage: --root <runtime-state> --session <id> --turn <id>');
const hash = value => createHash('sha256').update(value).digest('hex');
const rows = path => readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);
const children = new Map();
try {
  for (const { event } of rows(join(root, 'subagents', hash(sessionId) + '.jsonl'))) {
    if (event.task.parentTurnId === turnId) children.set(event.taskId, event.task);
  }
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const totals = { turns: 0, originalEvents: 0, batchedEvents: 0, originalBytes: 0, batchedBytes: 0, verifiedSegments: 0 };
for (const identity of [{ sessionId, turnId }, ...[...children.values()].map(t => ({ sessionId: t.childSessionId, turnId: t.childTurnId }))]) {
  const path = join(root, 'events', hash(JSON.stringify([identity.sessionId, identity.turnId])) + '.jsonl');
  const records = rows(path);
  for (const row of records) assert.equal(row.checksum, hash(JSON.stringify(row.event)), 'source journal checksum');
  const events = records.map(row => row.event);
  let originalNow = Date.parse(events[0].createdAt), segmentId;
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: originalNow });
  try {
    const log = new InMemoryRuntimeEventLog({ persistence: { load: () => [], append(event) {
      totals.batchedEvents++;
      totals.batchedBytes += Buffer.byteLength(JSON.stringify({ protocol: 'bush.runtime_event_record.v1', checksum: hash(JSON.stringify(event)), event }) + '\n');
    } } });
    const projectors = new Map();
    for (const event of events) {
      const now = Math.max(originalNow, Date.parse(event.createdAt));
      mock.timers.tick(now - originalNow); originalNow = now;
      const { payload, kind } = event;
      if (/^(reasoning|assistant)_segment_started$/.test(kind)) {
        segmentId = payload.segmentId;
        if (!projectors.has(payload.messageId)) projectors.set(payload.messageId, new RuntimeEventProjector(log, { ...identity, requestId: event.requestId }, {
          createMessageId: () => payload.messageId, createSegmentId: () => segmentId,
        }));
      } else if (/^(reasoning|assistant)_segment_delta$/.test(kind)) {
        projectors.get(payload.messageId).accept({ protocol: 'bush.model_event.v1', requestId: event.requestId,
          sequence: event.sequence, createdAt: event.createdAt,
          kind: kind.startsWith('reasoning') ? 'reasoning_delta' : 'text_delta', delta: payload.delta });
      } else if (/^(reasoning|assistant)_segment_completed$/.test(kind)) {
        const completed = projectors.get(payload.messageId).completeOpenSegment().at(-1);
        assert.equal(completed?.kind, kind);
        assert.deepEqual(completed.payload, payload, 'segment identity, text and order must be unchanged');
        totals.verifiedSegments++;
      } else {
        // Conservatively flush before non-text boundaries as well.
        for (const projector of projectors.values()) projector.flush();
        log.append({ ...identity, requestId: event.requestId }, { kind, payload });
      }
    }
    const replay = log.replay(identity.sessionId, identity.turnId);
    assert.equal(replay.at(-1).kind, 'turn_terminal');
    assert.ok(replay.every((event, index) => event.sequence === index + 1), 'contiguous replay sequences');
    mock.timers.tick(1000); // No late timers may append after the terminal fact.
  } finally { mock.timers.reset(); }
  totals.turns++;
  totals.originalEvents += events.length;
  totals.originalBytes += statSync(path).size;
}
console.log(JSON.stringify({ ...totals,
  eventReductionPercent: +(100 * (1 - totals.batchedEvents / totals.originalEvents)).toFixed(2),
  journalReductionPercent: +(100 * (1 - totals.batchedBytes / totals.originalBytes)).toFixed(2),
}, null, 2));
