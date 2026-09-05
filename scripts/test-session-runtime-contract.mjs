import { readAppViewSources } from './helpers/app-view-sources.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import ts from 'typescript';

const root = process.cwd();
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const api = read('src', 'backend', 'api.ts');
const app = readAppViewSources();
const hook = read('src', 'hooks', 'useCardbushChat.ts');
const runtimeChat = read('src', 'backend', 'runtimeChat.ts');
const contextWindowUsage = read('src', 'backend', 'contextWindowUsage.ts');

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

const transpiled = ts.transpileModule(contextWindowUsage, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
});
const contextModule = { exports: {} };
vm.runInNewContext(transpiled.outputText, {
  module: contextModule,
  exports: contextModule.exports,
  Number,
  Math,
});
const { contextWindowMetrics } = contextModule.exports;
assert.deepEqual(
  structuredClone(contextWindowMetrics({
    inputTokens: 491_300,
    lastRequestInputTokens: 98_300,
  }, 256_000)),
  {
    usedTokens: 98_300,
    maxTokens: 256_000,
    remainingTokens: 157_700,
    usageRatio: 98_300 / 256_000,
  },
  'a multi-request Turn must display only its latest request, not cumulative billable input',
);
assert.equal(
  contextWindowMetrics({ inputTokens: 491_300 }, 256_000).usedTokens,
  undefined,
  'legacy cumulative input must never be mislabeled as context occupancy',
);
assert.deepEqual(
  structuredClone(contextWindowMetrics({
    lastRequestInputTokens: 352_729,
    contextWindowTokens: 400_000,
  }, 256_000)),
  {
    usedTokens: 352_729,
    maxTokens: 400_000,
    remainingTokens: 47_271,
    usageRatio: 352_729 / 400_000,
  },
  'persisted request usage must stay bound to the model window used for that request',
);
assert.match(runtimeChat, /contextWindowMetrics\(\s*committed\?\.usage/);
assert.match(runtimeChat, /case 'model_request_usage'/);
assert.match(runtimeChat, /lastRequestInputTokens: event\.payload\.inputTokens/);
assert.match(runtimeChat, /source: 'electron_runtime_model_request'/);
assert.match(api, /contextWindowMetrics\(latest\?\.usage\)/);
assert.doesNotMatch(api, /usedTokens:\s*context\.estimatedTokens/);

console.log('Session runtime frontend contract tests passed');
