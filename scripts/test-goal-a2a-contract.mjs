import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const api = fs.readFileSync(path.join(process.cwd(), 'src', 'backend', 'api.ts'), 'utf8');
const panel = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'chat', 'ExperimentalA2APanel.tsx'),
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
assert.match(panel, /activeGoal\?\.goalId/);
assert.match(panel, /BUSH_EXPERIMENTAL_GOAL_A2A_ENABLED=true/);
assert.match(panel, /fetchExperimentalGoalA2AStatus/);

console.log('goal and A2A frontend contract tests passed');
