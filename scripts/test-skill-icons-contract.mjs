import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import ts from 'typescript';

const kindSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'skills', 'skillIconKind.ts'),
  'utf8',
);
const transpiled = ts.transpileModule(kindSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
});
const loaded = { exports: {} };
vm.runInNewContext(transpiled.outputText, {
  module: loaded,
  exports: loaded.exports,
});
const { skillIconKind } = loaded.exports;

const skill = (name, description = '') => ({
  name,
  description,
  descriptionZh: '',
  path: `skills/${name}/SKILL.md`,
});

for (const [name, expected] of [
  ['documents:documents', 'document'],
  ['spreadsheets:Spreadsheets', 'spreadsheet'],
  ['presentations:Presentations', 'presentation'],
  ['pdf:pdf', 'pdf'],
  ['imagegen', 'image'],
  ['visualize:visualize', 'image'],
  ['browser:control-in-app-browser', 'web'],
  ['computer-use:computer-use', 'computer'],
  ['codex-security', 'security'],
  ['plugin-management:plugin-management', 'integration'],
  ['skill-creator', 'tooling'],
  ['template-creator', 'design'],
  ['database-query', 'data'],
  ['openai-docs', 'research'],
  ['subagent-workflow', 'workflow'],
  ['code-review', 'code'],
  ['unclassified-capability', 'generic'],
]) {
  assert.equal(skillIconKind(skill(name)), expected, `${name} should use ${expected}`);
}

const iconSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'skills', 'SkillIcon.tsx'),
  'utf8',
);
const composerSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'composer', 'Composer.tsx'),
  'utf8',
);
const panelSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'panels', 'FeatureContentPanel.tsx'),
  'utf8',
);
const styles = fs.readFileSync(
  path.join(process.cwd(), 'src', 'styles', 'app.css'),
  'utf8',
);

assert.match(iconSource, /const iconsByKind: Record<SkillIconKind, LucideIcon>/);
assert.match(composerSource, /<SkillIcon skill=\{skill\} compact \/>/);
assert.match(panelSource, /<SkillIcon skill=\{skill\} \/>/);
assert.match(panelSource, /<SkillIcon skill=\{detail\} compact \/>/);
assert.match(styles, /\.skill-icon-spreadsheet\s*\{/);
assert.match(styles, /\.skill-icon-presentation\s*\{/);
assert.match(styles, /\.skill-icon-pdf\s*\{/);

console.log('skill icon contract tests passed');
