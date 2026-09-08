import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  legacyProductSkillMigrationMarker,
  listProductSkills,
  migrateLegacyProductSkills,
  readProductSkill,
} from '../dist-electron/productSkills.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cardbush-product-skills-'));
try {
  const management = await readProductSkill([path.resolve('assets/skills')], 'cardbush-plugin-management');
  assert.equal(management.name, 'cardbush-plugin-management');
  assert.ok(management.description);
  assert.ok((await fs.readFile(path.join(management.packageDir, 'references/plugin-contract.md'), 'utf8')).length > 0);
  // Read the bundled catalog through the product loader, preserving CardBush's
  // metadata extensions and checking every declared resource still exists.
  const bundledRoot = path.resolve('assets/skills');
  for (const summary of await listProductSkills([bundledRoot])) {
    const detail = await readProductSkill([bundledRoot], summary.name);
    assert.ok(detail.name && detail.description && detail.content, summary.name);
    assert.equal(path.basename(detail.packageDir), detail.name);
    const references = [
      ...detail.requiredReads,
      ...detail.conditionalReads.map(item => item.split(/:\s/, 1)[0]),
      ...detail.resourceQuickRefs.map(item => item.path),
    ];
    for (const reference of references) {
      assert.equal(typeof reference, 'string', `${detail.name}: invalid resource`);
      const target = path.resolve(detail.packageDir, reference);
      assert.ok(!path.relative(detail.packageDir, target).startsWith('..'), reference);
      assert.ok((await fs.stat(target)).isFile(), `${detail.name}: ${reference}`);
    }
  }
  const presentation = await readProductSkill([bundledRoot], 'pptx');
  assert.deepEqual(presentation.requiredReads, [], 'read-only PPTX tasks do not need generation references');
  assert.ok(presentation.conditionalReads.some(item => item.startsWith('pptxgenjs.md: ')));
  const spreadsheet = await readProductSkill([bundledRoot], 'xlsx');
  assert.ok(spreadsheet.conditionalReads.some(item => item.startsWith('references/workbook-design.md: ')));
  assert.ok(spreadsheet.resourceQuickRefs.every(item => item.path && item.label && item.use_when && item.gives_you && item.not_for));
  const bundled = path.join(root, 'bundled');
  const user = path.join(root, 'user');
  await writeSkill(bundled, 'xlsx', 'Bundled spreadsheet support');
  await writeSkill(user, 'xlsx', 'User override');
  await writeSkill(user, 'pdf', 'Portable documents', true);

  const skillRoots = [
    { path: bundled, source: 'bundled', sourceId: 'cardbush', sourceLabel: 'CardBush' },
    { path: user, source: 'user', sourceId: 'user', sourceLabel: 'User' },
  ];
  const skills = await listProductSkills(skillRoots);
  assert.deepEqual(skills.map((item) => item.name), ['pdf', 'xlsx']);
  assert.equal(skills.find((item) => item.name === 'xlsx')?.description, 'User override');
  assert.equal(skills.find((item) => item.name === 'xlsx')?.source, 'user');
  assert.equal(skills.find((item) => item.name === 'xlsx')?.sourceLabel, 'User');
  assert.equal(skills.find((item) => item.name === 'xlsx')?.logoPath, '');
  assert.match(skills.find((item) => item.name === 'pdf')?.logoPath ?? '', /assets[\\/]logo\.svg$/);

  const detail = await readProductSkill(skillRoots, 'xlsx');
  assert.equal(detail.description, 'User override');
  assert.equal(path.dirname(detail.path), detail.packageDir);
  await assert.rejects(() => readProductSkill([bundled, user], 'missing'), /not installed/);

  const metadataRoot = path.join(root, 'metadata');
  await writeSkill(metadataRoot, 'sample', 'Metadata fixture');
  await fs.writeFile(path.join(metadataRoot, 'sample', 'SKILL.md'), `---
name: sample
description: Metadata fixture
required_reads:
  - base.md
conditional_reads:
  - create.md: When creating a file
  - "legacy.md: When editing a file"
resource_quick_refs:
  - path: first.md
    label: First reference
    use_when: When creating
  - path: second.md
    label: Second reference
    use_when: When editing
companion_tools:
  - read_file
---
Body
`, 'utf8');
  const metadata = await readProductSkill([metadataRoot], 'sample');
  assert.deepEqual(metadata.requiredReads, ['base.md']);
  assert.deepEqual(metadata.conditionalReads, ['create.md: When creating a file', 'legacy.md: When editing a file']);
  assert.deepEqual(metadata.resourceQuickRefs, [
    { path: 'first.md', label: 'First reference', use_when: 'When creating' },
    { path: 'second.md', label: 'Second reference', use_when: 'When editing' },
  ]);
  assert.deepEqual(metadata.companionTools, ['read_file']);

  const legacy = path.join(root, 'legacy');
  const migrated = path.join(root, 'migrated');
  await writeSkill(path.join(legacy, 'package'), 'docx', 'Legacy documents');
  await writeSkill(path.join(legacy, 'package'), 'pptx', 'Legacy duplicate');
  await writeSkill(path.join(legacy, 'package'), 'uncatalogued', 'Must stay behind');
  await writeSkill(migrated, 'existing', 'Keep the Product-owned copy');
  await writeSkill(path.join(legacy, 'package'), 'existing', 'Do not overwrite');
  await fs.writeFile(path.join(legacy, 'catalog.json'), JSON.stringify({
    version: 1,
    skills: [{ name: 'docx' }, { name: 'existing' }, { name: 'pptx' }, { name: '../unsafe' }],
  }), 'utf8');
  const migration = await migrateLegacyProductSkills([legacy], migrated, {
    excludedNames: ['pptx'],
  });
  assert.deepEqual(migration.imported, ['docx']);
  assert.deepEqual(migration.skipped, ['existing']);
  assert.deepEqual(migration.excluded, ['pptx']);
  assert.equal(migration.failed.length, 0);
  assert.equal(migration.alreadyCompleted, false);
  assert.equal(migration.markerPath, path.join(migrated, legacyProductSkillMigrationMarker));
  assert.deepEqual(
    (await listProductSkills([migrated])).map((item) => item.name),
    ['docx', 'existing'],
  );
  assert.equal(
    (await readProductSkill([migrated], 'existing')).description,
    'Keep the Product-owned copy',
  );
  await fs.rm(path.join(migrated, 'docx'), { recursive: true, force: true });
  const repeatedMigration = await migrateLegacyProductSkills([legacy], migrated, {
    excludedNames: ['pptx'],
  });
  assert.equal(repeatedMigration.alreadyCompleted, true);
  assert.deepEqual(repeatedMigration.imported, []);
  assert.equal(await exists(path.join(migrated, 'docx')), false);
  console.log('Product Skill discovery contract passed.');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

async function exists(candidate) {
  return fs.stat(candidate).then(() => true, () => false);
}

async function writeSkill(rootDir, name, description, withLogo = false) {
  const packageDir = path.join(rootDir, name);
  await fs.mkdir(packageDir, { recursive: true });
  if (withLogo) {
    await fs.mkdir(path.join(packageDir, 'assets'), { recursive: true });
    await fs.writeFile(path.join(packageDir, 'assets', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>', 'utf8');
  }
  await fs.writeFile(
    path.join(packageDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: "${description}"${withLogo ? '\nlogo: ./assets/logo.svg' : ''}\n---\n\n# ${name}\n`,
    'utf8',
  );
}
