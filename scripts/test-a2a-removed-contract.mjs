import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const exists = (...parts) => fs.existsSync(path.join(root, ...parts));

const activeSources = [
  read('electron', 'main.ts'),
  read('electron', 'preload.ts'),
  read('src', 'types', 'electron.d.ts'),
  read('src', 'backend', 'api.ts'),
  read('src', 'features', 'chat', 'ConversationWorkSummary.tsx'),
  read('packages', 'bush-protocol', 'src', 'coordination.ts'),
  read('packages', 'bush-runtime', 'src', 'coordinationStore.ts'),
  read('packages', 'bush-runtime', 'src', 'coordinationTools.ts'),
].join('\n');

for (const retiredSurface of [
  'ProductA2AClient',
  'a2a:inspect',
  'a2a:dispatch',
  'a2aInspect',
  'a2aDispatch',
  'ExperimentalA2APanel',
  'linkedA2ATaskIds',
]) {
  assert.equal(
    activeSources.includes(retiredSurface),
    false,
    `retired A2A surface remains active: ${retiredSurface}`,
  );
}

for (const retiredFile of [
  ['electron', 'productA2A.ts'],
  ['src', 'features', 'chat', 'ExperimentalA2APanel.tsx'],
  ['public', 'a2a-icon.svg'],
  ['scripts', 'test-product-a2a-contract.mjs'],
]) {
  assert.equal(exists(...retiredFile), false, `retired A2A file remains: ${retiredFile.join('/')}`);
}

const protocol = read('packages', 'bush-protocol', 'src', 'coordination.ts');
const delegationProtocol = read('packages', 'bush-protocol', 'src', 'delegation.ts');
const teamProtocol = read('packages', 'bush-protocol', 'src', 'team.ts');
const coordinationTools = read('packages', 'bush-runtime', 'src', 'coordinationTools.ts');

assert.match(protocol, /CREATE_RUNTIME_GOAL_COMMAND/);
assert.match(protocol, /UPDATE_RUNTIME_GOAL_COMMAND/);
assert.match(coordinationTools, /UPDATE_GOAL_TOOL/);
assert.match(coordinationTools, /visibleToChild:\s*true/);
assert.match(delegationProtocol, /BUSH_SUBAGENT_TASK_PROTOCOL/);
assert.match(teamProtocol, /BUSH_TEAM_SNAPSHOT_PROTOCOL/);

const packageJson = JSON.parse(read('package.json'));
assert.equal(packageJson.scripts['test:product-a2a'], undefined);
assert.equal(packageJson.scripts['test:goal-a2a'], undefined);
assert.equal(typeof packageJson.scripts['test:goal'], 'string');
assert.match(read('electron-builder.yml'), /'!dist-electron\/productA2A\.js'/);

console.log('A2A removal boundary contract tests passed');
