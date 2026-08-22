import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import ts from 'typescript';

const api = fs.readFileSync(path.join(process.cwd(), 'src', 'backend', 'api.ts'), 'utf8');
const panel = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'chat', 'ExperimentalA2APanel.tsx'),
  'utf8',
);
const goalState = fs.readFileSync(
  path.join(process.cwd(), 'src', 'shared', 'goalState.ts'),
  'utf8',
);
const hook = fs.readFileSync(
  path.join(process.cwd(), 'src', 'hooks', 'useCardbushChat.ts'),
  'utf8',
);
const app = fs.readFileSync(path.join(process.cwd(), 'src', 'App.tsx'), 'utf8');
const toolBlock = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'tools', 'ToolExecutionBlock.tsx'),
  'utf8',
);
const runtimeRail = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'composer', 'ComposerRuntimeRail.tsx'),
  'utf8',
);
const composer = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'composer', 'Composer.tsx'),
  'utf8',
);

for (const endpoint of [
  '/v1/experimental/goal-a2a',
  '/v1/experimental/goals',
  '/v1/experimental/a2a/inspect',
  '/v1/experimental/a2a/dispatch',
]) {
  assert.ok(api.includes(endpoint), `missing experimental endpoint: ${endpoint}`);
}

assert.match(api, /expected_revision:\s*request\.expectedRevision/);
assert.match(api, /goal_id:\s*request\.goalId/);
assert.match(api, /mergedIntoCore:/);
assert.match(api, /latestTurn\?: SessionLatestTurn/);
assert.match(panel, /BUSH_EXPERIMENTAL_GOAL_A2A_ENABLED=true/);
assert.match(panel, /fetchExperimentalGoalA2AStatus/);
assert.doesNotMatch(panel, /experimental-goal-card/);
assert.doesNotMatch(panel, /createExperimentalGoal|updateExperimentalGoal|fetchExperimentalGoals/);

