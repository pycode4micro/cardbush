import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const api = read('src', 'backend', 'api.ts');
const app = read('src', 'App.tsx');
const hook = read('src', 'hooks', 'useCardbushChat.ts');

assert.doesNotMatch(app, /fetchSessionScenes|fetchSessionScene\b/);
assert.doesNotMatch(api, /export async function fetchSessionScenes/);
assert.doesNotMatch(api, /export async function fetchSessionScene\b/);
assert.doesNotMatch(api, /SessionSceneRecord/);
assert.doesNotMatch(api, /export async function sendSceneEvent/);
assert.match(
  app,
  /latestCardlingSceneFromMessages/,
  'Interactive scenes must be projected from typed tool execution facts',
);

const helperStart = hook.indexOf('const refreshMeasuredContextWindowUsage');
const helperEndMatch = hook.slice(helperStart).match(/\r?\n\r?\n  useEffect\(/);
const helperEnd = helperEndMatch?.index == null ? -1 : helperStart + helperEndMatch.index;
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'missing context-window refresh helper');
const helper = hook.slice(helperStart, helperEnd);
assert.match(helper, /const turnId = latestTurn\?\.turnId\.trim\(\) \?\? ''/);
assert.match(helper, /if \(!turnId\)/, 'empty Sessions must not query context-window usage');
assert.match(helper, /contextWindowUsageRequestsRef\.current\.get\(requestKey\)/);
assert.equal(
  (hook.match(/fetchSessionContextWindowUsage\(/g) ?? []).length,
  1,
  'context-window usage must have one consolidated request path',
);
assert.match(hook, /refreshMeasuredContextWindowUsage\(sessionId, result\.latestTurn\)/);

console.log('Session runtime frontend contract tests passed');
