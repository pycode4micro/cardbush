import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { prepareComputerUseNativeCode, quotePowerShell } from '../dist/plugins/computerUseNativeCode.js';
import { runComputerUsePowerShell } from '../dist/plugins/computerUsePowerShell.js';
import { collectComputerUseTimings } from '../dist/plugins/computerUseTimings.js';
import { validateClipboardInput, ComputerUseSafetyGuard } from '../dist/plugins/computerUseRuntime.js';
import { computerUseImageScript, saveComputerUseImageScript } from '../dist/plugins/computerUseImage.js';
import { createCardbushAppsServer } from '../dist/index.js';

const windows = { skip: process.platform !== 'win32' };
const run = (script, extra = {}) => runComputerUsePowerShell(script, {
  cwd: process.cwd(), env: process.env, timeoutMs: 10_000, ...extra,
});
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'cardbush-capability-test-'));
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'cardbush-capability-test-'));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test('clipboard schema requires one payload and a fresh exact target; image options require an image', () => {
  const schema = createCardbushAppsServer()._registeredTools.computer_use.inputSchema;
  const target = { action: 'clipboard', hwnd: 123, state_id: 'state' };
  assert.equal(schema.safeParse({ ...target, text: '你好\nworld' }).success, true);
  assert.equal(schema.safeParse({ ...target, files: ['C:\\example.txt'] }).success, true);
  for (const invalid of [target, { ...target, text: 'x', files: ['C:\\x'] }, { ...target, files: [] },
    { ...target, text: 'x', state_id: undefined }, { action: 'type', text: 'x', files: ['C:\\x'], hwnd: 123, state_id: 'state' }]) {
    assert.equal(schema.safeParse(invalid).success, false);
  }
  const observe = { action: 'observe', hwnd: 123, region: { x: 10, y: 20, width: 100, height: 50 }, scale: 2, grid: true };
  assert.equal(schema.safeParse(observe).success, true);
  for (const invalid of [{ ...observe, hwnd: undefined }, { ...observe, scale: 1.5 },
    { ...observe, include_text: true, include_screenshot: false }, { ...observe, region: { x: -1, y: 0, width: 1, height: 1 } }]) {
    assert.equal(schema.safeParse(invalid).success, false);
  }
});

test('clipboard validates existing files before native dispatch, without modifying their contents', windows, async t => {
  const directory = await temporary(t), path = join(directory, '中文 file.txt');
  await writeFile(path, 'original');
  await validateClipboardInput({ files: [path] });
  await validateClipboardInput({ text: 'literal\ntext' });
  for (const input of [{ files: [directory] }, { files: [join(directory, 'missing')] }, { files: ['relative.txt'] },
    { files: ['\\\\.\\CON'] }, { text: 'x\0y' }, { text: 'x', files: [path] }]) await assert.rejects(validateClipboardInput(input));
  assert.equal((await stat(path)).size, 8);
});

test('changing region, scale or grid cannot evade repeated input checks', () => {
  const guard = new ComputerUseSafetyGuard();
  const input = { action: 'click', hwnd: 1, x: 20, y: 30 };
  guard.recordAction('region', { ...input, region: { x: 0, y: 0, width: 60, height: 60 }, scale: 1 });
  guard.recordAction('region', { ...input, region: { x: 5, y: 5, width: 50, height: 50 }, scale: 2, grid: true });
  assert.throws(() => guard.begin('region', { ...input, scale: 3 }), /repeated action/);
});

test('immutable native libraries are reused by independent processes and change with the source', windows, async t => {
  const directory = await temporary(t);
  const source = "Add-Type -TypeDefinition @'\npublic static class CacheFixture { public static int Value(){return 17;} }\n'@\n[CacheFixture]::Value()";
  const prepared = await prepareComputerUseNativeCode(source, directory);
  const [dll] = (await readdir(directory)).filter(file => file.endsWith('.dll'));
  const before = (await stat(join(directory, dll))).mtimeMs;
  const [again, concurrent] = await Promise.all([
    prepareComputerUseNativeCode(source, directory), prepareComputerUseNativeCode(source, directory),
  ]);
  assert.equal(prepared, again); assert.equal(again, concurrent);
  assert.equal((await stat(join(directory, dll))).mtimeMs, before);
  const first = await run(prepared + '\n$PID');
  const second = await run(prepared + '\n$PID');
  const a = first.trim().split(/\s+/), b = second.trim().split(/\s+/);
  assert.equal(a[0], '17'); assert.equal(b[0], '17'); assert.notEqual(a[1], b[1]);
  for (const pid of [a[1], b[1]]) assert.throws(() => process.kill(Number(pid), 0), { code: 'ESRCH' });
  const changed = await prepareComputerUseNativeCode(source.replace('return 17', 'return 18'), directory);
  assert.equal((await run(changed)).trim(), '18');
  assert.equal((await readdir(directory)).filter(file => file.endsWith('.dll')).length, 2);
  const other = await prepareComputerUseNativeCode(source.replaceAll('CacheFixture', 'SecondFixture').replace('return 17', 'return 19'), directory);
  assert.deepEqual((await run(prepared+'\n'+other)).trim().split(/\s+/), ['17', '19'], 'different helper assemblies coexist in one request');
});

