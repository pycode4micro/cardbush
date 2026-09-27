// Opt-in desktop regression: only the disposable fixture receives input.
// Clipboard contents are kept inside that fixture and restored if still owned.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchDesktopFixture } from './helpers/desktopFixture.mjs';
import { executeComputerUse } from '../dist/plugins/computerUseRuntime.js';
import { computerUsePresentation } from '../dist/plugins/computerUsePresentation.js';
import { defaultAppsRuntimeConfig } from '../dist/config.js';

if (process.platform !== 'win32') throw new Error('Windows required');
const directory = await mkdtemp(join(tmpdir(), 'cardbush-native-capabilities-'));
const fixture = launchDesktopFixture();
const scope = `capabilities-${randomUUID()}`;
const config = { ...defaultAppsRuntimeConfig().computerUse.config, screenshotDirectory: directory };
let clipboardSaved = false;
const samples = [], checks = [];
const pass = name => { checks.push(name); console.log('PASS', name); };
const call = async input => {
  const result = await executeComputerUse(input, config, undefined, scope);
  samples.push({ action: input.action, ...result.timings });
  return result;
};
const bind = (state, input) => ({ hwnd: state.window.hwnd, state_id: state.state_id, include_text: true, ...input });
const element = (state, id) => {
  const found = state.accessibility?.elements.find(item => item.automation_id === id);
  assert.ok(found, `Missing ${id}`); return found;
};
try {
  const { hwnd } = await fixture.ready;
  let state = (await call({ action: 'observe', hwnd, include_text: true })).output;
  const input = element(state, 'fixture-input');
  const region = Object.fromEntries(Object.entries(input.bounds).map(([key, value]) => [key, Math.round(value)]));
  const enlarged = await call({ action: 'observe', hwnd, include_text: true, region, scale: 2 });
  state = enlarged.output;
  assert.deepEqual(state.image.origin, { x: region.x, y: region.y });
  assert.equal(state.image.scale, 2); assert.equal(state.coordinate_space, 'window');
  const png = await readFile(enlarged.paths[0]);
  assert.equal(png.readUInt32BE(16), region.width * 2); assert.equal(png.readUInt32BE(20), region.height * 2);
  assert.equal(state.accessibility.elements.find(item => item.automation_id === 'fixture-input').bounds.x, input.bounds.x);
  pass('region image dimensions and coordinate mapping preserve original UIA coordinates');

  await fixture.command('saveClipboard');
  clipboardSaved = true;
  const text = '中文🙂 clipboard\nsecond line';
  await fixture.command('expectClipboard', { text });
  const copied = await call(bind(state, { action: 'clipboard', text }));
  assert.equal(copied.output.verified, true); assert.equal(copied.output.pasted, false);
  assert.equal(copied.timings.process_count, 1); assert.equal(copied.timings.compile_ms, 0);
  assert.equal((await fixture.command('inspect')).text, '');
  state = copied.output.observation;
  assert.ok(state.state_id);
  const pasted = await call(bind(state, { action: 'key', keys: ['ctrl', 'v'] }));
  state = pasted.output.observation;
  assert.equal((await fixture.command('inspect')).text.replaceAll('\r\n', '\n'), text);
  assert.equal(pasted.timings.process_count, 1);
  pass('Unicode multiline clipboard persists after worker exit; a separate guarded paste reaches the target');

  const files = [join(directory, '中文附件.txt'), join(directory, 'second file.txt')];
  for (const file of files) await writeFile(file, 'fixture contents');
  await fixture.command('expectClipboard', { files });
  const fileCopy = await call(bind(state, { action: 'clipboard', files }));
  assert.equal(fileCopy.output.file_count, 2); assert.equal(fileCopy.output.pasted, false);
  assert.deepEqual((await fixture.command('inspect')).pastedFiles, []);
  state = fileCopy.output.observation;
  const filePaste = await call(bind(state, { action: 'key', keys: ['ctrl', 'v'] }));
  state = filePaste.output.observation;
  assert.deepEqual((await fixture.command('inspect')).pastedFiles, files);
  for (const file of files) assert.equal(await readFile(file, 'utf8'), 'fixture contents');
  pass('CF_HDROP survives process exit; files remain intact and are pasted only by the separate key action');

  await fixture.command('popupOnClick');
  const popup = await call(bind(state, { action: 'invoke', element_index: element(state, 'fixture-button').index, region, scale: 2 }));
  state = popup.output.observation;
  assert.equal(state.target_relation, 'owned_popup'); assert.notEqual(state.window.hwnd, hwnd);
  assert.equal(state.image.region_reset, true); assert.deepEqual(state.image.origin, { x: 0, y: 0 });
  assert.equal(state.image.scale, 1); assert.equal((await fixture.command('inspect')).count, 1);
  pass('an owned popup resets the old crop and is never clicked twice to recover observation');

  const restored = await fixture.command('restoreClipboard');
  assert.equal(restored.clipboardRestore, 'restored', 'Clipboard cleanup must verify the copied data and restore its backup');
  clipboardSaved = false;
  pass('clipboard backup is restored after Unicode text and file-list tests');
  console.log(JSON.stringify({ passed: true, checks, timings: samples, artifacts: directory }));
} finally {
  await executeComputerUse({ action: 'finish' }, config, undefined, scope).catch(() => undefined);
  if (clipboardSaved) {
    const restored = await fixture.command('restoreClipboard').catch(error => { console.error('Clipboard restore:', error.message); return undefined; });
    console.log('Clipboard cleanup:', restored?.clipboardRestore ?? 'failed');
  }
  computerUsePresentation.dispose(); fixture.close();
}
