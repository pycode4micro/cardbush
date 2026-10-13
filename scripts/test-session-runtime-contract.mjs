import { readAppViewSources } from './helpers/app-view-sources.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import ts from 'typescript';
import * as protocol from '@cardbush/bush-protocol';

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
  require: name => { assert.equal(name, '@cardbush/bush-protocol'); return protocol; },
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
    totalTokens: 256_000,
    maxTokens: 64_000,
    remainingTokens: 0,
    usageRatio: 98_300 / 64_000,
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
    maxOutputTokens: 32_000,
  }, 256_000, 128_000)),
  {
    usedTokens: 352_729,
    totalTokens: 400_000,
    maxTokens: 333_952,
    remainingTokens: 0,
    usageRatio: 352_729 / 333_952,
  },
  'persisted request usage must stay bound to the model window used for that request',
);
assert.deepEqual(structuredClone(contextWindowMetrics({ lastRequestInputTokens: 145_045, contextWindowTokens: 400_000, maxOutputTokens: 128_000 })), {
  usedTokens: 145_045, totalTokens: 400_000, maxTokens: 141_952, remainingTokens: 0, usageRatio: 145_045 / 141_952,
}, 'live and historical occupancy use the compaction budget, not total context or hard input capacity');
assert.deepEqual(structuredClone(contextWindowMetrics(undefined, 500_000, 128_000)), { totalTokens: 500_000, maxTokens: 241_952 }, 'empty conversations still show their calculated budget');
assert.equal(contextWindowMetrics(undefined, 32_000).maxTokens, undefined, 'invalid configuration must not advertise a usable conversation window');
assert.match(runtimeChat, /contextWindowMetrics\(\s*committed\?\.usage/);
assert.match(runtimeChat, /case 'model_request_usage'/);
assert.match(runtimeChat, /lastRequestInputTokens: event\.payload\.inputTokens/);
assert.match(runtimeChat, /source: 'electron_runtime_model_request'/);
assert.match(api, /contextWindowMetrics\(latest\?\.usage\)/);
assert.doesNotMatch(api, /usedTokens:\s*context\.estimatedTokens/);

console.log('Session runtime frontend contract tests passed');
