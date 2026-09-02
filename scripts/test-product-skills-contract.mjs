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
