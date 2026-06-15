import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import ts from 'typescript';

const sourcePath = path.join(
  process.cwd(),
  'src',
  'features',
  'chatMessages',
  'markdownFormat.ts',
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

const { normalizeMarkdownContentForDisplay } = module.exports;

const cases = [
  {
    name: 'windows path fence opener becomes code content',
    input: '文件路径:\n```C:\\Users\\wfang\\Desktop\\cardbush\\index.html\n```',
    expected: '文件路径:\n```text\nC:\\Users\\wfang\\Desktop\\cardbush\\index.html\n```',
  },
  {
    name: 'relative html path fence opener becomes code content',
    input: '文件路径:\n```index.html\n```',
    expected: '文件路径:\n```text\nindex.html\n```',
  },
  {
    name: 'file uri fence opener becomes code content',
    input: '文件路径:\n~~~file:///C:/Users/wfang/Desktop/cardbush/index.html\n~~~',
    expected: '文件路径:\n~~~text\nfile:///C:/Users/wfang/Desktop/cardbush/index.html\n~~~',
  },
  {
    name: 'shell command after language moves onto next line',
    input: '```powershell npm.cmd run build\n```',
    expected: '```powershell\nnpm.cmd run build\n```',
  },
  {
    name: 'normal language fence is unchanged',
    input: '```html\n<div>ok</div>\n```',
    expected: '```html\n<div>ok</div>\n```',
  },
];

for (const testCase of cases) {
  assert.equal(
    normalizeMarkdownContentForDisplay(testCase.input),
    testCase.expected,
    testCase.name,
  );
}

console.log(`markdown format tests passed (${cases.length})`);
