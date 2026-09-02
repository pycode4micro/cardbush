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

const { diffLanguageForPath, diffLineNumbers, diffLinePrefix, diffLineSource } = loaded.exports;

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
assert.deepEqual(
  JSON.parse(JSON.stringify(diffLineNumbers([
    { kind: 'hunk', text: '@@ -8,3 +11,4 @@' },
    { kind: 'context', text: ' const stable = true;' },
    { kind: 'deletion', text: '-const before = 1;' },
    { kind: 'addition', text: '+const after = 2;' },
    { kind: 'addition', text: '+const extra = 3;' },
  ]))),
  [
    { oldLine: null, newLine: null },
    { oldLine: 8, newLine: 11 },
    { oldLine: 9, newLine: null },
    { oldLine: null, newLine: 12 },
    { oldLine: null, newLine: 13 },
  ],
);

const renderer = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'tools', 'ToolChangeBlock.tsx'),
  'utf8',
);
assert.match(renderer, /lazy\(\(\) => import\('\.\/DiffSyntaxLines'\)\)/);
assert.match(renderer, /<Suspense fallback=\{<PlainDiffLines/);

const highlightedDiff = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'tools', 'DiffSyntaxLines.tsx'),
  'utf8',
);
const highlightedSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'tools', 'SourceSyntaxLines.tsx'),
  'utf8',
);
assert.match(highlightedDiff, /className="diff-line-number old"/);
assert.match(highlightedDiff, /className="diff-line-number new"/);
assert.match(highlightedSource, /className="source-line-number"/);
assert.match(highlightedSource, /diffLanguageForPath\(path\)/);

console.log('diff syntax highlighting contract tests passed');
