import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import ts from 'typescript';

const read = (...parts) => fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
const api = read('src', 'backend', 'api.ts');
const goalState = read('src', 'shared', 'goalState.ts');
const hook = read('src', 'hooks', 'useCardbushChat.ts');
const runtimeChat = read('src', 'backend', 'runtimeChat.ts');

assert.doesNotMatch(api, /\/v1\/experimental|\/v1\/turns/);
assert.match(api, /runtime\.client\.getGoal\(normalized\)/);
assert.match(api, /runtime\.client\.updateGoal\(\{/);
assert.match(api, /export async function fetchGoalRuntimeStatus/);
assert.match(api, /streamRuntimeTurnEvents\(request\)/);
assert.match(runtimeChat, /runtime\.client\.events\(\{/);
assert.match(runtimeChat, /afterSequence: request\.afterSequence/);
assert.match(runtimeChat, /lastEventId: request\.lastEventId/);

assert.match(hook, /fetchExperimentalGoals\(normalized\)/);
assert.match(hook, /fetchGoalRuntimeStatus\(\)/);
assert.match(hook, /applyGoalExecution\(sessionId, execution\)/);
assert.match(hook, /streamTurnEvents\(\{/);
assert.match(hook, /fetchPendingInteraction\(sessionId\)/);
assert.match(hook, /Promise\.allSettled/);

const transpiled = ts.transpileModule(goalState, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const goalModule = { exports: {} };
vm.runInNewContext(transpiled.outputText, {
  module: goalModule,
  exports: goalModule.exports,
  require: () => ({}),
  Date,
  JSON,
});
const { applyGoalToolUpdate, goalToolUpdateFromExecution, isGoalSelfCheckMessage } = goalModule.exports;
const goal = {
  protocol: 'bush.goal.v1',
  goalId: 'goal-1',
  sessionId: 'session-1',
  objective: 'ship the feature',
  status: 'active',
  statusReason: '',
  consumedTokens: 12,
  revision: 2,
  createdAt: '2026-08-14T00:00:00Z',
  updatedAt: '2026-08-14T00:00:00Z',
};
const execution = (decision, status, reason) => ({
  id: `tool-${decision}`,
  name: 'functions.update_goal',
  state: 'completed',
  summary: '',
  output: JSON.stringify({
    goal_update: { goal_id: 'goal-1', session_id: 'session-1', decision, status, reason },
  }),
  success: true,
  createdAt: '2026-08-14T00:00:01Z',
  metadata: {},
});

const continued = goalToolUpdateFromExecution(execution('continue', 'active', 'more work remains'));
assert.equal(continued.decision, 'continue');
assert.equal(applyGoalToolUpdate(goal, continued).status, 'active');
const completed = goalToolUpdateFromExecution(execution('complete', 'complete', 'verified by tests'));
assert.equal(applyGoalToolUpdate(goal, completed).statusReason, 'verified by tests');
const blocked = goalToolUpdateFromExecution(execution('blocked', 'blocked', 'credential missing'));
assert.equal(applyGoalToolUpdate(goal, blocked).status, 'blocked');

assert.equal(isGoalSelfCheckMessage({
  id: 'runtime-user', role: 'user', content: 'call update_goal',
  metadata: { runtime_user_label: 'goal_self_check' },
}), true);
assert.equal(isGoalSelfCheckMessage({
  id: 'real-user', role: 'user', content: 'continue', metadata: {},
}), false);

console.log('typed Goal contract tests passed');
