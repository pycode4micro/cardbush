import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadChatTranscript, transcriptDirectory, transcriptModules } from './helpers/load-chat-transcript.mjs';

const api = await loadChatTranscript({ source: [
  ...transcriptModules.map(name => `export * from ${JSON.stringify(resolve(transcriptDirectory, `${name}.ts`))};`),
  `export * from ${JSON.stringify(resolve('src/backend/runtimeTranscriptEvents.ts'))};`,
].join('\n') });
const frames = new Set();
const scheduler = { visible: () => false, schedule(fn) { frames.add(fn); return () => frames.delete(fn); } };
const flush = () => { for (const fn of frames) { frames.delete(fn); fn(); } };
let state = { s: [{ id: 'u', role: 'user', content: '请求', turnId: 't' }] };
const buffer = api.createFrameStreamBuffers((delta, route, release) => {
  state = api.appendAssistantDelta(state, 's', route.messageId, delta, route, release);
}, { scheduler, replace(content, route) {
  state = api.replaceAssistantStreamContent(state, 's', route.messageId, content, route);
} });
const chunk = (kind, finalResponse, extra = {}) => api.assistantStreamChunk({ kind, turnId: 't', sequence: 1,
  requestId: 'r', eventId: `${kind}-${finalResponse}`, payload: { messageId: 'a', segmentId: 'seg', ordinal: 0, finalResponse, ...extra } });
const final = chunk('assistant_segment_delta', true);
buffer.push('已经完成', final); flush();
assert.equal(state.s.at(-1).metadata.transcript_kind, 'assistant_final');
assert.notEqual(state.s.at(-1).status, 'completed', 'display intent must not finish the task');
assert.equal(api.isAssistantFinalTranscript(state.s.at(-1)), true);
const done = buffer.completeSegment('已经完成', chunk('assistant_segment_completed', true)); flush(); await done;
await buffer.completeSegment('已经完成', chunk('assistant_segment_completed', false)); flush();
assert.equal(state.s.at(-1).content, '已经完成');
assert.equal(state.s.at(-1).metadata.transcript_kind, 'assistant_segment');
assert.equal(api.isAssistantFinalTranscript(state.s.at(-1)), false);
buffer.push('继续检查', { ...final, finalResponse: false, segmentId: 'seg2', segmentOrdinal: 2, eventId: 'next' }); flush();
assert.equal(state.s.at(-1).content, '已经完成继续检查', 'phase corrections do not drop later text');
assert.equal(state.s.at(-1).metadata.transcript_kind, 'assistant_segment');
buffer.dispose();
console.log('summary_for_user: final display before done, phase correction, and subsequent text passed');
