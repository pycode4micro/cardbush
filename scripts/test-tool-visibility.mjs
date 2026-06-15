import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import ts from 'typescript';

const sourcePath = path.join(process.cwd(), 'src', 'backend', 'toolVisibility.ts');
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

const {
  applyDisabledToolsToMetadata,
  normalizeDisabledTools,
  standardImageInputToolDefaultName,
} = module.exports;

assert.equal(standardImageInputToolDefaultName, 'inject_image_input');
assert.equal(normalizeDisabledTools(undefined), undefined);
assert.equal(normalizeDisabledTools(['', '   ']), undefined);
assertJsonEqual(
  normalizeDisabledTools([
    ' inject_image_input ',
    'terminal_exec',
    'inject_image_input',
  ]),
  ['inject_image_input', 'terminal_exec'],
);

const metadata = {};
applyDisabledToolsToMetadata(metadata, [' inject_image_input ', '', 'inject_image_input']);
assertJsonEqual(metadata, {
  disabled_tools: ['inject_image_input'],
  disabledTools: ['inject_image_input'],
});

const emptyMetadata = {};
applyDisabledToolsToMetadata(emptyMetadata, []);
assertJsonEqual(emptyMetadata, {});

console.log('tool visibility tests passed');

function assertJsonEqual(actual, expected) {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}
