import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const assetRoot = path.join(repositoryRoot, 'assets', 'runtime-tools', 'ripgrep');
const manifest = JSON.parse(await readFile(path.join(assetRoot, 'manifest.json'), 'utf8'));
const target = manifest.platforms['win32-x64'];
const executablePath = path.join(assetRoot, target.executable);
const verifyOnly = process.argv.includes('--verify');

if (await verifyInstalled()) {
  console.log(`bundled ripgrep ${manifest.version} verified (${target.executable})`);
  process.exit(0);
}

if (verifyOnly) {
  throw new Error(
    `Bundled ripgrep ${manifest.version} is missing or invalid. Run npm run runtime-tools:install.`,
  );
}

const response = await fetch(target.archiveUrl);
if (!response.ok) {
  throw new Error(`Failed to download ripgrep: HTTP ${response.status}.`);
}
const archive = Buffer.from(await response.arrayBuffer());
assertSha256(archive, target.archiveSha256, target.archive);

const { default: JSZip } = await import('jszip');
const zip = await JSZip.loadAsync(archive);
const archiveRoot = `ripgrep-${manifest.version}-x86_64-pc-windows-msvc/`;
const destination = path.dirname(executablePath);
await mkdir(destination, { recursive: true });
for (const name of ['rg.exe', 'COPYING', 'LICENSE-MIT', 'UNLICENSE']) {
  const entry = zip.file(`${archiveRoot}${name}`);
  if (!entry) throw new Error(`The ripgrep archive is missing ${name}.`);
  await writeFile(path.join(destination, name), await entry.async('nodebuffer'));
}

if (!await verifyInstalled()) {
  throw new Error('The downloaded ripgrep executable failed verification.');
}
console.log(`bundled ripgrep ${manifest.version} installed (${target.executable})`);

async function verifyInstalled() {
  let executable;
  try {
    executable = await readFile(executablePath);
  } catch {
    return false;
  }
  if (sha256(executable) !== target.executableSha256) return false;
  try {
    const version = execFileSync(executablePath, ['--version'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return version.startsWith(`ripgrep ${manifest.version}`);
  } catch {
    return false;
  }
}

function assertSha256(value, expected, label) {
  const actual = sha256(value);
  if (actual !== expected) {
    throw new Error(`${label} SHA-256 mismatch: expected ${expected}, received ${actual}.`);
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
