// Archive disposable copies of a real turn and its children; never mutate the source profile.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, readdir, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { FileRuntimeEventPersistence } from '../packages/bush-runtime/dist/index.js';
import { journalChunks } from '../packages/bush-runtime/dist/cacheMaintenance.js';

const args = Object.fromEntries(Array.from({ length: (process.argv.length - 2) / 2 }, (_, i) => process.argv.slice(2 + i * 2, 4 + i * 2)));
const root = args['--root'], sessionId = args['--session'], turnId = args['--turn'];
if (!root || !sessionId || !turnId) throw Error('Usage: --root <runtime-state> --session <id> --turn <id>');
const hash = value => createHash('sha256').update(value).digest('hex');
const children = new Map();
try {
  const text = await readFile(join(root, 'subagents', `${hash(sessionId)}.jsonl`), 'utf8');
  for (const line of text.trim().split('\n')) {
    const { event } = JSON.parse(line);
    if (event.task.parentTurnId === turnId) children.set(event.taskId, event.task);
  }
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const copyRoot = await mkdtemp(join(tmpdir(), 'cardbush-retention-benchmark-'));
const persistence = new FileRuntimeEventPersistence({ root: copyRoot });
const totals = { turns: 0, originalBytes: 0, archivedBytes: 0, verifiedFiles: 0 };
async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of journalChunks(path)) hash.update(chunk);
  return hash.digest('hex');
}
try {
  const originals = new Map();
  for (const id of [{ sessionId, turnId }, ...[...children.values()].map(task => ({ sessionId: task.childSessionId, turnId: task.childTurnId }))]) {
    const name = `${hash(JSON.stringify([id.sessionId, id.turnId]))}.jsonl`, source = join(root, 'events', name);
    const copy = join(copyRoot, name);
    await copyFile(source, copy);
    const age = new Date(Date.now() - 8 * 86400_000); await utimes(copy, age, age);
    originals.set(name, await digest(source)); totals.originalBytes += (await stat(source)).size; totals.turns++;
  }
  for (let pass = 0; pass < totals.turns; pass++) {
    const result = await persistence.maintain(); assert.deepEqual(result.errors, []);
    if (!result.counts.archived_files) break;
  }
  for (const name of await readdir(copyRoot)) {
    assert.ok(name.endsWith('.gz'), 'Every selected test journal should qualify for archiving');
    assert.equal(await digest(join(copyRoot, name)), originals.get(basename(name, '.gz')));
    totals.archivedBytes += (await stat(join(copyRoot, name))).size; totals.verifiedFiles++;
  }
  assert.equal(totals.verifiedFiles, totals.turns);
  console.log(JSON.stringify({ ...totals, reductionPercent: +(100 * (1 - totals.archivedBytes / totals.originalBytes)).toFixed(2) }, null, 2));
} finally {
  persistence.close();
  assert.equal(dirname(resolve(copyRoot)), resolve(tmpdir())); assert.ok(basename(copyRoot).startsWith('cardbush-retention-benchmark-'));
  await rm(copyRoot, { recursive: true, force: true });
}