test('an action ACK is processed before observation in the same process, and failure never repeats the action', windows, async () => {
  let calls = 0, acknowledged;
  const result = await collectComputerUseTimings(() => run(`
$ack=@{pid=$PID;count=1}|ConvertTo-Json -Compress
[Console]::Out.WriteLine('CARDBUSH_ACTION_COMPLETED:'+$ack)
[Console]::Out.Flush()
if([Console]::In.ReadLine() -ne 'observe'){throw 'missing ACK'}
$script:CardBushTimings.input_ms=4
@{pid=$PID;count=1;observed=$true}|ConvertTo-Json -Compress`, {
    afterAction: async ack => { calls++; acknowledged = ack; await new Promise(resolve => setTimeout(resolve, 30)); },
  }));
  const observation = JSON.parse(result.value);
  assert.equal(calls, 1); assert.equal(observation.pid, acknowledged.pid); assert.equal(observation.count, 1);
  assert.equal(result.timings.process_count, 1); assert.equal(result.timings.input_ms, 4);
  assert.ok(result.timings.process_start_ms > 0 && result.timings.total_ms >= result.timings.process_start_ms);
  let ackBeforeFailure = 0;
  await assert.rejects(run(`[Console]::Out.WriteLine('CARDBUSH_ACTION_COMPLETED:{"done":true}')
[Console]::Out.Flush()
[void][Console]::In.ReadLine()
throw 'capture failed after input'`, { afterAction: async () => { ackBeforeFailure++; } }), /capture failed after input/);
  assert.equal(ackBeforeFailure, 1);
  await assert.rejects(run(`[Console]::Out.WriteLine('CARDBUSH_ACTION_COMPLETED:{}')
[Console]::Out.Flush()
[void][Console]::In.ReadLine()`, { afterAction: async () => { throw new Error('lease released with error'); } }), /lease released with error/);
});

test('region images have exact scaled coordinates and leave original pixels unchanged; grid is opt-in', windows, async t => {
  const directory = await temporary(t), clean = join(directory, 'clean.png'), grid = join(directory, 'grid.png');
  const prepared = await prepareComputerUseNativeCode(computerUseImageScript, directory);
  const result = JSON.parse(await run(`Add-Type -AssemblyName System.Drawing
${prepared}
$bitmap=[Drawing.Bitmap]::new(160,120)
$g=[Drawing.Graphics]::FromImage($bitmap)
try {
 $g.Clear([Drawing.Color]::White)
 $g.FillRectangle([Drawing.Brushes]::Red,40,30,10,10)
 [CardBushCaptureImage]::Save($bitmap,${quotePowerShell(clean)},25,15,100,60,2,$false)
 [CardBushCaptureImage]::Save($bitmap,${quotePowerShell(grid)},25,15,100,60,2,$true)
 $image=[Drawing.Bitmap]::new(${quotePowerShell(clean)})
 try { @{width=$image.Width;height=$image.Height;red=$image.GetPixel(40,40).ToArgb();white=$image.GetPixel(0,0).ToArgb();source=$bitmap.GetPixel(45,35).ToArgb()}|ConvertTo-Json -Compress }
 finally {$image.Dispose()}
} finally {$g.Dispose();$bitmap.Dispose()}`));
  assert.equal(result.width, 200); assert.equal(result.height, 120);
  assert.equal(result.red, -65536); assert.equal(result.source, -65536); assert.equal(result.white, -1);
  assert.notEqual((await stat(clean)).size, (await stat(grid)).size);
  await assert.rejects(run(`Add-Type -AssemblyName System.Drawing
${prepared}
$bitmap=[Drawing.Bitmap]::new(160,120)
try {[CardBushCaptureImage]::Save($bitmap,${quotePowerShell(clean)},150,15,100,60,2,$false)} finally {$bitmap.Dispose()}`), /outside the captured window/);
});

test('native observation parameters crop, reset for a popup and surface storage failures after the action ACK', windows, async t => {
  const directory = await temporary(t), path = join(directory, 'new folder', 'region.png');
  const prepared = await prepareComputerUseNativeCode(computerUseImageScript, directory);
  const observation = `Add-Type -AssemblyName System.Drawing
${prepared}
$bitmap=[Drawing.Bitmap]::new(160,120);$width=160;$height=120;$h=[IntPtr]456
try { ${saveComputerUseImageScript}
  $imageMapping | ConvertTo-Json -Compress
} finally {$bitmap.Dispose()}`;
  const parameters = { CARDBUSH_WINDOW_HWND: '456', CARDBUSH_CAPTURE_PATH: path,
    CARDBUSH_IMAGE_OPTIONS: JSON.stringify({ region: { x: 25, y: 15, width: 100, height: 60 }, scale: 2 }),
    CARDBUSH_FOLLOW_OWNED_WINDOW: '1' };
  const crop = JSON.parse(await run(observation, { parameters }));
  assert.deepEqual(crop.origin, { x: 25, y: 15 });
  assert.equal(crop.width, 200); assert.equal(crop.height, 120); assert.equal(crop.scale, 2);
  assert.equal(crop.region_reset, false);
  const popup = JSON.parse(await run(observation, { parameters: { ...parameters, CARDBUSH_WINDOW_HWND: '123' } }));
  assert.deepEqual(popup.origin, { x: 0, y: 0 });
  assert.equal(popup.width, 160); assert.equal(popup.height, 120); assert.equal(popup.scale, 1);
  assert.equal(popup.region_reset, true);
  let acknowledged = 0;
  await assert.rejects(run(`[Console]::Out.WriteLine('CARDBUSH_ACTION_COMPLETED:{"done":true}')
[Console]::Out.Flush()
[void][Console]::In.ReadLine()
${observation}`, {
    parameters: { ...parameters, CARDBUSH_CAPTURE_PATH: join(path, 'cannot-write.png') },
    afterAction: async () => { acknowledged++; },
  }), /directory|目录|CreateDirectory/);
  assert.equal(acknowledged, 1);
});
