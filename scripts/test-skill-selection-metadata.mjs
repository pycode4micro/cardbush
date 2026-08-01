import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import ts from 'typescript';

const sourcePath = path.join(
  process.cwd(),
  'src',
  'backend',
  'skillSelectionMetadata.ts',
);
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
});

const { applyAllowedSkillsToRequest } = module.exports;

const body = {};
const metadata = { source: 'cardbush_electron', skills: ['legacy-all-skills'] };
applyAllowedSkillsToRequest(body, metadata, ['code-init', 'code-debug']);
assertJsonEqual(body, {
  allowed_skills: ['code-init', 'code-debug'],
});
assertJsonEqual(metadata, {
  source: 'cardbush_electron',
  allowed_skills: ['code-init', 'code-debug'],
});

const emptyBody = {};
const emptyMetadata = { source: 'cardbush_electron' };
applyAllowedSkillsToRequest(emptyBody, emptyMetadata, undefined);
assertJsonEqual(emptyBody, {});
assertJsonEqual(emptyMetadata, { source: 'cardbush_electron' });

console.log('skill selection metadata tests passed');

function assertJsonEqual(actual, expected) {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}
