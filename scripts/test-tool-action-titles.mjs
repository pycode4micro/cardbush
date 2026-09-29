import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadChatTranscript } from './helpers/load-chat-transcript.mjs';

const api = await loadChatTranscript({ source: [
  ['src/backend/runtimeTranscriptEvents.ts', 'toolLifecycle'],
  ['src/backend/api.ts', 'runtimeHistoryToolExecution'],
  ['src/backend/historyToolAssociation.ts', 'attachHistoryToolExecutions'],
  ['src/features/chatMessages/transcript/toolExecutionMerge.ts', 'mergeToolExecutionUpdate'],
  ['src/features/tools/toolExecutionState.ts', 'toolActionTitle, selectToolActivityExecution, toolActivityStatus, compareToolExecutionOrder'],
].map(([file, names]) => `export { ${names} } from ${JSON.stringify(path.resolve(file))};`).join('\n'),
  globals: { console, AbortController, DOMException, TextEncoder, TextDecoder, structuredClone, setTimeout, clearTimeout, process: { env: { NODE_ENV: 'test' } } },
});
const event = (sequence, kind, title) => ({ kind, sequence, turnId: 't', createdAt: '2026-09-26T00:00:00Z',
  payload: { toolCallId: 'one', toolName: 'mcp_call', assistantMessageId: 'a', ...(title ? { display: { title } } : {}) } });
const record = { protocol: 'bush.tool_execution_summary.v1', requestId: 'r', sessionId: 's', turnId: 't', round: 1, ordinal: 0, recordedAt: '2026-09-26T00:00:00Z',
  toolCall: { protocol: 'bush.tool_call.v1', id: 'one', name: 'mcp_call' }, outcome: 'returned', resultAvailable: true, workspaceChanges: [], display: { title: '核对产品资料' } };

test('live lifecycle, compact history and full details have the same action title', () => {
  const live = api.toolLifecycle(event(1, 'tool_queued', '核对产品资料'));
  const history = api.runtimeHistoryToolExecution(record);
  const detail = api.runtimeHistoryToolExecution({ ...record, protocol: 'bush.tool_execution_record.v1', result: { state: 'queued', jobId: 'job-1' } });
  for (const row of [live, history, detail]) assert.equal(api.toolActionTitle(row, 'zh'), '核对产品资料');
  assert.equal(api.toolActivityStatus(detail, 'zh', true), '已返回', 'queued external work is not described as a finished deliverable');
});

test('late or duplicated events cannot rewind state or replace a title', () => {
  let row = api.toolLifecycle(event(2, 'tool_running', '核对产品资料'));
  row = api.mergeToolExecutionUpdate(row, api.toolLifecycle(event(1, 'tool_queued', '旧标题')));
  assert.equal(row.state, 'running');
  assert.equal(row.metadata.lifecycleSequence, 2);
  assert.equal(api.toolActionTitle(row, 'zh'), '核对产品资料');
  row = api.mergeToolExecutionUpdate(row, api.toolLifecycle(event(3, 'tool_failed')));
  row = api.mergeToolExecutionUpdate(row, api.toolLifecycle(event(2, 'tool_running')));
  assert.equal(row.state, 'failed');
  assert.equal(api.toolActionTitle(row, 'zh'), '核对产品资料');
});

test('historical enrichment from an older agent preserves an existing title', () => {
  const live = api.toolLifecycle(event(1, 'tool_running', '核对产品资料'));
  const legacy = api.runtimeHistoryToolExecution({ ...record, display: undefined });
  const merged = api.mergeToolExecutionUpdate(live, legacy);
  assert.equal(api.toolActionTitle(merged, 'zh'), '核对产品资料');
  const messages = api.attachHistoryToolExecutions([{ id: 'a', role: 'assistant', turnId: 't', toolExecutions: [live] }], [{ ...legacy, assistantMessageId: 'a' }]);
  assert.equal(api.toolActionTitle(messages[0].toolExecutions[0], 'zh'), '核对产品资料');
});