assert.match(hook, /fetchExperimentalGoals\(normalized\)/);
assert.match(hook, /fetchExperimentalGoalA2AStatus\(\)/);
assert.match(hook, /status\.enabled === true/);
assert.match(hook, /void refreshGoal\(sessionId\)/);
assert.match(hook, /applyGoalExecution\(sessionId, execution\)/);
assert.match(hook, /isGoalSelfCheckMessage/);
assert.match(hook, /goalPollingDelayMs\(\)/);
assert.match(hook, /document\.visibilityState === 'hidden' \? 7_000 : 2_000/);
assert.match(hook, /fetchSessionMessages\(sessionId, \{ includeSuperseded: true \}\)/);
assert.match(api, /export async function streamTurnEvents/);
assert.match(api, /\/v1\/turns\/\$\{encodeURIComponent\(turnId\)\}\/events/);
assert.match(api, /Last-Event-ID/);
assert.match(api, /onEventCursor/);
assert.match(hook, /subscribeGoalTurn\(sessionId, sessionResult\.latestTurn\.turnId\)/);
assert.match(hook, /ensureBackgroundTurnAssistant/);
assert.match(hook, /streamTurnEvents\(\{/);
assert.match(hook, /afterSequence: initialCursor\.sequence/);
assert.match(hook, /lastEventId: initialCursor\.lastEventId/);
assert.match(hook, /fetchPendingInteraction\(sessionId\)/);
assert.match(hook, /mergePolledMessagesPreservingLocalState/);
assert.match(hook, /if \(loaded\.length === 0\) \{\s*return existing;/);
assert.match(hook, /Promise\.allSettled/);
assert.match(hook, /updateExperimentalGoal\(\{/);
assert.match(hook, /status: 'cancelled'/);
const cancelGoalStart = hook.indexOf('const cancelActiveGoal');
const stopLatestTurn = hook.indexOf('await stopTurn(latestTurn.turnId)', cancelGoalStart);
const cancelGoalRequest = hook.indexOf('await updateExperimentalGoal', cancelGoalStart);
assert.ok(
  cancelGoalStart >= 0 && stopLatestTurn > cancelGoalStart && cancelGoalRequest > stopLatestTurn,
  'Goal cancellation must stop a running background turn before cancelling the Goal',
);
assert.match(
  hook,
  /onFinalAssistantText:[\s\S]*?markLocalAssistantTurnCompleted/,
  'assistant completion must remain tied to the final done callback',
);
assert.doesNotMatch(app, /<GoalStatusCard/);
assert.match(app, /goal=\{activeGoal\}/);
assert.match(app, /goalAvailable=\{chat\.goalAvailable\}/);
assert.match(app, /goalWaiting=\{chat\.activeGoalWaiting\}/);
assert.match(app, /goalRounds=\{activeGoalRounds\}/);
assert.match(toolBlock, /goalToolUpdateFromExecution/);
assert.match(toolBlock, /<GoalUpdateNotice/);
assert.match(runtimeRail, /runtime-goal-detail/);
assert.match(runtimeRail, /runtime-goal-rounds/);
assert.match(runtimeRail, /goalTokenLabel/);
assert.match(runtimeRail, /runtime-goal-cancel/);
assert.match(runtimeRail, /等待后端继续/);
assert.match(runtimeRail, /composer-runtime-screen \$\{currentRailItem\.kind\}/);
assert.match(runtimeRail, /className=\{`runtime-screen-line \$\{item\.kind\}`\}/);
assert.match(runtimeRail, /item\.kind === 'processing'/);
assert.match(runtimeRail, /running \? <LoaderCircle size=\{13\} \/> : <Target size=\{13\} \/>/);
assert.match(runtimeRail, /goal\.status === 'active'/);
assert.match(runtimeRail, /isLiveContinuation/);
assert.match(runtimeRail, /目标/);
assert.match(runtimeRail, /计划/);
assert.match(composer, /commands\.filter\(\(command\) => command\.id !== '\/goal'\)/);

const transpiled = ts.transpileModule(goalState, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
});
const goalModule = { exports: {} };
vm.runInNewContext(transpiled.outputText, {
  module: goalModule,
  exports: goalModule.exports,
  require: () => ({}),
  Date,
  JSON,
});
const {
  applyGoalToolUpdate,
  goalToolUpdateFromExecution,
  isGoalSelfCheckMessage,
} = goalModule.exports;
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
    goal_update: {
      goal_id: 'goal-1',
      session_id: 'session-1',
      decision,
      status,
      reason,
    },
  }),
  success: true,
  createdAt: '2026-08-14T00:00:01Z',
  metadata: {},
});

const continued = goalToolUpdateFromExecution(
  execution('continue', 'active', 'more work remains'),
);
assert.equal(continued.decision, 'continue');
assert.equal(continued.status, 'active');
assert.equal(continued.reason, 'more work remains');
assert.equal(applyGoalToolUpdate(goal, continued).status, 'active');

const completed = goalToolUpdateFromExecution(
  execution('complete', 'complete', 'verified by tests'),
);
assert.equal(completed.decision, 'complete');
assert.equal(applyGoalToolUpdate(goal, completed).statusReason, 'verified by tests');

const blocked = goalToolUpdateFromExecution(
  execution('blocked', 'blocked', 'external credential is missing'),
);
assert.equal(blocked.status, 'blocked');
assert.equal(applyGoalToolUpdate(goal, blocked).status, 'blocked');

assert.equal(isGoalSelfCheckMessage({
  id: 'runtime-user',
  role: 'user',
  content: 'call update_goal',
  metadata: { runtime_user_label: 'goal_self_check' },
}), true);
assert.equal(isGoalSelfCheckMessage({
  id: 'goal-auto-user',
  role: 'user',
  content: 'call update_goal',
  metadata: { goal_auto_continuation: true },
}), true);
assert.equal(isGoalSelfCheckMessage({
  id: 'real-user',
  role: 'user',
  content: 'continue',
  metadata: {},
}), false);

console.log('goal and A2A frontend contract tests passed');
