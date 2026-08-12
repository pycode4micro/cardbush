import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import ts from 'typescript';

const sourcePath = path.join(process.cwd(), 'src', 'backend', 'taskPlan.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
});
const module = { exports: {} };
vm.runInNewContext(transpiled.outputText, { module, exports: module.exports, Set });

const { taskPlanFromPayload, taskPlanUpdateFromExecutionPayload } = module.exports;
const validPlan = {
  protocol: 'bush.task_plan.v1',
  plan_id: 'plan-contract',
  session_id: 'session-contract',
  nodes: [
    { id: 'node-inspect', step: 'Inspect the implementation', status: 'completed' },
    { id: 'node-test', step: 'Run integration tests', status: 'in_progress' },
    { id: 'node-persist', step: 'Verify persistence', status: 'pending' },
  ],
  explanation: 'Progress reported by the model.',
  active: true,
};

assert.deepEqual(
  plain(taskPlanFromPayload(validPlan, 'session-contract')),
  {
    protocol: 'bush.task_plan.v1',
    planId: 'plan-contract',
    sessionId: 'session-contract',
    nodes: validPlan.nodes,
    explanation: 'Progress reported by the model.',
    active: true,
  },
);
assert.deepEqual(
  plain(taskPlanUpdateFromExecutionPayload({
    kind: 'plan',
    turn_id: 'turn-contract',
    plan: validPlan,
  }, 'session-contract')),
  {
    turnId: 'turn-contract',
    plan: {
      protocol: 'bush.task_plan.v1',
      planId: 'plan-contract',
      sessionId: 'session-contract',
      nodes: validPlan.nodes,
      explanation: 'Progress reported by the model.',
      active: true,
    },
  },
);

const attacks = [
  { ...validPlan, protocol: 'bush.task_plan.v0' },
  { ...validPlan, session_id: 'different-session' },
  { ...validPlan, root_goal: 'take acceptance authority' },
  { ...validPlan, nodes: [{ ...validPlan.nodes[0], phase: 'write' }] },
  { ...validPlan, nodes: [{ ...validPlan.nodes[0], id: 'x'.repeat(161) }] },
  {
    ...validPlan,
    nodes: [
      { step: 'one', status: 'in_progress' },
      { step: 'two', status: 'in_progress' },
    ],
  },
  { ...validPlan, nodes: [{ step: 'blocked', status: 'blocked' }] },
  { ...validPlan, nodes: [] },
  { ...validPlan, active: false },
  { ...validPlan, explanation: 'x'.repeat(1201) },
];
for (const attack of attacks) {
  assert.equal(taskPlanFromPayload(attack, 'session-contract'), null);
}
assert.equal(
  taskPlanUpdateFromExecutionPayload({
    kind: 'loop_transition',
    turn_id: 'turn-contract',
    plan: validPlan,
  }, 'session-contract'),
  null,
);
assert.equal(
  taskPlanUpdateFromExecutionPayload({
    kind: 'plan',
    turn_id: '',
    plan: validPlan,
  }, 'session-contract'),
  null,
);

console.log('task plan contract tests passed');

function plain(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}
