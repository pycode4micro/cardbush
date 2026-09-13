import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'native', 'process-guard', 'CardBushProcessHost.cs');
const directory = path.join(root, 'dist-native', 'process-guard');
if (process.platform !== 'win32') process.exit(0);
const version = createHash('sha256').update(fs.readFileSync(source)).update(fs.readFileSync(new URL(import.meta.url))).digest('hex').slice(0, 16);
const fileName = `CardBushProcessHost-${version}.exe`;
const output = path.join(directory, fileName);
const manifest = path.join(directory, 'current.json');

const windowsDirectory = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows';
const compiler = ['Framework64', 'Framework'].map(name =>
  path.join(windowsDirectory, 'Microsoft.NET', name, 'v4.0.30319', 'csc.exe')
).find(candidate => fs.existsSync(candidate));
if (!compiler) throw new Error('The Windows .NET Framework C# compiler is required to build the process resource host.');
fs.mkdirSync(directory, { recursive: true });
function publish() {
  const temporaryManifest = `${manifest}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryManifest, JSON.stringify({ fileName }));
  fs.renameSync(temporaryManifest, manifest);
}
if (fs.existsSync(output)) { publish(); process.exit(0); }
// Publish a complete executable; never replace a running host with partial bytes.
const temporary = path.join(directory, `CardBushProcessHost-${process.pid}.exe`);
const result = spawnSync(compiler, ['/nologo', '/optimize+', '/target:exe', '/platform:x64',
  `/out:${temporary}`, source],
{ cwd: root, encoding: 'utf8', windowsHide: true });
if (result.status !== 0) throw new Error(result.stderr || result.stdout || `csc.exe exited with ${result.status}`);
try { fs.renameSync(temporary, output); }
catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
// Immutable executable names allow a running protected build to publish its next
// supervisor without replacing the executable that is currently supervising it.
publish();
console.log('Built CardBush process resource host.');
