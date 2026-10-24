import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { computerUsePresentationNative } from '../dist/plugins/computerUsePresentationNative.js';
import { computerUseNoticeFailure } from '../dist/plugins/computerUsePresentation.js';
import { computerUseUserIdleMs } from '../dist/plugins/computerUseTakeover.js';

test('takeover receipts distinguish the short quiet period from observation expiry and retain explicit stop', () => {
  const early = computerUseNoticeFailure({ kind: 'paused', reason: 'keyboard', retry_after_ms: 250 }).info;
  assert.equal(early.code, 'user_takeover'); assert.equal(early.details.retry_after_ms, 250);
  assert.equal(early.details.user_idle_ms, 1000); assert.match(early.recovery, /not a cooldown/);
  assert.match(early.recovery, /observe the exact target once/);
  const ready = computerUseNoticeFailure({ kind: 'paused', retry_after_ms: 0 }).info;
  assert.equal(ready.details.retry_after_ms, 0, 'a finished quiet period must not be replaced with a new full delay');
  const stop = computerUseNoticeFailure({ kind: 'stopped', reason: 'escape' }).info;
  assert.equal(stop.code, 'user_stopped'); assert.equal(stop.details.retry_after_ms, undefined);
  assert.match(stop.recovery, /do not bypass/);
});

test('native takeover timer expires in one second, physical input resets it, duplicate pause does not', { skip: process.platform !== 'win32', timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-pause-policy-'));
  t.after(async () => { assert.equal(dirname(root), tmpdir()); await rm(root, { recursive: true, force: true }); });
  const file = join(root, 'pause.ps1');
  // Exercise the shipped native implementation without starting its message
  // loop, hooks or windows, and without sending any input to the user's desktop.
  await writeFile(file, `\uFEFF$ErrorActionPreference='Stop'
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing,System.Web.Extensions -TypeDefinition @'
${computerUsePresentationNative}
'@
$flags=[Reflection.BindingFlags]'NonPublic,Static'
$type=[CardBushPresentation]
$paused=$type.GetField('paused',$flags)
$last=$type.GetField('lastHuman',$flags)
$remaining=$type.GetMethod('RemainingUserIdleMs',$flags)
$paused.SetValue($null,$true)
$last.SetValue($null,[DateTime]::UtcNow.AddMilliseconds(-1001))
$expired=$remaining.Invoke($null,@())
$type.GetMethod('Human',$flags).Invoke($null,@($false,'physical_input'))
$fresh=$remaining.Invoke($null,@())
$type.GetField('scope',$flags).SetValue($null,'fixture')
$before=$last.GetValue($null)
$v=New-Object 'System.Collections.Generic.Dictionary[string,object]'
$v['id']=1; $v['op']='pause'; $v['scope']='fixture'
$invokeArgs=New-Object 'object[]' 1
$invokeArgs[0]=$v.PSObject.BaseObject
$type.GetMethod('Command',$flags).Invoke($null,$invokeArgs)
$unchanged=$last.GetValue($null) -eq $before
$last.SetValue($null,[DateTime]::UtcNow.AddMilliseconds(-600))
$partial=$remaining.Invoke($null,@())
$type.GetMethod('Human',$flags).Invoke($null,@($false,'physical_input'))
$reset=$remaining.Invoke($null,@())
$paused.SetValue($null,$false)
$unpaused=$remaining.Invoke($null,@())
[pscustomobject]@{expired=$expired;fresh=$fresh;unchanged=$unchanged;partial=$partial;reset=$reset;unpaused=$unpaused} | ConvertTo-Json -Compress
`);
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', file],
    { windowsHide: true, timeout: 15000, encoding: 'utf8' });
  const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(result.expired, 0); assert.equal(result.unchanged, true);
  assert.ok(result.fresh > 600 && result.fresh <= computerUseUserIdleMs);
  assert.ok(result.partial >= 0 && result.partial <= 400);
  assert.ok(result.reset > result.partial && result.reset <= computerUseUserIdleMs);
  assert.equal(result.unpaused, 0);
});
