import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import ts from 'typescript';

const read = (...parts) => fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
const api = read('src', 'backend', 'api.ts');
const panel = read('src', 'features', 'chat', 'ExperimentalA2APanel.tsx');
const goalState = read('src', 'shared', 'goalState.ts');
const hook = read('src', 'hooks', 'useCardbushChat.ts');
const runtimeChat = read('src', 'backend', 'runtimeChat.ts');
const desktopTypes = read('src', 'types', 'electron.d.ts');

assert.doesNotMatch(api, /\/v1\/experimental|\/v1\/turns/);
assert.match(api, /runtime\.client\.getGoal\(normalized\)/);
assert.match(api, /runtime\.client\.updateGoal\(\{/);
assert.match(api, /window\.cardbushDesktop\?\.a2aInspect/);
assert.match(api, /window\.cardbushDesktop\?\.a2aDispatch/);
assert.match(api, /streamRuntimeTurnEvents\(request\)/);
assert.match(runtimeChat, /runtime\.client\.events\(\{/);
assert.match(runtimeChat, /afterSequence: request\.afterSequence/);
assert.match(runtimeChat, /lastEventId: request\.lastEventId/);
assert.match(desktopTypes, /a2aInspect:/);
assert.match(desktopTypes, /a2aDispatch:/);

assert.doesNotMatch(panel, /BUSH_EXPERIMENTAL_GOAL_A2A_ENABLED/);
assert.match(panel, /A2A 出站客户端仅在 CardBush 桌面版中提供/);
assert.match(panel, /fetchExperimentalGoalA2AStatus/);
assert.match(hook, /fetchExperimentalGoals\(normalized\)/);
assert.match(hook, /fetchExperimentalGoalA2AStatus\(\)/);
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
  linkedA2ATaskIds: [],
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

console.log('typed Goal and A2A contract tests passed');