test('fallbacks avoid raw command/error text and never describe tool counts', () => {
  const row = api.runtimeHistoryToolExecution({ ...record, display: undefined });
  row.name = 'terminal_exec'; row.summary = 'secret command --token=private';
  assert.equal(api.toolActionTitle(row, 'zh'), '执行命令');
  assert.equal(api.toolActionTitle(row, 'en'), 'Run command');
});

test('specific descriptions follow the UI language through live updates and archived receipts', () => {
  const titles = { zh: '检查项目类型错误', en: 'Check project type errors' };
  const display = { title: titles.en, titles };
  const queued = event(1, 'tool_queued'); queued.payload.display = display;
  const live = api.toolLifecycle(queued);
  const history = api.runtimeHistoryToolExecution({ ...record, display });
  const detail = api.runtimeHistoryToolExecution({ ...record, display, protocol: 'bush.tool_execution_record.v1', result: { state: 'exited' } });
  const late = event(2, 'tool_returned'); late.payload.display = { title: 'stale', titles: { zh: '旧标题', en: 'Old title' } };
  const merged = api.mergeToolExecutionUpdate(live, api.toolLifecycle(late));
  const attached = api.attachHistoryToolExecutions([{ id: 'a', role: 'assistant', turnId: 't', toolExecutions: [live] }],
    [{ ...detail, assistantMessageId: 'a', metadata: { displayTitle: 'stale', displayTitles: { zh: '旧标题', en: 'Old title' } } }]);
  for (const row of [live, history, detail, merged, attached[0].toolExecutions[0]]) {
    for (const language of ['zh', 'en', 'zh']) assert.equal(api.toolActionTitle(row, language), titles[language]);
  }
});

test('legacy descriptions remain available in their language with localized fallback in the other', () => {
  const row = api.runtimeHistoryToolExecution({ ...record, toolCall: { ...record.toolCall, name: 'terminal_exec' } });
  assert.equal(api.toolActionTitle(row, 'zh'), '核对产品资料');
  assert.equal(api.toolActionTitle(row, 'en'), 'Run command');
  row.metadata.displayTitle = 'Check product information';
  assert.equal(api.toolActionTitle(row, 'en'), 'Check product information');
  assert.equal(api.toolActionTitle(row, 'zh'), '执行命令');
});

test('parallel selection is sticky and permission requests remain visible', () => {
  const first = { ...api.toolLifecycle(event(1, 'tool_running', '第一项工作')), id: 'first' };
  const second = { ...api.toolLifecycle(event(2, 'tool_running', '第二项工作')), id: 'second' };
  assert.equal(api.selectToolActivityExecution([second, first], 'first').id, 'first');
  assert.equal(api.selectToolActivityExecution([{ ...first, state: 'completed' }, second], 'first').id, 'second');
  assert.equal(api.selectToolActivityExecution([{ ...first, state: 'completed' }, { ...second, state: 'completed' }], 'second').id, 'second');
  assert.equal(api.selectToolActivityExecution([first, { ...second, state: 'awaiting_permission' }], 'first').id, 'second');
});

test('JSON-encoded legacy locale titles follow language switching; malformed JSON uses the tool fallback', () => {
  const titles = { zh: '检查接收端改动', en: 'Inspect receiver changes' };
  const legacy = { ...record, toolCall: { ...record.toolCall, name: 'terminal_exec' }, display: { title: JSON.stringify(titles) } };
  const row = api.runtimeHistoryToolExecution(legacy);
  for (const language of ['zh', 'en', 'zh']) assert.equal(api.toolActionTitle(row, language), titles[language]);
  for (const title of ['{"zh":"unfinished', '{"command":"private"}', '["private"]']) {
    row.metadata.displayTitle = title;
    assert.equal(api.toolActionTitle(row, 'zh'), '执行命令');
    assert.equal(api.toolActionTitle(row, 'en'), 'Run command');
  }
});

test('opaque IDs never reorder calls with equal ordering facts', () => {
  const calls = ['job-9', 'job-10', 'job-11'].map(id => ({ ...api.toolLifecycle(event(1, 'tool_returned')), id }));
  assert.deepEqual(calls.sort(api.compareToolExecutionOrder).map(row => row.id), ['job-9', 'job-10', 'job-11']);
});
