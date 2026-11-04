import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(root, 'archive-manifest.json'), 'utf8'));
if (manifest.schema !== 'friends.demo.archive.v1' || !Array.isArray(manifest.files)) {
  throw new Error('Invalid archive manifest');
}

const seen = new Set();
let totalBytes = 0;
for (const entry of manifest.files) {
  if (typeof entry.path !== 'string' || !/^v[45]\//.test(entry.path) || seen.has(entry.path)) {
    throw new Error('Invalid or duplicate archive path');
  }
  const target = resolve(root, entry.path);
  const scoped = relative(root, target);
  if (isAbsolute(scoped) || scoped === '..' || scoped.startsWith('../') || scoped.startsWith('..\\')) {
    throw new Error('Archive path outside snapshot');
  }
  const content = readFileSync(target);
  const sha256 = createHash('sha256').update(content).digest('hex');
  if (content.length !== entry.bytes || sha256 !== entry.sha256) {
    throw new Error(`Archive mismatch: ${entry.path}`);
  }
  if (entry.path.endsWith('.json')) JSON.parse(content.toString('utf8'));
  seen.add(entry.path);
  totalBytes += content.length;
}

console.log(`Verified ${seen.size} original files (${totalBytes} bytes). No demo or model was started.`);
