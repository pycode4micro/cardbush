import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { renameProjectDirectory } from '../dist-electron/projectDirectories.js';

const sandbox = mkdtempSync(path.join(tmpdir(), 'cardbush-project-rename-'));
try {
  const source = path.join(sandbox, 'alpha');
  mkdirSync(source);
  writeFileSync(path.join(source, 'history.txt'), 'preserved');
  const renamed = await renameProjectDirectory(source, 'beta');
  assert.equal(renamed.changed, true);
  assert.equal(existsSync(source), false);
  assert.equal(readFileSync(path.join(renamed.nextPath, 'history.txt'), 'utf8'), 'preserved');

  const collision = path.join(sandbox, 'collision');
  mkdirSync(collision);
  await assert.rejects(
    renameProjectDirectory(renamed.nextPath, 'collision'),
    /already exists/,
  );
  assert.equal(existsSync(renamed.nextPath), true, 'a collision must not move the source');

  for (const invalid of ['', '..', '../escape', 'child/name', 'CON', 'trailing.']) {
    await assert.rejects(renameProjectDirectory(renamed.nextPath, invalid));
    assert.equal(existsSync(renamed.nextPath), true, `invalid name ${invalid} mutated the source`);
  }
  await assert.rejects(
    renameProjectDirectory('', 'must-not-touch-the-process-directory'),
    /path is required/,
  );

  const unchanged = await renameProjectDirectory(renamed.nextPath, 'beta');
  assert.equal(unchanged.changed, false);

  if (process.platform === 'win32') {
    const caseOnly = await renameProjectDirectory(renamed.nextPath, 'BETA');
    assert.equal(caseOnly.changed, true);
    assert.equal(existsSync(caseOnly.nextPath), true);
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

const hookSource = readFileSync(
  path.join(process.cwd(), 'src/hooks/useCardbushChat.ts'),
  'utf8',
);
assert.match(
  hookSource,
  /catch \(caught\) \{[\s\S]*?for \(const snapshot of completed\.reverse\(\)\)[\s\S]*?projectDir: conversationProjectDir\(snapshot\) \|\| null/,
  'partial session metadata migration must roll back completed sessions',
);
const appSource = readFileSync(path.join(process.cwd(), 'src/App.tsx'), 'utf8');
assert.match(
  appSource,
  /catch \(caught\) \{[\s\S]*?const rollbackName[\s\S]*?rootPath: moved\.nextPath[\s\S]*?name: rollbackName[\s\S]*?if \(rolledBack\)/,
  'a failed session migration must attempt to restore the physical folder name',
);

console.log('project directory lifecycle tests passed');
