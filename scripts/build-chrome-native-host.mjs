import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'native', 'chrome-connector', 'CardBushBrowserHost.cs');
const securitySource = path.join(root, 'native', 'chrome-connector', 'ConnectorSecurity.cs');
const testBuild = process.argv.includes('--test');
const outputDirectory = path.join(root, 'dist-native', testBuild ? 'chrome-connector-test'
  : process.argv.includes('--validation') ? 'chrome-connector-validation' : 'chrome-connector');
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

const sourceModifiedAt = Math.max(fs.statSync(source).mtimeMs, fs.statSync(securitySource).mtimeMs);
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
  ...(testBuild ? ['/define:CARDBUSH_CONNECTOR_TEST'] : []),
  source,
  securitySource,
], {
  cwd: root,
  encoding: 'utf8',
  windowsHide: true,
});
if (result.status !== 0) {
  throw new Error(result.stderr || result.stdout || `csc.exe exited with ${result.status}`);
}
console.log(`built Chrome Native Messaging host: ${output}`);
