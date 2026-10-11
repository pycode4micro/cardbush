import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry, registerWorkspaceTools, RuntimeToolLoop, ToolExecutionStore, InMemoryRuntimeEventLog } from '../dist/index.js';
import { TerminalCompletionNotifications } from '../dist/terminalCompletionNotifications.js';

test('terminal receipts distinguish nonzero exit and diagnostics without rewriting native results', () => {
  const registry = new ToolRegistry(); registerWorkspaceTools(registry);
  for (const tool of ['terminal_exec', 'terminal_poll', 'terminal_write', 'terminal_stop']) {
    for (const [state, exitCode, stderr, expected] of [
      ['exited', 0, '', undefined],
      ['exited', 7, 'failure\r\n中文😀', /command failed/],
      ['exited', 0, 'warning: progress\r\n', /may include warnings or non-terminating errors/],
      ['running', null, 'progress', /diagnostic output/],
      ['failed', null, '', /command failed/],
    ]) {
      const result = { terminalSessionId: 'terminal-fixture', state, exitCode, stdout: 'saved\r\n', stderr };
      const original = structuredClone(result);
      const text = registry.renderModelResult(tool, result);
      const metadata = JSON.parse(text.split('\n\n')[0]);
      assert.equal(metadata.exitCode, exitCode); assert.equal(metadata.state, state);
      if (expected) assert.match(metadata.runtime_notice, expected);
      else assert.equal(metadata.runtime_notice, undefined);
      assert.ok(text.endsWith(`[stdout]\n${result.stdout}\n\n[stderr]\n${stderr}`));
      assert.deepEqual(result, original);
    }
  }
});

async function projected(result, budget, count = 1) {
  const defaults = new ToolRegistry(); registerWorkspaceTools(defaults);
  const registry = new ToolRegistry();
  registry.register({ ...defaults.resolve('terminal_exec'), authorize: () => ({ kind: 'allow' }), execute: () => result });
  const store = new ToolExecutionStore();
  const loop = new RuntimeToolLoop({ registry, executionStore: store, eventLog: new InMemoryRuntimeEventLog(),
    identity: { requestId: 'r', sessionId: 's', turnId: 't' } });
  const calls = Array.from({ length: count }, (_, i) => ({ protocol: 'bush.tool_call.v1', id: `call-${i}`, name: 'terminal_exec',
    argumentsText: JSON.stringify({ command: 'fixture', cwd: process.cwd(), yield_time_ms: 1 }) }));
  const response = await loop.execute(calls, { round: 1, assistantMessageId: 'a', modelContextIngressBudgetTokens: budget });
  return { store, response, registry };
}

test('large terminal receipts keep exit status and diagnostic tails within single and shared budgets', async () => {
  const result = { terminalSessionId: 'fixture', state: 'exited', exitCode: 7, signal: null,
    stdout: 'start\n' + 'progress 中文😀\n'.repeat(12000) + '\nSTDOUT_END', stderr: 'warning\n'.repeat(3000) + '\nDIAGNOSTIC_END' };
  const original = structuredClone(result);
  for (const [budget, count] of [[undefined, 1], [3000, 1], [3500, 2], [0, 1]]) {
    const { store, response, registry } = await projected(result, budget, count);
    const outputs = response.messages.filter(message => message.role === 'tool').map(message => message.content);
    if (budget > 0) assert.ok(outputs.reduce((sum, text) => sum + text.length, 0) <= budget - 64 * count);
    for (const text of outputs) {
      assert.ok(text.length <= 16000); assert.match(text, /"archived":true/);
      assert.match(text, /"exitCode":7/); assert.match(text, /command failed/);
      if (budget !== 0) { assert.match(text, /DIAGNOSTIC_END/); assert.match(text, /STDOUT_END/); }
      assert.ok(text.isWellFormed(), 'Unicode excerpts never split surrogate pairs');
    }
    assert.equal(store.get('s', 't', 'call-0').modelText, registry.renderModelResult('terminal_exec', original));
    assert.deepEqual(store.get('s', 't', 'call-0').result, original);
    const summary = store.listTurnSummaries('s', 't')[0];
    assert.equal(summary.outcome, 'returned'); assert.equal(summary.terminalOutcome, 'failed');
    assert.ok(!JSON.stringify(summary).includes('progress'), 'compact history retains status without loading logs');
  }
});

test('long native error text and stdout-only failures remain inspectable', async () => {
  for (const extra of [ { error: 'error details\n'.repeat(3000) + 'ERROR_END' }, {} ]) {
    const result = { terminalSessionId: 'fixture', state: 'failed', exitCode: null, stdout: 'progress\n'.repeat(20000) + 'STDOUT_END', stderr: '', ...extra };
    const { response } = await projected(result, 3000);
    const text = response.messages[0].content;
    assert.match(text, /STDOUT_END/); if (extra.error) assert.match(text, /ERROR_END/);
    assert.match(text, /"state":"failed"/);
  }
});

test('background completion uses the same diagnostic projection and archives full output', async () => {
  const result = { terminalSessionId: 'fixture', state: 'exited', exitCode: 1,
    stdout: 'progress\n'.repeat(20000), stderr: 'background failure details' };
  const store = new ToolExecutionStore(); let delivery;
  const watcher = new TerminalCompletionNotifications({ waitForCompletion: async () => result }, store, undefined,
    (_s, _t, _id, promise) => { delivery = promise; });
  watcher.watch({ sessionId: 's', turnId: 't', requestId: 'r', turn: {}, actionManifest: {
    protocol: 'bush.tool.action_manifest.v1', manifest_id: 'm', effect_kind: 'observation', operation: 'terminal.completion',
    risk: 'low', owner: 'runtime', dispatch_scope: 'session', mutating: false,
  } }, { terminalSessionId: 'fixture' });
  const notice = await delivery;
  assert.match(notice.content, /background failure details/);
  assert.match(notice.content, /"exitCode":1/); assert.ok(notice.content.length < 7000);
  assert.deepEqual(store.listByTool('s', 'terminal_completion')[0].result, result);
  watcher.endTurn('s', 't');
});
