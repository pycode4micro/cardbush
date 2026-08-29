import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import ts from 'typescript';

const source = fs.readFileSync(
  path.join(process.cwd(), 'src', 'backend', 'goalCommand.ts'),
  'utf8',
);
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const module = { exports: {} };
vm.runInNewContext(transpiled.outputText, { module, exports: module.exports });
const { parseGoalCommand } = module.exports;

assert.deepEqual({ ...parseGoalCommand('/goal ship the runtime') }, {
  objective: 'ship the runtime',
});
assert.deepEqual({ ...parseGoalCommand('/GOAL   完成迁移  ') }, { objective: '完成迁移' });
assert.equal(parseGoalCommand('/goal'), null);
assert.equal(parseGoalCommand('please reach this goal'), null);
assert.equal(parseGoalCommand('prefix /goal task'), null);

console.log('Explicit Goal command contract passed.');
