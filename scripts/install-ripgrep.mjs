import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const assetRoot = fileURLToPath(new URL('../assets/runtime-tools/ripgrep/', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(assetRoot, 'manifest.json'), 'utf8'));
const option = name => process.argv.find(value => value.startsWith('--' + name + '='))?.split('=')[1];
const platform = option('platform') ?? process.platform;
const arch = option('arch') ?? process.arch;
const target = manifest.platforms[platform + '-' + arch];
if (!target) throw new Error('No verified ripgrep asset for ' + platform + '-' + arch);
const executablePath = path.join(assetRoot, target.executable);
const sha256 = value => createHash('sha256').update(value).digest('hex');

async function verifyInstalled() {
  try {
    if (sha256(await readFile(executablePath)) !== target.executableSha256) return false;
    if (platform !== process.platform || arch !== process.arch) return true;
    if (platform !== 'win32') await chmod(executablePath, 0o755);
    return execFileSync(executablePath, ['--version'], { encoding: 'utf8', windowsHide: true })
      .startsWith('ripgrep ' + manifest.version);
  } catch { return false; }
}

if (!await verifyInstalled()) {
  if (process.argv.includes('--verify')) throw new Error('Bundled ripgrep is missing or invalid. Run npm run runtime-tools:install.');
  const response = await fetch(target.archiveUrl, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error('ripgrep download: HTTP ' + response.status);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 50 * 1024 * 1024) throw new Error('ripgrep archive exceeds size limit.');
    chunks.push(chunk);
  }
  const archive = Buffer.concat(chunks);
  if (sha256(archive) !== target.archiveSha256) throw new Error('ripgrep archive SHA-256 mismatch.');
  const names = [path.basename(executablePath), 'COPYING', 'LICENSE-MIT', 'UNLICENSE'];
  const archiveRoot = target.archive.replace(/\.(zip|tar\.gz)$/, '');
  const entries = new Map();
  if (target.archive.endsWith('.zip')) {
    const { default: JSZip } = await import('jszip');
    const zip = await JSZip.loadAsync(archive);
    for (const name of names) {
      const entry = zip.file(archiveRoot + '/' + name);
      if (entry) entries.set(name, await entry.async('nodebuffer'));
    }
  } else {
    const { Parser } = await import('tar');
    // Read only exact regular-file entries; never extract archive paths to disk.
    await new Promise((resolve, reject) => {
      const parser = new Parser({ onReadEntry(entry) {
        const name = names.find(value => entry.path === archiveRoot + '/' + value);
        if (!name || entry.type !== 'File' || entry.size > 20 * 1024 * 1024) { entry.resume(); return; }
        const content = [];
        entry.on('data', chunk => content.push(chunk));
        entry.on('end', () => entries.set(name, Buffer.concat(content)));
      }});
      parser.on('error', reject); parser.on('end', resolve); parser.end(archive);
    });
  }
  for (const name of names) if (!entries.has(name)) throw new Error('ripgrep archive missing ' + name);
  if (sha256(entries.get(names[0])) !== target.executableSha256) throw new Error('ripgrep executable SHA-256 mismatch.');
  await mkdir(path.dirname(executablePath), { recursive: true });
  for (const [name, content] of entries) await writeFile(path.join(path.dirname(executablePath), name), content);
  if (!await verifyInstalled()) throw new Error('ripgrep failed verification after installation.');
}
console.log('bundled ripgrep ' + manifest.version + ' verified (' + platform + '-' + arch + ')');
