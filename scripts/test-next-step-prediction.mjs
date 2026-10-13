import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import * as protocol from '@cardbush/bush-protocol';
import { ToolExecutionStore } from '../packages/bush-runtime/dist/toolExecutionStore.js';
import { ConversationJournal } from '../packages/bush-runtime/dist/conversationJournal.js';
import { AssistantConversation } from '../packages/bush-runtime/dist/assistantConversation.js';

const exports = {};
new Function('exports', 'require', ts.transpileModule(readFileSync('src/features/composer/nextStepPrediction.ts', 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(exports, () => protocol);
const { latestNextStepPrediction: latest } = exports;
const now = Date.now(), at = new Date(now).toISOString();
const call = { protocol: 'bush.tool_call.v1', id: 'summary', name: 'summary_for_user', argumentsText: JSON.stringify({ prediction: { text: '帮我继续整理报告。' } }) };
const receipt = { status: 'ok', final_response: true, saved: true, writes: [{ category: 'prediction', status: 'created', id: 'prediction-1' }] };
const prediction = protocol.savedNextStepPrediction(call, receipt, at);
const user = { id: 'u', role: 'user', content: '先检查报告', turnId: 't', conversationId: 's' };
const tool = { id: call.id, name: call.name, state: 'completed', success: true, turnId: 't', metadata: { nextStepPrediction: prediction } };
const assistant = { id: 'a', role: 'assistant', content: '检查完毕', turnId: 't', conversationId: 's', status: 'completed', toolExecutions: [tool] };

test('only a saved prediction receipt becomes a bounded composer suggestion', () => {
  assert.equal(prediction.text, '帮我继续整理报告。');
  assert.equal(prediction.expiresAt, now + 7 * 86400_000);
  assert.equal(protocol.savedNextStepPrediction(call, { ...receipt, writes: [{ ...receipt.writes[0], status: 'deduplicated' }] }, at)?.text, prediction.text);
  for (const result of [undefined, {}, { status: 'rejected', writes: receipt.writes }, { ...receipt, writes: [] },
    { ...receipt, writes: [{ category: 'habit', status: 'created', id: 'h' }] },
    ...['rejected', 'skipped'].map(status => ({ ...receipt, writes: [{ ...receipt.writes[0], status }] }))]) {
    assert.equal(protocol.savedNextStepPrediction(call, result, at), undefined);
  }
  for (const argumentsText of ['{', '{}', '{"prediction":{"text":""}}', JSON.stringify({ prediction: { text: 'a'.repeat(1601) } })]) {
    assert.equal(protocol.savedNextStepPrediction({ ...call, argumentsText }, receipt, at), undefined);
  }
  assert.equal(protocol.savedNextStepPrediction({ ...call, name: 'check_habit' }, receipt, at), undefined);
});

test('completed summaries survive the lightweight history projection without loading tool details', () => {
  const saved = [];
  const persistence = { load: () => structuredClone(saved), append: record => saved.push(record) };
  const store = new ToolExecutionStore({ persistence, now: () => at });
  store.record(call, { requestId: 'r', sessionId: 's', turnId: 't', round: 1, ordinal: 0 }, { kind: 'returned', result: receipt, workspaceChanges: [] });
  const summary = new ToolExecutionStore({ persistence }).listTurnSummaries('s', 't')[0];
  assert.deepEqual(protocol.toolExecutionSummarySchema.parse(summary).nextStepPrediction, prediction);
  assert.equal('argumentsText' in summary.toolCall, false);
  assert.equal('result' in summary, false);
});

test('suggestions stop at the newest request, turn, failed reply or empty summary', () => {
  assert.equal(latest([user, assistant], 's', now)?.text, prediction.text);
  assert.equal(latest([user, assistant], 'other', now), undefined);
  assert.equal(latest([user, assistant], '', now), undefined);
  assert.equal(latest([user, assistant, { ...user, id: 'next', turnId: 'next' }], 's', now), undefined);
  assert.equal(latest([user, assistant, { ...assistant, id: 'next', turnId: 'next', toolExecutions: [] }], 's', now), undefined);
  assert.equal(latest([user, { ...assistant, status: 'failed' }], 's', now), undefined);
  assert.equal(latest([user, { ...assistant, metadata: { __bush_superseded: true } }], 's', now), undefined);
  for (const last of [{ ...tool, metadata: {} }, { ...tool, success: false, state: 'failed' }, { ...tool, state: 'running' }]) {
    assert.equal(latest([user, { ...assistant, toolExecutions: [tool, last] }], 's', now), undefined);
  }
  assert.equal(latest([user, { ...assistant, toolExecutions: [], loopHistory: [assistant] }], 's', now)?.text, prediction.text);
  assert.equal(latest([user, assistant], 's', prediction.expiresAt), undefined);
  assert.notEqual(latest([assistant], 's', now).id, latest([{ ...assistant, turnId: 'new', toolExecutions: [{ ...tool, turnId: 'new' }] }], 's', now).id,
    'a later turn can suggest the same habit again');
});

test('assistant exposes the saved forecast after restart and clears it for new user input', () => {
  const root = mkdtempSync(join(tmpdir(), 'cardbush-prediction-'));
  const id = protocol.PERSONAL_ASSISTANT_SESSION;
  const journal = new ConversationJournal(root);
  const entry = { id: 'assistant-final', role: 'assistant', content: '检查完毕', source: 'text', visibility: 'conversation', createdAt: at };
  journal.append(id, { ...entry, id: 'user', role: 'user', content: '先检查报告' });
  journal.modelHistory(id).append([
    { role: 'user', content: '先检查报告' }, { role: 'assistant', content: '', toolCalls: [call] },
    { role: 'tool', toolCallId: call.id, content: JSON.stringify(receipt) }, { role: 'assistant', content: entry.content, toolCalls: [] },
  ], ['user', entry.id]);
  journal.append(id, entry);
  const reopened = new ConversationJournal(root);
  const service = new AssistantConversation(reopened, { exists: () => true, tasks: () => [], checkpoint: () => ({}), provider: {}, delegate: async () => ({}) });
  try {
    assert.equal(service.command({ action: 'read', sessionId: id }).nextStepPrediction?.text, prediction.text);
    reopened.append(id, { ...entry, id: 'next-user', role: 'user', content: '改为检查附件' });
    assert.equal(service.command({ action: 'read', sessionId: id }).nextStepPrediction, undefined);
  } finally { service.close(); }
});
