import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadChatTranscript } from './helpers/load-chat-transcript.mjs';

const directory = resolve('tmp/streaming-lab');
const collection = JSON.parse(await readFile(resolve(directory, 'history.json'), 'utf8'));
assert.equal(collection.version, 1);
assert.ok(collection.cases.length);
let time = 0, id = 0;
const jobs = new Map();
const schedule = (callback, delay = 16) => {
  const key = ++id; jobs.set(key, { callback, at: time + delay }); return key;
};
const microtasks = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const advance = async milliseconds => {
  const end = time + milliseconds;
  let iterations = 0;
  while (true) {
    const next = [...jobs].sort((a, b) => a[1].at - b[1].at)[0];
    if (!next || next[1].at > end) break;
    assert.ok(iterations++ < 100000, 'timer loop did not settle');
    time = next[1].at; jobs.delete(next[0]); next[1].callback();
    await microtasks();
  }
  time = end; await microtasks();
};
const scheduler = { schedule(callback) { const key = schedule(callback); return () => jobs.delete(key); }, visible: () => true };
const api = await loadChatTranscript({ source:
  `export * from ${JSON.stringify(resolve('src/features/pre_test/streaming/streamingReplay.ts'))};`,
  globals: { window: { setTimeout: schedule, clearTimeout: key => jobs.delete(key), matchMedia: () => ({ matches: false }) },
    performance: { now: () => time } },
});
const clean = value => JSON.parse(JSON.stringify(value));
const semantic = replay => clean(api.replaySemanticSnapshot(replay.getSnapshot().messages));
const flatten = messages => messages.flatMap(message => [message, ...flatten(message.loopHistory ?? [])]);
const differences = api.replayDifferencePaths;
const results = [];
for (const fixture of collection.cases) {
  const baseline = api.createStreamingReplay('baseline', fixture.initial, { now: () => time, identity: fixture.identity });
  const frame = api.createStreamingReplay('frame', fixture.initial, { now: () => time, identity: fixture.identity, scheduler });
  let previous = 0, beforeSnapshot = null;
  for (const item of fixture.events) {
    await advance(Math.max(0, item.at - previous)); previous = item.at;
    if (item.event.kind === 'snapshot') {
      // Drain outstanding animation before comparing; do not let a snapshot hide loss.
      await advance(5000); await Promise.all([baseline.idle(), frame.idle()]);
      beforeSnapshot = differences(semantic(baseline), semantic(frame));
    }
    baseline.accept(item.event); frame.accept(item.event);
    await microtasks();
    if (item.event.kind === 'guidance') {
      assert.equal(frame.getSnapshot().active, true, 'guidance is not a terminal boundary');
      const prior = flatten(frame.getSnapshot().messages).find(message => message.messageId === item.event.update.previousAssistantMessageId);
      assert.equal(prior?.metadata?.segment_boundary, 'turn_guidance');
      assert.notEqual(prior?.metadata?.cardbush_terminal_snapshot, true);
    }
  }
  await advance(5000); await Promise.all([baseline.idle(), frame.idle()]);
  const after = differences(semantic(baseline), semantic(frame));
  beforeSnapshot ??= after;
  const canonical = fixture.events.find(item => item.event.kind === 'snapshot')?.event.messages;
  const expectedFinal = canonical?.filter(message => message.role === 'assistant').at(-1);
  const finalContentEqual = expectedFinal ? flatten(frame.getSnapshot().messages)
    .find(message => (message.messageId ?? message.id) === expectedFinal.id)?.content === expectedFinal.content : null;
  const visible = semantic(frame);
  assert.ok(!JSON.stringify(visible).includes('<subagent_result'), 'internal child input leaked into visible messages');
  assert.equal(frame.getSnapshot().active, false);
  const result = { id: fixture.id, title: fixture.title, durationMs: fixture.duration,
    replayEvents: fixture.events.length, deltas: fixture.source.deltas, tools: fixture.source.tools,
    guidance: fixture.source.guidance, subagents: fixture.source.subagents,
    hasSnapshot: fixture.source.hasSnapshot, beforeSnapshotEqual: !beforeSnapshot.length,
    afterSnapshotEqual: !after.length, canonicalFinalContentEqual: finalContentEqual,
    differences: { beforeSnapshot, afterSnapshot: after },
    baselineFirstReleaseMs: baseline.getSnapshot().firstReleaseMs, frameFirstReleaseMs: frame.getSnapshot().firstReleaseMs,
    baselineCommits: baseline.getSnapshot().commits, frameCommits: frame.getSnapshot().commits };
  results.push(result); console.log(JSON.stringify(result));
  baseline.dispose(); frame.dispose(); assert.equal(jobs.size, 0);
}
await writeFile(resolve(directory, 'history-results.json'), JSON.stringify({ clock: 'original event intervals, virtual 16ms frames', results }, null, 2));
assert.ok(results.every(result => result.beforeSnapshotEqual && result.afterSnapshotEqual && result.canonicalFinalContentEqual !== false),
  'History replay differences: inspect tmp/streaming-lab/history-results.json');
console.log(`Real history replay passed: ${results.length} turns, original timing, before/after snapshots, canonical final text, guidance and internal-input filtering.`);
