import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import ts from 'typescript';

const hookPath = path.join(process.cwd(), 'src', 'hooks', 'useCardbushChat.ts');
const hookSource = fs.readFileSync(hookPath, 'utf8');
const transpiled = ts.transpileModule(hookSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
});
const hookModule = { exports: {} };
vm.runInNewContext(transpiled.outputText, {
  module: hookModule,
  exports: hookModule.exports,
  require: () => ({}),
});

const { modelConfigFor, selectedModelName } = hookModule.exports;
const configs = [
  {
    id: 'deepseek-config',
    provider: 'deepseek',
    modelName: 'deepseek-v4-flash',
    apiKey: 'first-key',
    baseUrl: 'https://api.deepseek.com',
  },
  {
    id: 'volcengine-config',
    provider: 'volcengine',
    modelName: 'deepseek-v4-flash',
    apiKey: 'second-key',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
  },
];

assert.equal(modelConfigFor(configs, 'deepseek-config').provider, 'deepseek');
assert.equal(modelConfigFor(configs, 'volcengine-config').provider, 'volcengine');
assert.equal(
  modelConfigFor(configs, 'volcengine-config').baseUrl,
  'https://ark.cn-beijing.volces.com/api/coding/v3',
);
assert.equal(selectedModelName(configs, 'volcengine-config'), 'deepseek-v4-flash');

const settingsSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'SettingsView.tsx'),
  'utf8',
);
assert.match(settingsSource, /selected=\{selectedModel === config\.id\}/);
assert.match(settingsSource, /onUseModel\(config\.id\)/);

const composerSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'composer', 'Composer.tsx'),
  'utf8',
);
assert.match(composerSource, /key=\{config\.id\}/);
assert.match(composerSource, /<small>\{config\.provider\}<\/small>/);

console.log('model selection identity contract tests passed');
