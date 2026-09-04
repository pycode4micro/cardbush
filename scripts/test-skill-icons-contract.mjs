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
  ['finance-analysis', 'finance'],
  ['internal-comms', 'communication'],
  ['scheduled-delivery', 'delivery'],
  ['transport-delivery', 'delivery'],
  ['imagegen', 'image'],
  ['visualize:visualize', 'image'],
  ['browser:control-in-app-browser', 'web'],
  ['computer-use:computer-use', 'computer'],
  ['codex-security', 'security'],
  ['plugin-management:plugin-management', 'integration'],
  ['skill-creator', 'tooling'],
  ['skill-manager', 'tooling'],
  ['template-creator', 'design'],
  ['cardbush-style-management', 'design'],
  ['database-query', 'data'],
  ['openai-docs', 'research'],
  ['subagent-workflow', 'workflow'],
  ['code-review', 'code'],
  ['unclassified-capability', 'generic'],
]) {
  assert.equal(skillIconKind(skill(name)), expected, `${name} should use ${expected}`);
}

// Skill identity is authoritative. Negative examples and incidental file types in a
// description must not steal the icon from the package that owns the capability.
assert.equal(
  skillIconKind(skill('xlsx', 'Spreadsheet output, not a document, presentation, or PDF.')),
  'spreadsheet',
);
assert.equal(
  skillIconKind(skill('docx', 'Word documents only. Do not use for PDFs or spreadsheets.')),
  'document',
);
assert.equal(
  skillIconKind(skill('pdf', 'Read PDF files and extract text, images, and tables.')),
  'pdf',
);
assert.equal(
  skillIconKind(skill('unclassified-capability', 'Do not create a PDF, spreadsheet, or presentation.')),
  'generic',
);
assert.equal(
  skillIconKind({
    ...skill('renamed-capability', 'Not a presentation.'),
    path: 'C:\\skills\\xlsx\\SKILL.md',
  }),
  'spreadsheet',
);
assert.equal(
  skillIconKind({
    ...skill('a11y-debugging'),
    path: 'assets/plugins/chrome/runtime/chrome-devtools-mcp/skills/a11y-debugging/SKILL.md',
  }),
  'web',
);

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

assert.match(iconSource, /const generatedLogos: Record<SkillIconKind, string>/);
assert.match(iconSource, /skill\.logoPath \? fileUrl\(skill\.logoPath\) : generatedLogo/);
assert.match(iconSource, /skill\.logoDarkPath \|\| skill\.logoPath/);
assert.match(iconSource, /import documentLogo from '[^']*\/document\.svg'/);
assert.match(iconSource, /import spreadsheetLogo from '[^']*\/spreadsheet\.svg'/);
assert.match(iconSource, /import presentationLogo from '[^']*\/presentation\.svg'/);
assert.match(iconSource, /import pdfLogo from '[^']*\/pdf\.svg'/);
assert.match(iconSource, /document: documentLogo/);
assert.match(iconSource, /spreadsheet: spreadsheetLogo/);
assert.match(iconSource, /presentation: presentationLogo/);
assert.match(iconSource, /pdf: pdfLogo/);
for (const kind of [
  'document', 'spreadsheet', 'presentation', 'pdf', 'image', 'web', 'computer',
  'finance', 'communication', 'delivery', 'security', 'integration', 'tooling',
  'design', 'data', 'research', 'workflow',
  'code', 'generic',
]) {
  assert.ok(fs.existsSync(path.join(process.cwd(), 'src', 'assets', 'skill-logos', `${kind}.svg`)), `${kind} Skill logo must exist`);
}
assert.match(composerSource, /<SkillIcon skill=\{skill\} compact \/>/);
assert.match(panelSource, /<SkillIcon skill=\{skill\} \/>/);
assert.match(panelSource, /<SkillIcon skill=\{detail\} compact \/>/);
assert.match(styles, /\.skill-icon-spreadsheet\s*\{/);
assert.match(styles, /\.skill-icon-presentation\s*\{/);
assert.match(styles, /\.skill-icon-pdf\s*\{/);
assert.match(styles, /\.skill-icon-finance\s*\{/);
assert.match(styles, /\.skill-icon-communication\s*\{/);
assert.match(styles, /\.skill-icon-delivery\s*\{/);
assert.match(styles, /\.skill-icon img\s*\{/);

console.log('skill icon contract tests passed');
