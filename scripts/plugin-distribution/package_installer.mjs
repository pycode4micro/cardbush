import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { getMakeNsisPath } = require('app-builder-lib/out/toolsets/windows.js');
const source = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
const report = JSON.parse(await readFile(path.join(path.dirname(source), 'plugin-verification.json'), 'utf8'));
const names = await readdir(source);
assert.equal(report.results.length, names.length, 'Every plugin needs a validation receipt');
assert.ok(report.results.every(x => x.passed), 'Do not package failed plugins');
assert.ok(names.every(name => /^[a-z0-9-]+$/.test(name)));
const quote = value => value.replaceAll('$', '$$').replaceAll('"', '$\\"');
const script = path.join(path.dirname(output), 'plugins-installer.nsi');
const lines = [
  'Unicode true', '!include "MUI2.nsh"', 'RequestExecutionLevel user',
  'Name "CardBush Plugins - Internal Unsigned"', `OutFile "${quote(output)}"`,
  'InstallDir "$APPDATA\\cardbush\\plugins"', 'SetCompressor /SOLID lzma',
  'SetCompressorDictSize 64', 'ShowInstDetails show',
  '!insertmacro MUI_PAGE_WELCOME', '!insertmacro MUI_PAGE_DIRECTORY',
  '!insertmacro MUI_PAGE_INSTFILES', '!insertmacro MUI_PAGE_FINISH',
  '!insertmacro MUI_LANGUAGE "SimpChinese"', '!insertmacro MUI_LANGUAGE "English"',
  'Section', 'SetShellVarContext current',
  // Check all destinations before writing anything. Existing plugins are never merged.
  ...names.flatMap((name, i) => [
    `IfFileExists "$INSTDIR\\${name}\\*.*" 0 new_${i}`,
    `MessageBox MB_OK|MB_ICONSTOP "PLUGIN_ALREADY_EXISTS: $INSTDIR\\${name}"`,
    'SetErrorLevel 2', 'Abort', `new_${i}:`,
  ]),
  ...names.flatMap(name => [
    `SetOutPath "$INSTDIR\\${name}"`, `File /r "${quote(path.join(source, name, '*'))}"`,
  ]),
  'SectionEnd',
];
await writeFile(script, lines.join('\r\n'), 'utf8');
const compiler = await getMakeNsisPath();
const result = await new Promise((resolve, reject) => {
  const child = spawn(compiler.path, ['/V2', script], { env: { ...process.env, ...compiler.env }, stdio: 'inherit', windowsHide: true });
  child.once('error', reject); child.once('exit', resolve);
});
process.exitCode = result ?? 1;
