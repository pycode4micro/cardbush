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
const changes = [];
const unsubscribeChanges = modules.onRuntimeInteractionsChanged((sessionId, interaction) => {
  changes.push({ sessionId, interaction });
});

// Reconnect recovers pending requests from Runtime without requiring a fresh event.
let pending = broker.request(identity, 'tool', input);
let card = await modules.fetchPendingInteraction('a');
assert.ok(card, 'typed IPC read restores the pending selection');
assert.equal(card.type, 'solution_selection');
assert.equal(await modules.fetchPendingInteraction('b'), null);
assert.equal(card.questions[0].options[0].label, input.options[0]);
assert.equal(changes.at(-1).interaction.id, card.id, 'reconnect publishes the authoritative pending interaction');
const afterReconnect = changes.length;
await modules.fetchPendingInteraction('a');
assert.equal(changes.length, afterReconnect, 'identical snapshots must not cause refresh/notification loops');
await modules.replyInteraction({ interactionId: card.id, answers: [{ questionId: 'solution', selectedOptionId: '0' }] });
assert.deepEqual(await pending, { status: 'selected', source: 'option', text: input.options[0] });
assert.equal(await modules.fetchPendingInteraction('a'), null);
assert.equal(changes.at(-1).interaction, null, 'answer publishes an explicit clear for inactive-session badges');

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
assert.equal(changes.at(-1).interaction, null, 'late reads cannot restore a cancelled attention marker');
const batch = { questions: [{ id: 'version', ...input }, { id: 'period', prompt: '统计范围', options: ['本周'] }] };
pending = broker.request(identity, 'multi', batch);
card = await modules.fetchPendingInteraction('a');
assert.deepEqual(Array.from(card.questions, question => question.id), ['version', 'period']);
const batchReply = [{ questionId: 'version', selectedOptionId: '1' }, { questionId: 'period', text: '上个月' }];
for (const invalid of [batchReply.slice(0, 1), [batchReply[0], batchReply[0]],
  [batchReply[0], { ...batchReply[1], questionId: 'foreign' }],
  [batchReply[0], { questionId: 'period', selectedOptionId: '2' }],
  [batchReply[0], { questionId: 'period', selectedOptionId: '0', text: '同时填写' }] ]) {
  const before = calls.length;
  await assert.rejects(modules.replyInteraction({ interactionId: card.id, answers: invalid }));
  assert.equal(calls.length, before, 'invalid batches are not sent over the bridge');
}
fail = true;
await assert.rejects(modules.replyInteraction({ interactionId: card.id, answers: batchReply }), /disconnected/);
assert.equal(modules.runtimeSolution(card.id).questions.length, 2);
fail = false;
await modules.replyInteraction({ interactionId: card.id, answers: [...batchReply].reverse() });
assert.deepEqual((await pending).answers.map(answer => [answer.questionId, answer.text]), [['version', input.options[1]], ['period', '上个月']]);
assert.equal(modules.pendingRuntimeInteraction('a'), null);
pending = broker.request(identity, 'multi-cancel', batch);
card = await modules.fetchPendingInteraction('a');
await modules.cancelInteraction(card.id);
assert.equal((await pending).status, 'cancelled');
const answers = calls.filter(command => command.kind === 'runtime.answer_solution_selection').map(command => command.payload);
assert.ok(answers.every(answer => answer.sessionId === 'a' && answer.turnId === 'turn-a'), 'reply identity is retained across the IPC boundary');
unsubscribeChanges();

// Approval and Solution share the live pending queue; resolving one must retain the other.
const isolated = modules.createRuntimeInteractions();
const queueEvents = [];
isolated.onRuntimeInteractionsChanged((sessionId, interaction) => queueEvents.push({ sessionId, interaction }));
const solution = { selectionId: 'solution-b', sessionId: 'background', turnId: 'turn-b', ...input };
isolated.registerRuntimeSolution(solution);
isolated.registerRuntimePermission({
  permissionId: 'approval-b', sessionId: 'background', turnId: 'turn-b',
  request: { requestedCapabilityIds: ['workspace.write'], reason: 'Allow access' },
  answer: async () => {},
});
assert.equal(queueEvents.at(-1).interaction.type, 'path_permission_request');
isolated.removeRuntimePermission('approval-b');
assert.equal(queueEvents.at(-1).interaction.id, 'solution-b', 'resolving approval retains the pending Solution');
isolated.syncRuntimeSolutions('background', []);
assert.equal(queueEvents.at(-1).interaction, null, 'authoritative reconciliation clears an externally resolved Solution');
assert.ok(queueEvents.every(event => event.sessionId === 'background'));
const count = queueEvents.length;
isolated.syncRuntimeSolutions('background', []);
assert.equal(queueEvents.length, count, 'empty snapshots are quiet');
console.log('Solution Selection bridge passed: actual typed IPC, reconnect, session binding, text preservation, retry, cancellation and stale-read protection.');
