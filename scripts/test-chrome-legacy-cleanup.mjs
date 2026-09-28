import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'win32') process.exit(0);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cardbush-cleanup-test-'));
const key = `Software\\CardBushConnectorCleanupTests\\${randomUUID()}`;
const quote = value => `'${value.replaceAll("'", "''")}'`;
const ps = script => {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from("$ErrorActionPreference='Stop';\n" + script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.ifError(result.error); return result;
};
const ok = script => { const result = ps(script); assert.equal(result.status, 0, result.stderr); return result.stdout; };
const dataRoot = path.join(root, 'cardbush'), directory = path.join(dataRoot, 'browser-connector');
const manifest = path.join(directory, 'com.cardbush.browser_connector.json');
fs.mkdirSync(directory, { recursive: true });
// Execute the shipped algorithm against isolated Windows registry keys and files.
// Production has no path/key override. Only this temporary test copy is rewritten.
let source = fs.readFileSync('assets/connector-maintenance/cleanup-legacy.ps1', 'utf8');
assert.ok(source.includes("$keyName = 'Software\\Google\\Chrome\\NativeMessagingHosts\\com.cardbush.browser_connector'"));
source = source.replace(/^\$roamingRoot = .*$/m, `$roamingRoot = ${quote(dataRoot)}`)
  .replace(/^\$keyName = .*$/m, `$keyName = ${quote(key)}`);
// The original line is indented inside try.
source = source.replace(/  \$keyName = .*\r?\n/, `  $keyName = ${quote(key)}\n`)
  .replace('cardbush-connector-owner-$leaseId', `cardbush-cleanup-test-${randomUUID()}-$leaseId`);
assert.ok(!source.includes("$keyName = 'Software\\Google\\Chrome"));
const scriptFile = path.join(root, 'cleanup.ps1'); fs.writeFileSync(scriptFile, source);
const run = extra => ps(`& ${quote(scriptFile)} -ManifestPath ${quote(manifest)} ${extra ?? ''}`);
const seed = (value = manifest) => ok(`$k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey(${quote(key)});try {$k.SetValue('',${quote(value)});$k.SetValue('keep','unrelated')}finally{$k.Dispose()}`);
const registered = () => ok(`$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(${quote(key)});try {if($k){[string]$k.GetValue('')}}finally{if($k){$k.Dispose()}}`).trim();
const contents = { name: 'com.cardbush.browser_connector', type: 'stdio', path: 'C:\\legacy\\CardBushBrowserHost.exe',
  allowed_origins: ['chrome-extension://iibaamkfgackofhhpadgnmgcjkhckeln/'],
  cardbush_owner: createHash('sha256').update(dataRoot.toLowerCase()).digest('hex') };
const resetManifest = () => fs.writeFileSync(manifest, JSON.stringify(contents));
try {
  resetManifest(); seed(); fs.writeFileSync(path.join(directory, 'keep.txt'), 'unrelated');
  assert.equal(run('-WhatIf').status, 0); assert.equal(registered(), manifest); assert.ok(fs.existsSync(manifest));
  seed('C:\\another-install\\host.json'); assert.notEqual(run().status, 0);
  assert.equal(registered(), 'C:\\another-install\\host.json'); assert.ok(fs.existsSync(manifest));
  seed(); fs.writeFileSync(manifest, JSON.stringify({ ...contents, cardbush_owner: 'wrong' }));
  assert.notEqual(run().status, 0); assert.equal(registered(), manifest);
  resetManifest(); fs.writeFileSync(path.join(directory, 'bridge.json'), JSON.stringify({ pid: process.pid }));
  assert.notEqual(run().status, 0); assert.equal(registered(), manifest);
  fs.writeFileSync(path.join(directory, 'bridge.json'), JSON.stringify({ pid: 0 }));
  fs.writeFileSync(path.join(directory, 'preference.json'), JSON.stringify({ version: 1, enabled: false }));
  const result = run(); assert.equal(result.status, 0, result.stderr);
  assert.equal(registered(), ''); assert.equal(fs.existsSync(manifest), false);
  assert.equal(fs.existsSync(path.join(directory, 'bridge.json')), false);
  assert.equal(fs.existsSync(path.join(directory, 'preference.json')), false);
  assert.equal(fs.readFileSync(path.join(directory, 'keep.txt'), 'utf8'), 'unrelated');
  assert.equal(ok(`$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(${quote(key)});try {$k.GetValue('keep')}finally{$k.Dispose()}`).trim(), 'unrelated');
  assert.equal(run().status, 0, 'repeat cleanup is safe');
  console.log('Legacy cleanup passed: real isolated HKCU key, WhatIf, ownership, live process, exact deletion, unrelated values/files, repeat operation.');
} finally {
  assert.match(key, /^Software\\CardBushConnectorCleanupTests\\[a-f0-9-]+$/);
  ok(`[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree(${quote(key)},$false)`);
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('cardbush-cleanup-test-'));
  fs.rmSync(root, { recursive: true, force: true });
}
