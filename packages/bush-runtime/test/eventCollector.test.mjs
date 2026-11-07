import assert from 'node:assert/strict';
import test from 'node:test';
import { PERSONAL_ASSISTANT_SESSION } from '@cardbush/bush-protocol';
import { EventCollector } from '../dist/eventCollector.js';
import { ToolRegistry, ToolExecutionStore } from '../dist/index.js';

function fixture() {
  const registry = new ToolRegistry(), executions = new ToolExecutionStore(), calls = [];
  const definition = { name: 'mcp__fixture__read', description: 'Read a source.', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } };
  const task = { parentSessionId: PERSONAL_ASSISTANT_SESSION, parentTurnId: 'user', taskId: 'verified', status: 'completed', childSessionId: 'child', childTurnId: 'sample' };
  const parent = { sessionId: PERSONAL_ASSISTANT_SESSION, tools: [definition], permissionMode: 'task_free', inputMessages: [], metadata: {} };
  const saved = { ...parent, sessionId: 'child', turnId: 'sample', metadata: { agentRole: 'child' } };
  const settings = { withhold: false, allow: true };
  registry.register({ definition, manifest: { effect_kind: 'observation', operation: 'test.read', risk: 'low', owner: 'fixture', dispatch_scope: 'session', mutating: false },
    decodeInput: v => v, execute: async context => { calls.push(context.input); return { start: '11:00' }; },
    authorize: () => settings.allow ? { kind: 'allow' } : { kind: 'deny', code: 'source_revoked', message: 'Revoked' },
    mcpHook: { readOnly: true, modelVisible: true, server: 'fixture', tool: 'read', call: () => assert.fail('Use normal tool admission') } });
  const record = id => executions.record({ protocol: 'bush.tool_call.v1', id, name: definition.name, argumentsText: '{"id":"g1"}' },
    { requestId: 'first', sessionId: 'child', turnId: 'sample', round: 1, ordinal: 0 }, { kind: 'returned', result: { start: '09:00' }, workspaceChanges: [] });
  record('actual-read');
  const collector = new EventCollector({ registry, executions, tasks: (owner, id) => id === task.taskId && owner === task.parentSessionId ? task : undefined,
    loadChild: async () => saved, messages: () => [], hooks: () => ({
      before: async () => ({ messages: [], ...(settings.withhold ? { blocked: 'Policy blocked the source.' } : {}) }), after: async () => ({ messages: [] }),
    }) });
  const rule = { source: 'collector', tool: definition.name, everySeconds: 30, taskId: task.taskId, code: 'return 1;' };
  return { collector, record, calls, rule, task, parent, saved, settings, registry };
}

test('replays the verified tool and inputs with live permission checks and hooks', async () => {
  const f = fixture(), signal = new AbortController().signal;
  const binding = await f.collector.resolve(f.rule, f.parent, PERSONAL_ASSISTANT_SESSION, 'user');
  assert.deepEqual(binding.sample, { start: '09:00' }); assert.deepEqual(f.calls, []);
  assert.deepEqual(await binding.read(signal), { start: '11:00' });
  assert.deepEqual(f.calls, [{ id: 'g1' }]);
  f.settings.allow = false; await assert.rejects(binding.read(signal), /source_revoked/);
  f.settings.allow = true; f.settings.withhold = true; await assert.rejects(binding.read(signal), /plugin_hook_blocked/);
  assert.equal(f.calls.length, 1);
});

test('source receipts must match the child, tool, current catalog and origin', async () => {
  const f = fixture(), resolve = (patch = {}) => f.collector.resolve({ ...f.rule, ...patch }, f.parent, PERSONAL_ASSISTANT_SESSION);
  await assert.rejects(resolve({ taskId: 'foreign' }), /owned/);
  f.record('another-read'); await assert.rejects(resolve(), /another-read/);
  await resolve({ toolCallId: 'actual-read' });
  f.saved.metadata.botSourceRef = 'other-user'; await assert.rejects(resolve(), /origin/); delete f.saved.metadata.botSourceRef;
  f.task.remote = { connectionId: 'another-host' }; await assert.rejects(resolve(), /local child/); delete f.task.remote;
  f.parent.tools = []; await assert.rejects(resolve({ toolCallId: 'actual-read' }), /execution scope/);
  f.registry.resolve(f.rule.tool).mcpHook.readOnly = false; await assert.rejects(resolve(), /read-only/);
});
