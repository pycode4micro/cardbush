import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { defaultAppsRuntimeConfig } from '../dist/index.js';
import { ComputerUseSafetyGuard, executeComputerUse, windowStateCaptureScript } from '../dist/plugins/computerUseRuntime.js';
import { computerUseCaptureLayersScript } from '../dist/plugins/computerUseCaptureLayers.js';
import { computerUseVisualProgressScript } from '../dist/plugins/computerUseProgress.js';
import { computerUseDisplaysScript } from '../dist/plugins/computerUseDisplays.js';
import { computerUsePresentation } from '../dist/plugins/computerUsePresentation.js';
import { prepareComputerUseNativeCode } from '../dist/plugins/computerUseNativeCode.js';
import { runComputerUsePowerShell } from '../dist/plugins/computerUsePowerShell.js';
import { launchDesktopFixture } from './helpers/desktopFixture.mjs';

if (process.platform !== 'win32') { console.log('SKIP: Windows desktop required'); process.exit(0); }
const root = await mkdtemp(join(tmpdir(), 'cardbush-displays-fixture-'));
const config = { ...defaultAppsRuntimeConfig().computerUse.config, screenshotDirectory: root, yieldToUser: false };
const fixture = launchDesktopFixture(), scope = `displays-${Date.now()}`, checks = [];
const call = input => executeComputerUse(input, config, undefined, scope);
const pass = name => { checks.push(name); console.log('PASS', name); };
const run = async (script, parameters = {}) => runComputerUsePowerShell(await prepareComputerUseNativeCode(script), {
  cwd: process.cwd(), env: process.env, timeoutMs: 20000, parameters,
});
const bind = (state, input) => ({ hwnd: state.window.hwnd, state_id: state.state_id, ...input });
try {
  const { hwnd } = await fixture.ready;
  const discovery = await call({ action: 'observe' });
  assert.ok(discovery.output.displays.length >= 1);
  pass('discovery exposes physical display geometry and scale');
  let state = (await call({ action: 'observe', hwnd, include_text: true })).output;
  let count = 0;
  for (const display of discovery.output.displays) {
    const moved = await call(bind(state, { action: 'window', operation: 'move', x: display.work_area.x + 40, y: display.work_area.y + 40, include_text: true }));
    assert.equal(moved.error, undefined, JSON.stringify(moved.error));
    state = moved.output.observation;
    assert.equal(state.display_id, display.id);
    assert.ok(state.window_dpi > 0 && state.display_signature);
    const image = await sharp(state.path).metadata();
    assert.equal(image.width, state.image.width); assert.equal(image.height, state.image.height);
    assert.equal(state.image.scale, 1);
    const button = state.accessibility.elements.find(item => item.automation_id === 'fixture-button');
    assert.ok(button?.bounds);
    const clicked = await call(bind(state, { action: 'click', x: Math.round(button.bounds.x + button.bounds.width / 2),
      y: Math.round(button.bounds.y + button.bounds.height / 2), include_text: true }));
    assert.equal(clicked.error, undefined, JSON.stringify(clicked.error));
    assert.equal((await fixture.command('inspect')).count, ++count, 'fixture independently confirms the click');
    state = clicked.output.observation;
    pass(`physical coordinate click on ${display.id} at ${display.scale_percent}%`);
  }
  const parameters = { CARDBUSH_WINDOW_HWND: String(hwnd), CARDBUSH_CAPTURE_PATH: join(root, 'fallback.png'), CARDBUSH_INCLUDE_SCREENSHOT: '1' };
  const prefix = `${computerUseCaptureLayersScript}\n${computerUseVisualProgressScript}\n`;
  const failed = windowStateCaptureScript.replace('[CardBushWindowCapture]::PrintWindow($h, $hdc, 2)', '$false');
  assert.notEqual(failed, windowStateCaptureScript);
  const visible = JSON.parse(await run(prefix + failed, parameters));
  assert.equal(visible.capture_method, 'visible_window'); assert.equal(visible.visual_evidence_verified, true);
  pass('PrintWindow failure recovers only from a verified visible target');
  const blank = windowStateCaptureScript.replace('$uniform = [CardBushDesktop]::Uniform($bitmap)', '$graphics.Clear([Drawing.Color]::Black)\n$uniform = [CardBushDesktop]::Uniform($bitmap)');
  const recovered = JSON.parse(await run(prefix + blank, { ...parameters, CARDBUSH_CAPTURE_PATH: join(root, 'blank-recovery.png') }));
  assert.equal(recovered.capture_method, 'visible_window'); assert.equal(recovered.capture_quality, 'nonuniform');
  pass('uniform PrintWindow frame is verified and recovered');
  await fixture.command('overlap');
  const blockedPath = join(root, 'must-not-exist.png');
  await assert.rejects(run(prefix + failed, { ...parameters, CARDBUSH_CAPTURE_PATH: blockedPath }), /capture failed/);
  await assert.rejects(readFile(blockedPath), { code: 'ENOENT' });
  pass('overlap blocks fallback without returning another window');
  await fixture.command('uncover');
  const guarded = await run(`${computerUseDisplaysScript}
$h=[IntPtr]${hwnd};$signature=[CardBushDesktop]::Signature([CardBushDesktop]::Read());$dpi=[CardBushDesktop]::WindowDpi($h)
[CardBushDesktop]::AssertUnchanged($signature,$h,$dpi)
$blocked=$false;try{[CardBushDesktop]::AssertUnchanged($signature,$h,($dpi+1))}catch{$blocked=$true}
@{blocked=$blocked}|ConvertTo-Json -Compress`);
  assert.equal(JSON.parse(guarded).blocked, true);
  pass('changed window DPI invalidates observation before input');
  await call({ action: 'finish' });
  // Simulate stale private observation metadata through the complete action path,
  // without changing the user's display configuration or adding a production hook.
  for (const kind of ['layout', 'dpi', 'unverified pixels']) {
    const isolatedScope = `${scope}-${kind}`;
    const isolated = input => executeComputerUse(input, config, undefined, isolatedScope);
    const observed = (await isolated({ action: 'observe', hwnd, include_text: true })).output;
    const button = observed.accessibility.elements.find(item => item.automation_id === 'fixture-button');
    const before = await fixture.command('inspect');
    const claim = ComputerUseSafetyGuard.prototype.claimObservation;
    ComputerUseSafetyGuard.prototype.claimObservation = function (...args) {
      const binding = claim.apply(this, args);
      if (args[0] !== isolatedScope) return binding;
      return { ...binding, ...(kind === 'layout' ? { displaySignature: 'stale-fixture-layout' }
        : kind === 'dpi' ? { windowDpi: binding.windowDpi + 1 } : { visualVerified: false }) };
    };
    try {
      await assert.rejects(isolated(bind(observed, { action: 'click', observe_after: false,
        x: Math.round(button.bounds.x + button.bounds.width / 2), y: Math.round(button.bounds.y + button.bounds.height / 2) })),
      error => error.info?.code === (kind === 'unverified pixels' ? 'observation_failed' : 'display_changed'));
      const after = await fixture.command('inspect');
      assert.equal(after.count, before.count);
      assert.deepEqual([after.x, after.y], [before.x, before.y]);
      pass(`${kind} change blocks the real action path without input`);
    } finally {
      ComputerUseSafetyGuard.prototype.claimObservation = claim;
      await isolated({ action: 'finish' });
    }
  }
  // Cover the selected screen with the fixture before exercising per-display capture.
  state = (await call({ action: 'observe', hwnd, include_text: true })).output;
  await call(bind(state, { action: 'window', operation: 'maximize' }));
  const last = discovery.output.displays.at(-1);
  const screen = await call({ action: 'screenshot', display_id: last.id });
  assert.equal(screen.error, undefined);
  assert.equal(screen.output.display_id, last.id); assert.equal(screen.output.width, last.bounds.width);
  assert.equal(screen.output.height, last.bounds.height); assert.equal(screen.output.image.origin.x, last.bounds.x);
  assert.equal(screen.output.actionable, false); assert.equal(screen.output.state_id, undefined);
  pass('single display capture preserves physical dimensions and desktop origin');
  await assert.rejects(call({ action: 'screenshot', display_id: 'removed-display-fixture' }),
    error => error.info?.code === 'display_changed' && error.info?.execution === 'not_dispatched');
  pass('removed display does not silently capture another screen');
  await writeFile(join(root, 'report.json'), JSON.stringify({ checks, displays: discovery.output.displays }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, report: join(root, 'report.json') }));
} finally {
  await call({ action: 'finish' }).catch(() => {});
  computerUsePresentation.dispose();
  await fixture.close();
}
