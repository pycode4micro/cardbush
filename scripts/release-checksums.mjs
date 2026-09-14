import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
const files = (await readdir('release')).filter(name => /^CardBush-.*\.(exe|AppImage)$/.test(name)).sort();
if (!files.length) throw new Error('No installers to checksum.');
const sums = [];
for (const file of files) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream('release/' + file)) hash.update(chunk);
  sums.push(hash.digest('hex') + '  ' + file);
}
await writeFile(`release/SHA256SUMS-${process.platform}-x64.txt`, sums.join('\n') + '\n');
console.log(sums.join('\n'));
