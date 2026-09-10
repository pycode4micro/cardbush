import { modelMessageSchema } from '@cardbush/bush-protocol';
import test from 'node:test';
import assert from 'node:assert/strict';
import { projectActiveTurnContext, assembleContext, CacheChainTracker } from '../dist/index.js';

for (const projectionVersion of [undefined, 'stable_v1']) test(`checkpoint projection survives completion and recovery (${projectionVersion ?? 'legacy'})`, () => {
  const messages = [
    { messageId: 'u', message: { role: 'user', content: 'Original user request' } },
    { messageId: 'a', message: { role: 'assistant', content: '', toolCalls: [{ id: 'call', name: 'read_file', argumentsText: '{}' }] } },
    { messageId: 'r', message: { role: 'tool', toolCallId: 'call', content: 'Original bytes' } },
    { messageId: 'f', message: { role: 'assistant', content: 'Final answer', toolCalls: [] } },
  ];
  const checkpoint = { inputMessageCount: 1, throughMessageId: 'r', summary: 'File inspected; finish the request.', ...(projectionVersion ? { projectionVersion } : {}) };
  const turn = { turnId: 't', turnSequence: 1, messages, contextCheckpoint: checkpoint };
  const active = projectActiveTurnContext({ turnId: 't', inputMessages: messages.slice(0, 1), generatedMessages: messages.slice(1), checkpoint, includeResumeInstruction: true }).map(message => modelMessageSchema.parse(message));
  const session = { sessionId: 's', revision: 1, turns: [turn], supersededMessageIds: [] };
  const committed = assembleContext({ session }).messages;
  assert.deepEqual(committed, active);
  assert.deepEqual(assembleContext({ session: JSON.parse(JSON.stringify(session)) }).messages, active);
  const tracker = new CacheChainTracker();
  const request = { model: 'fixture', tools: [], messages: active };
  tracker.observe(request);
  const next = assembleContext({ session, current: [{ role: 'user', content: 'Next request' }] }).messages;
  assert.equal(tracker.observe({ ...request, messages: next }).frozenPrefixBreak, false);
  assert.equal(active.some(m => m.name === 'context_checkpoint_resume'), !projectionVersion);
  assert.equal(messages[2].message.content, 'Original bytes');
});
