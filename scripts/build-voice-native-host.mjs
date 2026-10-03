import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'native/voice/CardBushVoiceHost.cs');
const synthesis = path.join(root, 'native/voice/WindowsVoices.cs');
const directory = path.join(root, 'dist-native/voice');
fs.mkdirSync(directory, { recursive: true });
if (process.platform !== 'win32') { console.log('Windows speech host skipped on this platform.'); process.exit(0); }
const windows = process.env.WINDIR || 'C:\\Windows';
const compiler = ['Framework64', 'Framework'].map(arch => path.join(windows, 'Microsoft.NET', arch, 'v4.0.30319/csc.exe')).find(fs.existsSync);
const gac = path.join(windows, 'Microsoft.NET/assembly/GAC_MSIL/System.Speech');
const speech = fs.existsSync(gac) && fs.readdirSync(gac).map(version => path.join(gac, version, 'System.Speech.dll')).find(fs.existsSync);
if (!compiler || !speech) throw Error('Windows .NET Framework and System.Speech are required to build the local voice host.');
const output = path.join(directory, 'CardBushVoiceHost.exe');
if (!fs.existsSync(output) || fs.statSync(output).mtimeMs < Math.max(...[source, synthesis, import.meta.filename].map(file => fs.statSync(file).mtimeMs))) {
  const references = [speech, ...['Windows.Foundation', 'Windows.Media', 'Windows.Storage'].map(name => path.join(windows, 'System32/WinMetadata', name + '.winmd'))];
  for (const name of ['System.Runtime', 'System.Runtime.InteropServices.WindowsRuntime']) {
    const folder = path.join(windows, 'Microsoft.NET/assembly/GAC_MSIL', name);
    const dll = fs.readdirSync(folder).map(version => path.join(folder, version, name + '.dll')).find(fs.existsSync);
    if (!dll) throw Error('Missing Windows runtime reference: ' + name); references.push(dll);
  }
  const result = spawnSync(compiler, ['/nologo', '/optimize+', '/target:exe', `/out:${output}`, ...references.map(file => `/reference:${file}`), '/reference:System.Web.Extensions.dll', source, synthesis], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw Error(result.stderr || result.stdout || 'Voice host build failed.');
}
console.log('Windows local voice host ready.');
const speakerSource = path.join(root, 'native/voice/CardBushSpeakerHost.cs');
const speakerOutput = path.join(directory, 'CardBushSpeakerHost.exe');
if (!fs.existsSync(speakerOutput) || fs.statSync(speakerOutput).mtimeMs < Math.max(fs.statSync(speakerSource).mtimeMs, fs.statSync(import.meta.filename).mtimeMs)) {
  const result = spawnSync(compiler, ['/nologo', '/optimize+', '/platform:x64', '/target:exe', `/out:${speakerOutput}`, '/reference:System.Web.Extensions.dll', speakerSource], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw Error(result.stderr || result.stdout || 'Speaker host build failed.');
}
console.log('Windows local speaker host ready.');
