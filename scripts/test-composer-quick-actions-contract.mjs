import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import ts from 'typescript';

const composerPath = path.join(
  process.cwd(),
  'src',
  'features',
  'composer',
  'Composer.tsx',
);
const source = fs.readFileSync(composerPath, 'utf8');
const slashBlock = source.match(
  /const slashCommands[\s\S]*?const commandItems/,
)?.[0] ?? '';

assert.ok(slashBlock, 'slash quick-action block is missing');
assert.deepEqual(
  [...slashBlock.matchAll(/id:\s*'([^']+)'/g)].map((match) => match[1]),
  ['/model', '/goal', '/skill', '/new'],
);
assert.match(slashBlock, /模型管理/);
assert.match(slashBlock, /目标/);
assert.match(slashBlock, /技能/);
assert.match(slashBlock, /新会话/);
const goalCommandBlock = slashBlock.match(
  /id:\s*'\/goal'[\s\S]*?searchText:\s*'\/goal 目标 goal'/,
)?.[0] ?? '';
assert.ok(goalCommandBlock, 'the /goal quick action is missing');
assert.match(
  goalCommandBlock,
  /value:\s*'\/goal '/,
  'selecting /goal must insert it into the composer instead of opening a panel',
);
assert.doesNotMatch(
  goalCommandBlock,
  /run:/,
  'the /goal quick action must not bypass the conversation',
);
assert.doesNotMatch(slashBlock, /title:\s*['"`]\//);
assert.doesNotMatch(source, /ComposerCommandMode\s*=\s*[^;]*mention/);
assert.doesNotMatch(source, /mentionMatch|mentionCommands|输入 @|Type @/);
assert.match(
  source,
  /`\$\{selectedModelConfig\.modelName\} · \$\{selectedModelConfig\.provider\}`/,
  'the compact model label must place the provider name last',
);

const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
});
const module = { exports: {} };
vm.runInNewContext(transpiled.outputText, {
  module,
  exports: module.exports,
  require: () => ({}),
  window: {},
  console,
});
const { detectComposerCommand } = module.exports;
const detect = (value, caret = value.length) => plain(detectComposerCommand(value, caret));

assert.deepEqual(detect('/'), {
  mode: 'slash',
  start: 0,
  end: 1,
  query: '',
});
assert.deepEqual(detect('/model'), {
  mode: 'slash',
  start: 0,
  end: 6,
  query: 'model',
});
assert.deepEqual(detect('请处理 /go'), {
  mode: 'slash',
  start: 4,
  end: 7,
  query: 'go',
});
assert.equal(detect('请处理/go'), null);
assert.equal(detect('请处理\n/go'), null);
assert.equal(detect('请处理\t/go'), null);
assert.equal(detect('@file'), null);
assert.equal(detect('请查看 @file'), null);

console.log('composer quick-action contract tests passed');

function plain(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}
