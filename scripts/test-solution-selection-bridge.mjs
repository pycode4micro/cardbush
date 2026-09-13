import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { InMemoryRuntimeEventLog } from '../packages/bush-runtime/dist/index.js';
import { RuntimeSolutionBroker } from '../packages/bush-runtime/dist/runtimeSolutionBroker.js';
import { loadChatTranscript } from './helpers/load-chat-transcript.mjs';

const broker = new RuntimeSolutionBroker(new InMemoryRuntimeEventLog());
const calls = [];
let fail = false, deferList;
const bridge = {
  async command(message) {
    calls.push(message.command);
    if (fail) throw new Error('Fixture disconnected');
    const { kind, payload } = message.command;
    let result;
    if (kind === 'runtime.list_solution_selections') {
      result = broker.list(payload.sessionId);
      if (deferList) await new Promise(resolve => { deferList.resolve = resolve; });
    } else if (kind === 'runtime.answer_solution_selection') result = broker.answer(payload);
    else throw new Error('Unexpected command: ' + kind);
    return { protocol: 'bush.runtime_ipc.v1', type: 'command_response', operationId: message.operationId, ok: true, result };
  },
  async startStream() {}, async stopStream() {}, async cancelOperation() {}, onStreamFrame() { return () => {}; },
};
const modules = await loadChatTranscript({ source: `
export { fetchPendingInteraction, replyInteraction, cancelInteraction } from ${JSON.stringify(resolve('src/backend/api.ts'))};
export * from ${JSON.stringify(resolve('src/runtime-client/RuntimeInteractionBridge.ts'))};
`, globals: { structuredClone, AbortController, DOMException, TextEncoder, TextDecoder, setTimeout, clearTimeout,
  process: { env: { NODE_ENV: 'production' } },
  window: { cardbushDesktop: { runtime: bridge }, setTimeout, clearTimeout }, console } });
const input = { prompt: '数据冲突如何处理', options: ['保留现有数据（推荐）', '使用新数据'] };
const identity = { requestId: 'request-a', sessionId: 'a', turnId: 'turn-a' };

// Reconnect recovers pending requests from Runtime without requiring a fresh event.
let pending = broker.request(identity, 'tool', input);
let card = await modules.fetchPendingInteraction('a');
assert.ok(card, 'typed IPC read restores the pending selection');
assert.equal(card.type, 'solution_selection');
assert.equal(await modules.fetchPendingInteraction('b'), null);
assert.equal(card.questions[0].options[0].label, input.options[0]);
await modules.replyInteraction({ interactionId: card.id, answers: [{ questionId: 'solution', selectedOptionId: '0' }] });
assert.deepEqual(await pending, { status: 'selected', source: 'option', text: input.options[0] });
assert.equal(await modules.fetchPendingInteraction('a'), null);

pending = broker.request(identity, 'tool2', input);
card = await modules.fetchPendingInteraction('a');
await assert.rejects(modules.replyInteraction({ interactionId: card.id, answers: [{ questionId: 'solution', text: ' ', selectedOptionId: 'invalid' }] }));
await assert.rejects(modules.replyInteraction({ interactionId: card.id, answers: [{ questionId: 'solution', text: '另一个方案', selectedOptionId: '0' }] }));
fail = true;
await assert.rejects(modules.replyInteraction({ interactionId: card.id, answers: [{ questionId: 'solution', text: '先备份，再合并' }] }), /disconnected/);
assert.equal(modules.runtimeSolution(card.id).id, card.id, 'failed transport preserves the actionable request');
assert.equal((await modules.fetchPendingInteraction('a')).id, card.id, 'transient fetch preserves the live request');
fail = false;
await modules.replyInteraction({ interactionId: card.id, answers: [{ questionId: 'solution', text: '先备份，再合并' }] });
assert.deepEqual(await pending, { status: 'selected', source: 'text', text: '先备份，再合并' });

pending = broker.request(identity, 'tool3', input);
card = await modules.fetchPendingInteraction('a');
deferList = {};
const oldRead = modules.fetchPendingInteraction('a');
while (!deferList.resolve) await new Promise(resolve => setTimeout(resolve, 1));
await modules.cancelInteraction(card.id);
assert.equal((await pending).status, 'cancelled');
deferList.resolve(); deferList = undefined;
assert.equal(await oldRead, null, 'late pending snapshot cannot resurrect a dismissed card');
assert.equal(modules.pendingRuntimeInteraction('a'), null);
const answers = calls.filter(command => command.kind === 'runtime.answer_solution_selection').map(command => command.payload);
assert.ok(answers.every(answer => answer.sessionId === 'a' && answer.turnId === 'turn-a'), 'reply identity is retained across the IPC boundary');
console.log('Solution Selection bridge passed: actual typed IPC, reconnect, session binding, text preservation, retry, cancellation and stale-read protection.');
