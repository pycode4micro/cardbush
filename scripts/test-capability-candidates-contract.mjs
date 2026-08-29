import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import ts from 'typescript';

const sourcePath = path.join(process.cwd(), 'src', 'backend', 'capabilityCandidates.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
});
const module = { exports: {} };
vm.runInNewContext(transpiled.outputText, {
  module,
  exports: module.exports,
  Date,
  Number,
});

const { capabilityCandidatesFromPayload } = module.exports;
const update = plain(capabilityCandidatesFromPayload({
  protocol: 'bush.capability_candidates.v1',
  session_id: 'session-contract',
  turn_id: 'turn-contract',
  authority: 'retrieval_evidence_only',
  selection: 'model_decides',
  timestamp: '2026-08-11T00:00:00Z',
  skills: [{
    name: 'xlsx',
    type: 'skill',
    description: 'Workbook workflow',
    score: 1,
    path: 'C:/skills/xlsx/SKILL.md',
    matched_fields: ['identity'],
  }],
  tools: [{
    name: 'example_extension',
    type: 'tool',
    description: 'Example extension capability',
    score: 0.75,
    matched_fields: ['capability'],
  }],
}));

assert.equal(update.sessionId, 'session-contract');
assert.equal(update.turnId, 'turn-contract');
assert.equal(update.authority, 'retrieval_evidence_only');
assert.equal(update.selection, 'model_decides');
assert.deepEqual(update.skills[0], {
  name: 'xlsx',
  type: 'skill',
  description: 'Workbook workflow',
  score: 1,
  path: 'C:/skills/xlsx/SKILL.md',
  matchedFields: ['identity'],
});
assert.deepEqual(update.tools[0], {
  name: 'example_extension',
  type: 'tool',
  description: 'Example extension capability',
  score: 0.75,
  matchedFields: ['capability'],
});

const malformed = plain(capabilityCandidatesFromPayload({
  skills: [null, {}, { name: '  ' }],
  tools: 'not-an-array',
}));
assert.deepEqual(malformed.skills, []);
assert.deepEqual(malformed.tools, []);

const runtimeRailSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'composer', 'ComposerRuntimeRail.tsx'),
  'utf8',
);
const appSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'App.tsx'),
  'utf8',
);
const chatHookSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'hooks', 'useCardbushChat.ts'),
  'utf8',
);
assert.doesNotMatch(runtimeRailSource, /capabilityCandidates|能力建议|候选能力/);
assert.doesNotMatch(appSource, /activeCapabilityCandidates|capabilityCandidates/);
assert.doesNotMatch(chatHookSource, /capabilityCandidatesByConversation/);

console.log('capability candidates contract tests passed');

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}
