import assert from 'node:assert/strict';
import test from 'node:test';
import { agentToolActivity, toolExecutionSummarySchema } from '@cardbush/bush-protocol';
import { ToolExecutionStore } from '../dist/index.js';

test('history retains registration identity without loading employee or Team configuration', () => {
  const store = new ToolExecutionStore();
  for (const [name, key, kind] of [['subagent', 'agent', 'employee'], ['team', 'definition', 'team']]) {
    store.record({ protocol: 'bush.tool_call.v1', id: name, name, argumentsText: JSON.stringify({ action: 'save',
      [key]: { id: 'warehouse', name: '库存员', system_prompt: 'PRIVATE_PROMPT'.repeat(1000), settings: { model: 'private' },
        nodes: [{ prompt: 'PRIVATE_ASSIGNMENT' }] } }) }, { requestId: name, sessionId: 's', turnId: 't', round: 1, ordinal: 0 },
    { kind: 'returned', result: { [kind === 'employee' ? 'agent_id' : 'team_id']: 'warehouse', name: '库存员', revision: 1 }, workspaceChanges: [] });
  }
  const summaries = store.listTurnSummaries('s', 't').map(value => toolExecutionSummarySchema.parse(value));
  assert.deepEqual(summaries.map(item => item.agentActivity), [
    { kind: 'employee', action: 'save', id: 'warehouse', name: '库存员' },
    { kind: 'team', action: 'save', id: 'warehouse', name: '库存员' },
  ]);
  assert.doesNotMatch(JSON.stringify(summaries), /PRIVATE|settings|nodes|argumentsText/);
  assert.equal(summaries.every(item => item.resultAvailable), true);
});

test('registration, deletion, inspection and execution remain distinct, including failures', () => {
  const activity = (name, args, result) => agentToolActivity({ toolCall: { name, argumentsText: JSON.stringify(args) }, result });
  assert.equal(activity('subagent', { action: 'save', agent: { id: 'a', name: '采购员' } }).action, 'save');
  assert.equal(activity('subagent', { action: 'delete', agent_id: 'a' }).action, 'delete');
  assert.equal(activity('team', { action: 'run', team_id: 'a' }, { run_id: 'team-run' }), undefined);
  assert.equal(activity('team', { action: 'get', team_id: 'a' }, { definition: {}, revision: 1 }), undefined);
  assert.equal(activity('terminal_exec', {}, { agent_id: 'a', revision: 1 }), undefined);
  assert.deepEqual(activity('subagent', { agent_id: 'a' }, { taskId: 'task', agentName: '采购员' }),
    { kind: 'employee', action: 'run', id: 'a', name: '采购员', taskIds: ['task'] });
  assert.equal(activity('subagent', {}, { taskId: 'fork' }).kind, 'subagent');
  assert.equal(activity('subagent', {}, { taskId: 'role', agentProfileId: 'plugin:reviewer' }).kind, 'subagent');
  assert.equal(activity('subagent', { task_id: 'previous' }, { taskId: 'next', agentProfileId: 'registered:a' }).id, 'a');
});
