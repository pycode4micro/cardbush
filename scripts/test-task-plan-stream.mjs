import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { ToolExecutionStore, InMemoryRuntimeEventLog } from '../packages/bush-runtime/dist/index.js';
import { loadChatTranscript } from './helpers/load-chat-transcript.mjs';

const now = '2026-09-18T06:53:42.899Z';
const sessionId = 'plan-session', turnId = 'new-task';
const listeners = new Set();
let fixture;
const bridge = {
  onStreamFrame(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  async startStream({ protocol, subscriptionId }) {
    for (const event of fixture.events) {
      for (const listener of listeners) listener({ protocol, type: 'stream_frame', subscriptionId, frame: { kind: 'event', event } });
    }
    for (const listener of listeners) listener({ protocol, type: 'stream_frame', subscriptionId, frame: { kind: 'end' } });
  },
  async command({ protocol, operationId, command }) {
    let result = null;
    if (command.kind === 'runtime.get_tool_execution') {
      const item = fixture.records.get(command.payload.toolCallId);
      if (item.delay) await new Promise(resolve => setTimeout(resolve, item.delay));
      result = item.record;
    } else if (command.kind === 'runtime.get_plan') {
      fixture.planReads++;
      result = fixture.latest;
    } else assert.equal(command.kind, 'runtime.get_session');
    return { protocol, type: 'command_response', operationId, ok: true, result };
  },
  async stopStream() {}, async cancelOperation() {},
};
const api = await loadChatTranscript({
  source: [
    `export { streamRuntimeTurnEvents } from ${JSON.stringify(path.resolve('src/backend/runtimeChat.ts'))};`,
    `export { applyTaskPlanUpdate } from ${JSON.stringify(path.resolve('src/features/chatMessages/transcript/liveMessageUpdates.ts'))};`,
  ].join('\n'),
  globals: { console, AbortController, DOMException, TextEncoder, TextDecoder, structuredClone, setTimeout, clearTimeout,
    process: { env: { NODE_ENV: 'test' } }, window: { setTimeout, clearTimeout, cardbushDesktop: { runtime: bridge } } },
});
function plan(revision, count, active, explanation) {
  return { protocol: 'bush.plan_state.v1', sessionId, revision, updatedAt: now,
    plan: { protocol: 'bush.task_plan.v1', plan_id: 'plan', session_id: sessionId, active, explanation,
      nodes: Array.from({ length: count }, (_, index) => ({ id: `node-${index}`, step: `${explanation} ${index}`,
        status: active ? index ? 'pending' : 'in_progress' : 'completed' })) } };
}
const prior = plan(5, 13, false, 'Previous task completed');
const toUi = state => ({ protocol: state.plan.protocol, planId: state.plan.plan_id, sessionId,
  nodes: state.plan.nodes, active: state.plan.active, explanation: state.plan.explanation });

async function replay(items, latest = prior) {
  const store = new ToolExecutionStore({ now: () => now });
  const log = new InMemoryRuntimeEventLog({ now: () => now });
  const records = new Map();
  for (const [ordinal, item] of items.entries()) {
    const identity = { requestId: 'request', sessionId, turnId, round: 1, ordinal };
    const error = { kind: 'tool', code: 'tool_execution_exception', message: 'Removing Plan nodes requires an explicit scopeChangeReason.', details: {} };
    const record = store.record({ protocol: 'bush.tool_call.v1', id: item.id, name: 'update_task_plan', argumentsText: '{}' }, identity,
      item.failed ? { kind: 'failed', error, workspaceChanges: [] } : { kind: 'returned', result: item.result, workspaceChanges: [] });
    records.set(item.id, { record, delay: item.delay });
    log.append(identity, { kind: item.failed ? 'tool_failed' : 'tool_returned',
      payload: { toolCallId: item.id, toolName: 'update_task_plan', ordinal, assistantMessageId: 'current', ...(item.failed ? { error } : {}) } });
  }
  fixture = { records, latest, events: log.replay(sessionId, turnId), planReads: 0 };
  const updates = [], tools = [];
  let state = { [sessionId]: [
    { id: 'old', role: 'assistant', content: '', turnId: 'old-task', taskPlan: toUi(prior) },
    { id: 'current', role: 'assistant', content: '', turnId },
  ] };
  await api.streamRuntimeTurnEvents({ sessionId, turnId,
    onToolExecution: tool => tools.push(tool),
    onTaskPlanUpdate: update => { updates.push(update); state = api.applyTaskPlanUpdate(state, sessionId, 'current', update); },
  });
  assert.equal(fixture.planReads, 0, 'plan presentation must come from the Tool receipt, not a later session lookup');
  assert.equal(state[sessionId][0].taskPlan.explanation, prior.plan.explanation);
  return { updates, tools, message: state[sessionId][1] };
}

test('a failed update does not attach the previous completed 13-step plan to a new Turn', async () => {
  const result = await replay([{ id: 'failed', failed: true }]);
  assert.equal(result.updates.length, 0);
  assert.equal(result.message.taskPlan, undefined);
  assert.equal(result.tools.at(-1).state, 'failed');
});

test('a successful update renders the exact plan in its receipt, even if session state has changed', async () => {
  const receipt = plan(6, 4, true, 'Subtitle removal');
  const result = await replay([{ id: 'new', result: receipt }], plan(7, 2, true, 'Later task'));
  assert.equal(result.updates.length, 1);
  assert.equal(result.message.taskPlan.nodes.length, 4);
  assert.equal(result.message.taskPlan.explanation, receipt.plan.explanation);
});

test('slow older receipts cannot overwrite a newer revision', async () => {
  const result = await replay([
    { id: 'slow', result: plan(6, 4, true, 'Started'), delay: 30 },
    { id: 'latest', result: plan(7, 4, false, 'Finished') },
  ]);
  assert.equal(result.updates.length, 1);
  assert.equal(result.message.taskPlan.active, false);
  assert.equal(result.message.taskPlan.explanation, 'Finished');
});

test('missing or unrelated plan receipts cannot fall back to the session plan', async () => {
  const result = await replay([
    { id: 'invalid', result: { success: true } },
    { id: 'other-session', result: { ...prior, sessionId: 'other' } },
  ]);
  assert.equal(result.updates.length, 0);
  assert.equal(result.message.taskPlan, undefined);
});
