import assert from 'node:assert/strict';
import test from 'node:test';
import { returnedToolError, toolExecutionError } from '../dist/index.js';

test('only declared MCP errors and native terminal outcomes carry result failure', () => {
  const result = { isError: true, content: [{ type: 'text', text: 'original detail' }],
    structuredContent: { error: { code: 'page_missing', message: 'Select a tab', details: { large: 'x'.repeat(10_000) } } } };
  const before = structuredClone(result);
  assert.equal(returnedToolError('mcp_call', { mcp: { name: 'mcp__browser__click' }, result }), undefined, 'retired envelopes have no special handling');
  for (const name of ['mcp__browser__click']) {
    const native = result;
    const error = returnedToolError(name, native);
    assert.equal(error.code, 'page_missing');
    assert.equal(error.message, 'Select a tab');
    assert.ok(JSON.stringify(error).length < 400);
    assert.deepEqual(toolExecutionError({ toolCall: { name }, outcome: 'returned', result: native }), error);
  }
  assert.equal(returnedToolError('registered-mcp', result, true).code, 'page_missing');
  for (const name of ['read_json', 'evaluate_script', 'business_tool']) assert.equal(returnedToolError(name, result), undefined);
  for (const native of [{ isError: false, structuredContent: { error: 'business data' } },
    { content: [{ type: 'text', text: '{"isError":true,"error":"example"}' }] },
    { structuredContent: { isError: true } }]) assert.equal(returnedToolError('mcp__demo__read', native), undefined);
  assert.deepEqual(result, before);
});

test('terminal failures are distinct from running, stopped and business JSON', () => {
  for (const name of ['terminal_exec', 'terminal_poll', 'terminal_write', 'terminal_stop', 'terminal_completion']) {
    assert.equal(returnedToolError(name, { state: 'exited', exitCode: 2 }).code, 'terminal_command_failed');
    for (const result of [{ state: 'running', exitCode: null }, { state: 'stopped', exitCode: 1 }, { state: 'exited', exitCode: 0 }]) {
      assert.equal(returnedToolError(name, result), undefined);
    }
  }
  assert.equal(returnedToolError('mcp__demo__read', { structuredContent: { state: 'exited', exitCode: 2 } }), undefined);
});

test('terminal permission and launch facts remain structured without guessing from text or exit codes', () => {
  const denied = { state: 'exited', exitCode: 1, stdout: '', stderr: '', commandStarted: true,
    shellDiagnostic: { source: 'powershell', phase: 'command', permissionDenied: true } };
  const error = returnedToolError('terminal_exec', denied);
  assert.equal(error.kind, 'permission'); assert.equal(error.code, 'terminal_permission_denied');
  assert.equal(error.details.commandStarted, true);
  const launch = returnedToolError('terminal_exec', { state: 'failed', exitCode: 3388997633,
    errorCode: 'process_access_denied', nativeErrorCode: 5, commandStarted: false, error: 'Native startup denied' });
  assert.equal(launch.code, 'process_access_denied'); assert.equal(launch.message, 'Native startup denied');
  assert.equal(launch.details.commandStarted, false); assert.equal(launch.details.nativeErrorCode, 5);
  for (const stderr of ['', 'Access denied', '拒绝访问']) {
    assert.equal(returnedToolError('terminal_exec', { state: 'exited', exitCode: 1, stderr }).kind, 'tool');
  }
  assert.equal(returnedToolError('terminal_exec', { ...denied, exitCode: 0 }), undefined, 'caught errors are not failed commands');
});

test('unstructured declared errors stay bounded and explicit persisted classification survives summaries', () => {
  const resultError = returnedToolError('mcp__demo__read', { isError: true, content: [{ type: 'image', data: 'large' }, { type: 'text', text: 'x'.repeat(50_000) }] });
  assert.equal(resultError.message.length, 2048);
  assert.equal(resultError.code, 'mcp_tool_error');
  assert.deepEqual(toolExecutionError({ toolCall: { name: 'custom_name' }, outcome: 'returned', resultError }), resultError);
});
