import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadChatTranscript } from './helpers/load-chat-transcript.mjs';

let time = 0, id = 0, visible = true;
const jobs = new Map();
const visibility = new Set();
const schedule = (callback, delay = 16) => {
  const key = ++id; jobs.set(key, { callback, at: time + delay }); return key;
};
const advance = async milliseconds => {
  const end = time + milliseconds;
  for (let iterations = 0; iterations < 10000; iterations++) {
    const next = [...jobs].sort((a, b) => a[1].at - b[1].at)[0];
    if (!next || next[1].at > end) break;
    time = next[1].at; jobs.delete(next[0]); next[1].callback();
    await Promise.resolve();
  }
  time = end;
  await Promise.resolve();
};
const scheduler = {
  schedule(callback) { const key = schedule(callback); return () => jobs.delete(key); },
  visible: () => visible,
  watchVisibility(callback) { visibility.add(callback); return () => visibility.delete(callback); },
};
const api = await loadChatTranscript({
  source: ['frameStreamBuffer', 'streamingReplay', 'fixtures'].map(name =>
    `export * from ${JSON.stringify(resolve('src/features/pre_test/streaming', name + '.ts'))};`).join('\n'),
  globals: { window: { setTimeout: schedule, clearTimeout: key => jobs.delete(key), matchMedia: () => ({ matches: false }) },
    document: { visibilityState: 'visible' }, performance: { now: () => time } },
});
const route = api.labRoute('first');
const emitted = [];
let text = '';
const buffer = api.createFrameStreamBuffers((delta, target, release) => {
  text += delta; emitted.push({ delta, target, release });
}, { scheduler, replace: content => { text = content; } });

buffer.push('首批 🧪', route);
assert.equal(text, '');
await advance(16);
assert.equal(text, '首批 🧪', 'text is visible before segment completion');
assert.equal(emitted[0].release, undefined, 'painting must not complete a segment');
const completed = buffer.completeSegment('首批 🧪', route);
await advance(16); await completed;
assert.equal(emitted.at(-1).delta, '');
assert.equal(emitted.at(-1).release.reason, 'segment_completed', 'empty completion preserves the existing collapse marker');
await buffer.completeSegment('首批 🧪', route);
assert.equal(emitted.length, 2, 'repeated completion is idempotent');

const second = { ...route, segmentId: 'second', segmentOrdinal: 2 };
buffer.push('第二段', second);
await advance(16);
const secondDone = buffer.completeSegment('第二段', second);
await advance(16); await secondDone;
assert.equal(text, '首批 🧪第二段', 'multiple segments in one message are not replayed twice');
const third = { ...route, segmentId: 'third', segmentOrdinal: 4 };
buffer.push('工具前'.repeat(100), third);
const boundary = buffer.releaseToolBoundary();
assert.equal(text, '首批 🧪第二段' + '工具前'.repeat(100), 'tool boundaries flush synchronously for correct offsets');
await boundary;
assert.equal(jobs.size, 0);
await buffer.completeRoute('权威快照更正', route);
assert.equal(text, '权威快照更正', 'a non-prefix snapshot replaces, rather than appends');
buffer.dispose();

let burst = '';
let commits = 0;
const fast = api.createFrameStreamBuffers(delta => { burst += delta; commits++; }, { scheduler, replace: content => { burst = content; } });
for (let i = 0; i < 10000; i++) fast.push('🧪', route);
assert.equal(jobs.size, 1, 'a burst schedules one frame, not one timer per token');
await advance(64);
assert.equal(commits, 4);
assert.equal(burst, '🧪'.repeat(96), 'frame slicing preserves Unicode surrogate pairs');
visible = false; visibility.forEach(callback => callback());
assert.equal(burst, '🧪'.repeat(10000), 'hidden views drain without waiting for animation frames');
assert.equal(jobs.size, 0);
visible = true;
fast.push('待取消', { ...route, segmentId: 'pending' });
const waiting = fast.completeSegment('待取消', { ...route, segmentId: 'pending' });
fast.dispose(); await waiting;
assert.equal(jobs.size, 0);
assert.equal(visibility.size, 0, 'dispose detaches visibility listeners');

let late = '';
const lateBuffer = api.createFrameStreamBuffers(delta => { late += delta; }, { scheduler, replace: content => { late = content; } });
await lateBuffer.releaseTerminal();
lateBuffer.push('晚到的末尾', { ...route, eventId: 'late-1' });
lateBuffer.push('晚到的末尾', { ...route, eventId: 'late-1' });
await advance(16);
assert.equal(late, '晚到的末尾', 'terminal races and replayed event IDs do not lose or duplicate text');
lateBuffer.push('旧会话尾部', { ...route, messageId: 'old' });
lateBuffer.reset({ ...route, messageId: 'old' });
await advance(16);
assert.equal(late, '晚到的末尾', 'reset prevents stale queued text from leaking into another route');
lateBuffer.dispose();

