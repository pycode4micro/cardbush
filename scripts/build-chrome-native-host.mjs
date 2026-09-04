import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'native', 'chrome-connector', 'CardBushBrowserHost.cs');
const outputDirectory = path.join(root, 'dist-native', 'chrome-connector');
const output = path.join(outputDirectory, 'CardBushBrowserHost.exe');

if (process.platform !== 'win32') {
  fs.mkdirSync(outputDirectory, { recursive: true });
  console.log('Chrome Native Messaging host build skipped on non-Windows.');
  process.exit(0);
}

const windowsDirectory = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows';
const compilers = [
  path.join(windowsDirectory, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
  path.join(windowsDirectory, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
];
const compiler = compilers.find((candidate) => fs.existsSync(candidate));
if (!compiler) throw new Error('The Windows .NET Framework C# compiler is required to build CardBushBrowserHost.exe.');
fs.mkdirSync(outputDirectory, { recursive: true });

const sourceModifiedAt = fs.statSync(source).mtimeMs;
if (fs.existsSync(output) && fs.statSync(output).mtimeMs >= sourceModifiedAt) {
  console.log(`Chrome Native Messaging host is current: ${output}`);
  process.exit(0);
}

const result = spawnSync(compiler, [
  '/nologo',
  '/optimize+',
  '/target:exe',
  `/out:${output}`,
  '/reference:System.Web.Extensions.dll',
  source,
], {
  cwd: root,
  encoding: 'utf8',
  windowsHide: true,
});
if (result.status !== 0) {
  throw new Error(result.stderr || result.stdout || `csc.exe exited with ${result.status}`);
}
console.log(`built Chrome Native Messaging host: ${output}`);
