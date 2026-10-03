import assert from 'node:assert/strict';
import test from 'node:test';
import { createCardbushAppsServer } from '../dist/index.js';
import { computerUseDisplaysScript } from '../dist/plugins/computerUseDisplays.js';
import { prepareComputerUseNativeCode } from '../dist/plugins/computerUseNativeCode.js';
import { runComputerUsePowerShell } from '../dist/plugins/computerUsePowerShell.js';
import { computerUseFailure } from '../dist/plugins/computerUseErrors.js';

test('display selection only permits read-only screen observation', () => {
  const schema = createCardbushAppsServer()._registeredTools.computer_use.inputSchema;
  const display_id = '\\\\.\\DISPLAY2';
  for (const action of ['observe', 'screenshot']) assert.equal(schema.safeParse({ action, display_id }).success, true);
  for (const extra of [{ hwnd: 42 }, { app: 'chrome' }, { title_pattern: 'foo' }, { include_screenshot: false, include_text: true },
    { action: 'click', hwnd: 42, state_id: 'state', x: 1, y: 2 }]) {
    assert.equal(schema.safeParse({ action: 'screenshot', display_id, ...extra }).success, false);
  }
  assert.equal(computerUseFailure(new Error('Display layout or DPI changed after observation.')).info.code, 'display_changed');
  assert.equal(computerUseFailure(new Error('Display is no longer available.')).info.code, 'display_changed');
});

test('native display topology detects scaling, negative positions and removal without changing the real desktop', { skip: process.platform !== 'win32' }, async () => {
  const prepared = await prepareComputerUseNativeCode(computerUseDisplaysScript);
  const script = `${prepared}
$actual=[CardBushDesktop]::Read()
[CardBushDesktop]::AssertUnchanged([CardBushDesktop]::Signature($actual),[IntPtr]::Zero,120)
$a=[CardBushDesktop+Display]::new();$a.id='screen-a';$a.primary=$true;$a.scale_percent=125
$a.bounds=[CardBushDesktop+Bounds]::new();$a.bounds.width=1920;$a.bounds.height=1080;$a.work_area=$a.bounds
$b=[CardBushDesktop+Display]::new();$b.id='screen-b';$b.scale_percent=100
$b.bounds=[CardBushDesktop+Bounds]::new();$b.bounds.x=-1920;$b.bounds.width=1920;$b.bounds.height=1080;$b.work_area=$b.bounds
$before=[CardBushDesktop]::Signature(@($a,$b))
$b.scale_percent=150;$scaled=[CardBushDesktop]::Signature(@($a,$b))
$b.bounds.x=1920;$moved=[CardBushDesktop]::Signature(@($a,$b))
$removed=[CardBushDesktop]::Signature(@($a))
$blocked=$false
try {[CardBushDesktop]::AssertUnchanged($before,[IntPtr]::Zero,0)}catch{$blocked=$_.Exception.Message.Contains('Display layout or DPI changed')}
$flat=[Drawing.Bitmap]::new(100,100);$graphics=[Drawing.Graphics]::FromImage($flat)
try {
 $graphics.Clear([Drawing.Color]::White);$uniform=[CardBushDesktop]::Uniform($flat)
 $graphics.FillRectangle([Drawing.Brushes]::Black,35,35,30,30);$pattern=[CardBushDesktop]::Uniform($flat)
 @{before=$before;scaled=$scaled;moved=$moved;removed=$removed;blocked=$blocked;uniform=$uniform;pattern=$pattern;displays=$actual}|ConvertTo-Json -Depth 6 -Compress
}finally{$graphics.Dispose();$flat.Dispose()}`;
  const result = JSON.parse(await runComputerUsePowerShell(script, { cwd: process.cwd(), env: process.env, timeoutMs: 15000 }));
  assert.equal(new Set([result.before, result.scaled, result.moved, result.removed]).size, 4);
  assert.equal(result.blocked, true); assert.equal(result.uniform, true); assert.equal(result.pattern, false);
  assert.ok(result.displays.length > 0);
  for (const display of result.displays) assert.ok(display.id && display.bounds.width > 0 && display.scale_percent > 0);
});
