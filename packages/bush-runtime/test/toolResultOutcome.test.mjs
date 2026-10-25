import { registerBuiltinToolDisclosure } from '../dist/builtinToolDisclosure.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { returnedToolError, toolExecutionRecordSchema, BUSH_TOOL_EXECUTION_RECORD_PROTOCOL } from '@cardbush/bush-protocol';
import { ToolRegistry, RuntimeToolLoop, InMemoryRuntimeEventLog, ToolExecutionStore,
  registerMcpDiscovery, synchronizeMcpDiscovery } from '../dist/index.js';
import { PluginTerminalHooks } from '../dist/pluginToolHooks.js';
import { summarizeExecution } from '../dist/executionHistory.js';

const identity = { requestId: 'r', sessionId: 's', turnId: 't' };
const manifest = { effect_kind: 'observation', operation: 'fixture.read', risk: 'low', owner: 'fixture', dispatch_scope: 'turn', mutating: false };
const native = { isError: true, content: [{ type: 'text', text: 'Select another authorized tab.' }], structuredContent: { error: { code: 'page_missing', message: 'Selected tab is missing.' } } };
const call = (name, id, input = {}) => ({ protocol: 'bush.tool_call.v1', id, name, argumentsText: JSON.stringify(input) });

test('direct and dispatched MCP errors retain native data and emit one failure hook without replay', async () => {
  for (const indirect of [false, true]) {
    const registry = new ToolRegistry(), eventLog = new InMemoryRuntimeEventLog(), store = new ToolExecutionStore();
    let executions = 0;
    const name = 'mcp__fixture__read';
    registry.register({ definition: { name, description: 'read fixture', inputSchema: { type: 'object', properties: {} } },
      manifest, decodeInput: value => value, execute: () => { executions++; return structuredClone(native); },
      mcpHook: { server: 'fixture', tool: 'read', call: async () => native } });
    registerMcpDiscovery(registry); registerBuiltinToolDisclosure(registry);
    const events = [], hooks = new PluginTerminalHooks().forTurn('s', async (event, context) => { events.push({ event, context }); return { messages: [] }; });
    const loop = new RuntimeToolLoop({ eventLog, identity, registry, executionStore: store, hooks });
    const request = { ...identity, tools: registry.definitions(), metadata: { mcpToolDiscovery: indirect } }, contextMessages = [];
    if (indirect) {
      const search = call('get_tool_schema', 'load', { name: name });
      const loaded = await loop.execute([search], { round: 1, assistantMessageId: 'a1', request, contextMessages });
      contextMessages.push({ role: 'assistant', content: '', toolCalls: [search] }, ...loaded.messages);
      synchronizeMcpDiscovery(registry, request, contextMessages);
    }
    events.length = 0;
    const invocation = indirect ? call('call_tool', 'read', { name, arguments: {} }) : call(name, 'read');
    const output = await loop.execute([invocation], { round: 2, assistantMessageId: 'a2', request, contextMessages });
    const record = store.get('s', 't', 'read');
    assert.equal(record.outcome, 'returned', JSON.stringify(record.error));
    assert.deepEqual(record.result, native);
    assert.equal(record.toolCall.name, name);
    assert.equal(record.resultError.code, 'page_missing');
    assert.equal(record.error, undefined);
    assert.match(output.messages.at(-1).content, /Selected tab is missing/);
    const completed = eventLog.replay('s', 't').find(event => event.kind === 'tool_returned' && event.payload.toolCallId === 'read');
    assert.equal(completed.payload.resultError.code, 'page_missing');
    assert.deepEqual(events.map(item => item.event), ['PreToolUse', 'PostToolUseFailure']);
    assert.equal(events[1].context.toolName, name);
    assert.deepEqual(events[1].context.output, native);
    assert.equal(executions, 1, 'classification never repeats the tool');
    assert.equal(store.listTurnSummaries('s', 't').find(item => item.toolCall.id === 'read').resultError.code, 'page_missing');
  }
});

test('persisted native records retain compact failure projections without rewriting native results or archived text', () => {
  const record = toolExecutionRecordSchema.parse({ protocol: BUSH_TOOL_EXECUTION_RECORD_PROTOCOL, ...identity, round: 1, ordinal: 0,
    recordedAt: '2026-10-13T00:00:00Z', toolCall: call('mcp__fixture__read', 'old'), outcome: 'returned',
    result: native, modelText: 'original\r\n\"isError\":true\n中文😀', workspaceChanges: [] });
  const original = JSON.stringify(record);
  const store = new ToolExecutionStore({ persistence: { load: () => [record], append: () => assert.fail('read-only projection must not append') } });
  const summary = store.listTurnSummaries('s', 't')[0];
  assert.equal(summary.resultError.code, 'page_missing');
  assert.equal('result' in summary, false);
  assert.equal('modelText' in summary, false);
  assert.equal(summarizeExecution(record).outcome, 'failed');
  assert.match(summarizeExecution(record).summary, /page_missing/);
  assert.equal(store.get('s', 't', 'old').modelText, record.modelText);
  assert.equal(JSON.stringify(record), original);
});

test('a failed asynchronous terminal exit emits one failure hook for the original command', async () => {
  const events = [], hooks = new PluginTerminalHooks().forTurn('s', async (event, context) => { events.push({ event, context }); return { messages: [] }; });
  const initial = call('terminal_exec', 'start', { command: 'long task' });
  const poll = call('terminal_poll', 'poll', { session_id: 'terminal-1' });
  const after = (toolCall, result) => hooks.after({ toolCall, input: JSON.parse(toolCall.argumentsText),
    outcome: { kind: 'returned', result, resultError: returnedToolError(toolCall.name, result), workspaceChanges: [] } });
  await hooks.before({ toolCall: initial, input: { command: 'long task' } });
  await after(initial, { state: 'running', terminalSessionId: 'terminal-1' });
  await after(poll, { state: 'running', terminalSessionId: 'terminal-1' });
  const exit = { state: 'exited', terminalSessionId: 'terminal-1', exitCode: 3, stdout: 'partial work' };
  await after(poll, exit);
  await after(poll, exit);
  assert.deepEqual(events.map(item => item.event), ['PreToolUse', 'PostToolUseFailure']);
  assert.equal(events[1].context.toolCallId, 'start');
  assert.equal(events[1].context.input.command, 'long task');
  assert.deepEqual(events[1].context.output, exit);
});