// Resume a detached subscription halfway through the second protocol segment.
let resumedText = '';
const appendResume = delta => { resumedText += delta; };
const resumeOptions = { scheduler, replace: content => { resumedText = content; } };
const original = api.createFrameStreamBuffers(appendResume, resumeOptions);
original.push('第一块。', { ...route, eventId: 'resume-1' });
let drained = original.completeSegment('第一块。', route);
await advance(160); await drained;
original.push('第二块', { ...second, eventId: 'resume-2' });
const checkpoint = original.checkpoint();
original.dispose();
const resumed = api.createFrameStreamBuffers(appendResume, { ...resumeOptions, checkpoint });
resumed.push('第二块', { ...second, eventId: 'resume-2' }); // replayed cursor event
resumed.push('续接完成。', { ...second, eventId: 'resume-3' });
drained = resumed.completeSegment('第二块续接完成。', second);
await advance(160); await drained;
assert.equal(resumedText, '第一块。第二块续接完成。', 'resume preserves prior blocks and deduplicates cursor delivery');
drained = resumed.completeRoute(resumedText, route);
await advance(160); await drained;
assert.equal(resumedText, '第一块。第二块续接完成。');
resumedText = '修订前缀';
resumed.reset(route, resumedText);
resumed.push('后缀', { ...route, eventId: 'revision-1' });
drained = resumed.completeSegment('修订前缀后缀', route);
await advance(160); await drained;
assert.equal(resumedText, '修订前缀后缀', 'revision seeds are not duplicated by protocol snapshots');
resumed.dispose();

let routesFlushed = [];
const isolated = api.createFrameStreamBuffers((delta, route) => routesFlushed.push(route.messageId), { scheduler, replace: () => {} });
isolated.push('保留动画', route);
isolated.push('先释放', { ...route, messageId: 'other-route' });
isolated.flushToolBoundary(route);
assert.deepEqual(routesFlushed, ['other-route'], 'a final revision flushes other messages without draining its own animation');
await isolated.flushRoute(route);
assert.deepEqual(routesFlushed, ['other-route', route.messageId]);
isolated.dispose();
assert.equal(jobs.size, 0);

const results = [];
for (const scenario of Object.keys(api.scenarios)) {
  const fixture = api.streamingFixture(scenario);
  const baseline = api.createStreamingReplay('baseline', fixture.initial, { now: () => time });
  const frame = api.createStreamingReplay('frame', fixture.initial, { scheduler, now: () => time });
  let previous = 0;
  for (const item of fixture.events) {
    await advance(item.at - previous); previous = item.at;
    baseline.accept(item.event); frame.accept(item.event);
    await Promise.resolve();
    if (item.event.kind === 'guidance') {
      assert.equal(frame.getSnapshot().active, true);
      const sealed = frame.getSnapshot().messages.find(message => message.id === 'lab-first');
      assert.equal(sealed.metadata.segment_boundary, 'turn_guidance');
      assert.notEqual(sealed.metadata.cardbush_terminal_snapshot, true, 'guidance never becomes a terminal fact');
    }
    if (item.event.kind === 'terminal') {
      await advance(3000);
      await Promise.all([baseline.idle(), frame.idle()]);
      assert.deepEqual(JSON.parse(JSON.stringify(api.replaySemanticSnapshot(frame.getSnapshot().messages))),
        JSON.parse(JSON.stringify(api.replaySemanticSnapshot(baseline.getSnapshot().messages))),
        `${scenario}: content and tool offsets agree BEFORE final snapshot masks differences`);
    }
  }
  await advance(3000); await Promise.all([baseline.idle(), frame.idle()]);
  assert.deepEqual(JSON.parse(JSON.stringify(api.replaySemanticSnapshot(frame.getSnapshot().messages))),
    JSON.parse(JSON.stringify(api.replaySemanticSnapshot(baseline.getSnapshot().messages))), `${scenario}: final snapshot/replay parity`);
  assert.equal(frame.getSnapshot().active, false);
  results.push({ scenario, baselineFirstReleaseMs: baseline.getSnapshot().firstReleaseMs,
    frameFirstReleaseMs: frame.getSnapshot().firstReleaseMs, frameCommits: frame.getSnapshot().commits });
  baseline.dispose(); frame.dispose();
  assert.equal(jobs.size, 0);
}
console.log(JSON.stringify(results, null, 2));
console.log('Streaming lab passed: early text, completion metadata, Unicode, offsets, snapshot corrections, hidden views, reset/dispose, terminal races and five replay scenarios.');
