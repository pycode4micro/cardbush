import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import ts from 'typescript';

const source = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'tools', 'diffSyntax.ts'),
  'utf8',
);
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
});
const loaded = { exports: {} };
vm.runInNewContext(transpiled.outputText, {
  module: loaded,
  exports: loaded.exports,
  Object,
  RegExp,
  String,
});

const { diffLanguageForPath, diffLinePrefix, diffLineSource } = loaded.exports;

assert.equal(diffLanguageForPath('src/App.tsx'), 'tsx');
assert.equal(diffLanguageForPath('backend/models.py'), 'python');
assert.equal(diffLanguageForPath('C:\\repo\\package.json'), 'json');
assert.equal(diffLanguageForPath('README.md'), 'markdown');
assert.equal(diffLanguageForPath('unknown.binary'), 'plain');
assert.equal(diffLinePrefix({ kind: 'addition', text: '+const ready = true;' }), '+');
assert.equal(diffLinePrefix({ kind: 'deletion', text: '-const ready = false;' }), '-');
assert.equal(diffLineSource({ kind: 'addition', text: '+const ready = true;' }), 'const ready = true;');
assert.equal(diffLineSource({ kind: 'context', text: '  return ready;' }), ' return ready;');
assert.equal(diffLineSource({ kind: 'hunk', text: '@@ -1,2 +1,2 @@' }), '@@ -1,2 +1,2 @@');

const renderer = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'tools', 'ToolChangeBlock.tsx'),
  'utf8',
);
assert.match(renderer, /lazy\(\(\) => import\('\.\/DiffSyntaxLines'\)\)/);
assert.match(renderer, /<Suspense fallback=\{<PlainDiffLines/);

console.log('diff syntax highlighting contract tests passed');
