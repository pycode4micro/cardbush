import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  listProductSkills,
  readProductSkill,
} from '../dist-electron/productSkills.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cardbush-product-skills-'));
try {
  const bundled = path.join(root, 'bundled');
  const user = path.join(root, 'user');
  await writeSkill(bundled, 'xlsx', 'Bundled spreadsheet support');
  await writeSkill(user, 'xlsx', 'User override');
  await writeSkill(user, 'pdf', 'Portable documents');

  const skills = await listProductSkills([bundled, user]);
  assert.deepEqual(skills.map((item) => item.name), ['pdf', 'xlsx']);
  assert.equal(skills.find((item) => item.name === 'xlsx')?.description, 'User override');

  const detail = await readProductSkill([bundled, user], 'xlsx');
  assert.equal(detail.description, 'User override');
  assert.equal(path.dirname(detail.path), detail.packageDir);
  await assert.rejects(() => readProductSkill([bundled, user], 'missing'), /not installed/);
  console.log('Product Skill discovery contract passed.');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

async function writeSkill(rootDir, name, description) {
  const packageDir = path.join(rootDir, name);
  await fs.mkdir(packageDir, { recursive: true });
  await fs.writeFile(
    path.join(packageDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: "${description}"\n---\n\n# ${name}\n`,
    'utf8',
  );
}
