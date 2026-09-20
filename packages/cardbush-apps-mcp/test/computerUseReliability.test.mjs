import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import test from 'node:test';

import { formatComputerUseError } from '../dist/plugins/computerUseErrors.js';
import { supportedAccessibilityActions, validateAccessibilityAction } from '../dist/plugins/computerUseRuntime.js';

const source = await readFile(new URL('../src/plugins/computerUseRuntime.ts', import.meta.url), 'utf8');
const windowsOnly = { skip: process.platform !== 'win32' };
async function powershell(script, env = {}) {
  const prefix = "$ErrorActionPreference='Stop'\n[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)\n";
  const { stdout } = await promisify(execFile)('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(prefix + script, 'utf16le').toString('base64'),
  ], { windowsHide: true, timeout: 15_000, encoding: 'utf8', env: { ...process.env, ...env } });
  return JSON.parse(stdout.trim());
}

test('native error diagnostics omit commands and CLIXML, preserve Unicode, and remain bounded', () => {
  const encoded = 'A'.repeat(26_000);
  const stderr = '#< CLIXML\r\n<Objs><S S="progress">do not show progress</S>' +
    '<S S="Error">没有语义操作 &amp; &lt;Value&gt;_x000D__x000A_</S>' +
    '<S S="Error">所在位置 行:155 字符:5_x000D__x000A_</S>' +
    '<S S="Error">+ throw script details_x000D__x000A_</S>' +
    '<S S="Error">    + FullyQualifiedErrorId : error wraps_x000D__x000A_</S>' +
    '<S S="Error">       unlabelled duplicate tail_x000D__x000A_</S></Objs>';
  assert.equal(formatComputerUseError({ message: `Command failed: powershell -EncodedCommand ${encoded}\n${stderr}`, stderr }), '没有语义操作 & <Value>');
  assert.equal(formatComputerUseError(new Error(`Command failed: powershell -EncodedCommand ${encoded}\nUseful failure`)), 'Useful failure');
  assert.match(formatComputerUseError({ killed: true }), /may have partially completed/);
  assert.match(formatComputerUseError({ killed: true, code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), /output limit/);
  assert.equal(formatComputerUseError(new Error('The target window changed.')), 'The target window changed.');
  assert.ok(formatComputerUseError(new Error('长错误'.repeat(2000))).length <= 1600);
  assert.doesNotMatch(formatComputerUseError(new Error(`Command failed: powershell -EncodedCommand ${encoded}`)), /EncodedCommand|AAAA/);
});

test('semantic actions expose their actual capabilities and reject an editor click before native dispatch', () => {
  const editor = { index: 3, patterns: ['Value', 'Text'], enabled: true, offscreen: false, password: false, readOnly: false };
  const observation = { elements: [editor] };
  assert.deepEqual(supportedAccessibilityActions(editor), ['set_value']);
  assert.throws(() => validateAccessibilityAction('click', { element_index: 3 }, observation), /does not support click.*Value, Text/);
  assert.equal(validateAccessibilityAction('set_value', { element_index: 3 }, observation), editor);
  for (const pattern of ['Invoke', 'Toggle', 'SelectionItem', 'ExpandCollapse']) {
    assert.deepEqual(supportedAccessibilityActions({ ...editor, patterns: [pattern] }), ['click', 'invoke']);
  }
  for (const flags of [{ readOnly: true }, { password: true }, { enabled: false }, { offscreen: true }]) {
    assert.deepEqual(supportedAccessibilityActions({ ...editor, ...flags }), []);
    assert.throws(() => validateAccessibilityAction('set_value', { element_index: 3 }, { elements: [{ ...editor, ...flags }] }));
  }
  assert.deepEqual(supportedAccessibilityActions({ ...editor, patterns: ['Text'] }), []);
  assert.throws(() => validateAccessibilityAction('invoke', { element_index: 100 }, observation), /not part of this observation/);
});

// Compile the production Text method with an input sink. No real keyboard events,
// foreground changes, user windows or desktop fixtures are needed for this test.
test('native text input preserves Unicode and maps LF/CRLF/CR to one Enter with focus checks', windowsOnly, async () => {
  const method = source.match(/  public static void Text\(string text\)\{[\s\S]*?(?=  public static void MovePointer)/)?.[0];
  assert.ok(method);
  const output = await powershell(String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
public static class InputSink {
  public struct KEYBDINPUT { public ushort virtualKey,scanCode; public uint flags; public UIntPtr extraInfo; }
  public struct InputUnion { public KEYBDINPUT keyboard; }
  public struct INPUT { public uint type; public InputUnion data; }
  public static readonly UIntPtr InputTag=new UIntPtr(0x43425553);
  public static List<string> Events=new List<string>();
  public static int Checks,FailAt;
  public static void Reset(int failAt){Events.Clear();Checks=0;FailAt=failAt;}
  public static void CheckTarget(){Checks++;if(Checks==FailAt)throw new InvalidOperationException("focus changed");}
  static void timeBeginPeriod(int n){} static void timeEndPeriod(int n){}
  public static uint SendInput(uint count,INPUT[] inputs,int size){foreach(var i in inputs){var k=i.data.keyboard;Events.Add(k.virtualKey+":"+k.scanCode+":"+k.flags);}return count;}
${method}
}
'@
[InputSink]::Reset(0)
[InputSink]::Text("A"+[char]13+[char]10+"B"+[char]10+[char]10+"中😀"+[char]13+"C")
$normal=@([InputSink]::Events.ToArray());$checks=[InputSink]::Checks
[InputSink]::Reset(4)
$failure=$null
try { [InputSink]::Text("A"+[char]10+"SHOULD NOT BE SENT") } catch { $failure=$_.Exception.Message }
[PSCustomObject]@{normal=$normal;checks=$checks;stopped=@([InputSink]::Events.ToArray());failure=$failure} | ConvertTo-Json -Depth 4 -Compress
`);
  const pair = (char) => [`0:${char.charCodeAt(0)}:4`, `0:${char.charCodeAt(0)}:6`];
  const enter = ['13:0:0', '13:0:2'];
  assert.deepEqual(output.normal, [...pair('A'), ...enter, ...pair('B'), ...enter, ...enter, ...pair('中'), ...pair('\ud83d'), ...pair('\ude00'), ...enter, ...pair('C')]);
  assert.equal(output.checks, 18);
  assert.deepEqual(output.stopped, [...pair('A'), ...enter]);
  assert.match(output.failure, /focus changed/);
});

// Run the production launch script with only process launch/window enumeration
// replaced. This tests PowerShell binding and shell handoff handling without
// opening Notepad or touching the interactive desktop.
const launchScript = source.match(/const openApplicationScript = String.raw`([\s\S]*?)`;/)?.[1];
async function launchFixture({ before = [], after = [], failBefore = false, failAfter = false }) {
  assert.ok(launchScript);
  const script = launchScript.replace('function Get-CardBushLaunchWindows { @([CardBushWindowList]::Read()) }', String.raw`
function Get-CardBushLaunchWindows {
  if (-not $script:fixtureLaunched) {
    if ($env:FIXTURE_FAIL_BEFORE -eq '1') { throw 'baseline unavailable' }
    @($env:FIXTURE_BEFORE | ConvertFrom-Json)
  } else {
    if ($env:FIXTURE_FAIL_AFTER -eq '1') { throw 'inspection unavailable' }
    @($env:FIXTURE_AFTER | ConvertFrom-Json)
  }
}`);
  assert.notEqual(script, launchScript);
  return powershell(String.raw`
$script:fixtureLaunched=$false
function Start-Process {
  param($FilePath,$WorkingDirectory,[switch]$PassThru)
  if (-not (Test-Path -LiteralPath $WorkingDirectory -PathType Container)) { throw 'invalid working directory' }
  if ($script:fixtureLaunched) { throw 'launched twice' }
  $script:fixtureLaunched=$true
  [PSCustomObject]@{Id=421}
}
${script}`, { CARDBUSH_APP_TARGET: process.env.ComSpec, FIXTURE_BEFORE: JSON.stringify(before), FIXTURE_AFTER: JSON.stringify(after), FIXTURE_FAIL_BEFORE: failBefore ? '1' : '0', FIXTURE_FAIL_AFTER: failAfter ? '1' : '0' });
}

test('launch feedback distinguishes new windows, reused windows, unrelated windows and failed checks', windowsOnly, async () => {
  const window = { hwnd: 101, process_id: 421, process_name: 'child-host', title: 'Fixture' };
  const fresh = await launchFixture({ after: [window] });
  assert.equal(fresh.dispatched, true);
  assert.equal(fresh.window_check.status, 'new_window_observed');
  assert.equal(fresh.window_check.candidates[0].match_basis, 'process_id');
  assert.equal(fresh.window_check.candidates[0].existed_before_launch, false);
  assert.ok(fresh.working_directory);
  const existing = { ...window, process_id: 99, process_name: 'cmd' };
  const reused = await launchFixture({ before: [existing], after: [existing] });
  assert.equal(reused.window_check.status, 'existing_window_candidate');
  assert.equal(reused.window_check.candidates[0].match_basis, 'process_name');
  assert.equal(reused.window_check.candidates[0].existed_before_launch, true);
  const unrelated = await launchFixture({ after: [{ ...window, process_id: 999 }] });
  assert.equal(unrelated.window_check.status, 'unconfirmed');
  assert.deepEqual(unrelated.window_check.candidates, []);
  const noBaseline = await launchFixture({ after: [window], failBefore: true });
  assert.equal(noBaseline.window_check.status, 'unconfirmed');
  assert.equal(noBaseline.window_check.candidates[0].existed_before_launch, null);
  const noCheck = await launchFixture({ failAfter: true });
  assert.equal(noCheck.dispatched, true);
  assert.equal(noCheck.window_check.status, 'unconfirmed');
  assert.match(noCheck.window_check.error, /after launch/);
});
