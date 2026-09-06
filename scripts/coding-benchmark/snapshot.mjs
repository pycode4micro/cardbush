import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { suite } from './suite.mjs';

const project = fileURLToPath(new URL('../..', import.meta.url));
const reference = fileURLToPath(new URL('./reference', import.meta.url));
const hashes = {};
for (const path of [...new Set(suite.flatMap((task) => task.files))]) {
  const content = (await readFile(join(project, path), 'utf8')).replaceAll('\r\n', '\n');
  const destination = join(reference, path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, content);
  hashes[path] = createHash('sha256').update(content).digest('hex');
}
await writeFile(join(reference, 'sources.json'), JSON.stringify({
  description: 'Fixed CardBush source snapshots. Seeded regressions are defined in suite.mjs.',
  capturedAt: new Date().toISOString(), hashes,
}, null, 2) + '\n');
console.log(`Captured ${Object.keys(hashes).length} source files for ${suite.length} tasks.`);
