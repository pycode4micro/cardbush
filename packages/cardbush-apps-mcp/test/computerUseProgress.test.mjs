import assert from 'node:assert/strict';
import test from 'node:test';
import { ComputerUseSafetyGuard } from '../dist/plugins/computerUseRuntime.js';
import { hasVisualProgress } from '../dist/plugins/computerUseProgress.js';
import { createCardbushAppsServer } from '../dist/index.js';

const bounds = { x: 0, y: 0, width: 960, height: 670 };
const binding = { hwnd: 901, processId: 42, processName: 'fixture', title: 'fixture', bounds, elements: [] };
const evidence = (extra = {}) => ({ source: 'window', target: '42:901', bounds, foreground: true, consistent: true, explicit: true, ...extra });
const signature = Buffer.alloc(128 * 128, 200).toString('base64');
const before = (guard, scope = 'scope') => guard.recordObservation(scope, signature, evidence());
const act = (guard, input, scope = 'scope') => {
  const release = guard.begin(scope, input);
  guard.recordAction(scope, input, true, binding);
  release();
};

test('small text changes are visible but caret and sampling noise are not progress', () => {
  const baseline = Buffer.from(signature, 'base64');
  const text = Buffer.from(baseline), caret = Buffer.from(baseline), noise = Buffer.from(baseline);
  for (let y = 8; y < 12; y++) for (let x = 14; x < 21; x++) text[y * 128 + x] = 50;
  for (let y = 8; y < 12; y++) caret[y * 128 + 14] = 50;
  for (let i = 0; i < noise.length; i++) noise[i] += (i % 3) - 1;
  const region = { x: 0, y: 0, width: 320, height: 120 };
  assert.equal(hasVisualProgress(signature, text.toString('base64'), bounds, region), true);
  assert.equal(hasVisualProgress(signature, caret.toString('base64'), bounds, region), false);
  assert.equal(hasVisualProgress(signature, noise.toString('base64'), bounds, region), false);
  assert.equal(hasVisualProgress(signature, Buffer.alloc(256, 0).toString('base64'), bounds), false);
  assert.equal(hasVisualProgress(signature, text.toString('base64'), bounds, { x: 500, y: 300, width: 120, height: 120 }), false);
});

test('focused control evidence permits continued typing without changing the entire window', () => {
  const guard = new ComputerUseSafetyGuard();
  guard.recordObservation('scope', signature, evidence({ focusedFingerprint: 'empty' }));
  for (let i = 0; i < 6; i++) {
    act(guard, { action: 'type', text: 'a' });
    guard.recordObservation('scope', signature, evidence({ focusedFingerprint: 'a'.repeat(i + 1) }));
  }
  assert.doesNotThrow(() => guard.begin('scope', { action: 'key', keys: ['enter'] })());
});

test('discovery, other windows and capture mode changes cannot wash unverified actions', () => {
  const guard = new ComputerUseSafetyGuard(); before(guard);
  for (let i = 0; i < 4; i++) {
    act(guard, { action: 'click', x: 10 + i, y: 10 });
    guard.recordObservation('scope', Buffer.alloc(128 * 128, i * 50).toString('base64'), { source: 'desktop' });
    guard.recordObservation('scope', 'window-list-hash', { source: 'discovery' });
    guard.recordObservation('scope', Buffer.alloc(128 * 128, i * 50).toString('base64'), evidence({ target: '42:902' }));
    before(guard);
  }
  const input = { action: 'key', key: 'Escape' };
  assert.throws(() => guard.begin('scope', input), e => e.info.code === 'progress_unverified');
  guard.recordObservation('scope', signature, evidence({ explicit: false }));
  assert.throws(() => guard.begin('scope', input), e => e.info.code === 'progress_unverified');
  // The counter still needs the same target and a deliberate review.
  guard.recordObservation('scope', signature, evidence({ target: '42:902' }));
  assert.throws(() => guard.begin('scope', input), e => e.info.code === 'progress_unverified');
});

test('a reviewed corrective action can recover, but cannot replay the last input', () => {
  const guard = new ComputerUseSafetyGuard(); before(guard);
  let last;
  for (let i = 0; i < 4; i++) { last = { action: 'click', x: 20 + i, y: 10 }; act(guard, last); before(guard); }
  const correction = { action: 'key', key: 'escape' };
  assert.throws(() => guard.begin('scope', correction), e => e.info.code === 'progress_unverified');
  before(guard);
  assert.throws(() => guard.begin('scope', last), e => e.info.code === 'progress_unverified');
  act(guard, correction);
  guard.recordObservation('scope', Buffer.alloc(128 * 128, 30).toString('base64'), evidence());
  assert.doesNotThrow(() => guard.begin('scope', { action: 'type', text: 'corrected' })());
});

test('UIA query options cannot disguise repeated dispatched input', () => {
  const guard = new ComputerUseSafetyGuard(); before(guard);
  for (const control_type of ['Edit', 'Button']) {
    act(guard, { action: 'key', key: 'Enter', element_query: { control_type }, element_offset: 10 }); before(guard);
  }
  assert.throws(() => guard.begin('scope', { action: 'key', key: 'Enter', element_offset: 100 }), e => e.info.code === 'policy_blocked');
  guard.releaseObservation('scope');
  assert.throws(() => guard.begin('scope', { action: 'observe', hwnd: 902 }), e => e.info.details.terminal === true);
});

test('passive query loops are bounded even when their target changes', () => {
  const guard = new ComputerUseSafetyGuard();
  for (let i = 0; i < 6; i++) {
    const release = guard.begin('scope', { action: 'observe', hwnd: 900 + i });
    guard.recordObservation('scope', signature, evidence({ target: `42:${900 + i}` })); release();
  }
  assert.throws(() => guard.begin('scope', { action: 'observe', hwnd: 999 }), e => e.info.code === 'policy_blocked' && e.info.details.reason === 'observation_loop');
});

test('UIA filters and offsets require a real target and text evidence', () => {
  const schema = createCardbushAppsServer()._registeredTools.computer_use.inputSchema;
  const base = { action: 'observe', hwnd: 100, include_text: true };
  for (const element_query of [{ name: '文件' }, { automation_id: '1148' }, { control_type: 'Edit', focused: false }]) {
    assert.equal(schema.safeParse({ ...base, element_query }).success, true);
  }
  for (const input of [
    { ...base, element_query: {} }, { ...base, element_query: { name: ' ' } },
    { ...base, element_query: { focused: true }, include_text: false },
    { action: 'observe', include_text: true, element_offset: 10 },
    { ...base, element_offset: -1 }, { ...base, element_offset: 5001 },
  ]) assert.equal(schema.safeParse(input).success, false, JSON.stringify(input));
});

test('verified window movement counts as progress even when its pixels stay the same', () => {
  const guard = new ComputerUseSafetyGuard(); before(guard);
  for (let i = 1; i <= 5; i++) {
    act(guard, { action: 'window', operation: 'move', x: 100 * i, y: 100 });
    guard.recordObservation('scope', signature, evidence({ bounds: { ...bounds, x: 100 * i, y: 100 } }));
  }
  assert.doesNotThrow(() => guard.begin('scope', { action: 'key', key: 'enter' })());
});

test('idle observation eviction and finish cannot expire a terminal block in the same turn', t => {
  const guard = new ComputerUseSafetyGuard(); before(guard);
  const click = { action: 'click', x: 20, y: 10 };
  for (let i = 0; i < 2; i++) { act(guard, click); before(guard); }
  assert.throws(() => guard.begin('scope', click), e => e.info.code === 'policy_blocked');
  const future = Date.now() + 30 * 60_000;
  t.mock.method(Date, 'now', () => future);
  guard.releaseObservation('scope');
  assert.throws(() => guard.begin('scope', { action: 'observe' }), e => e.info.code === 'policy_blocked');
  assert.doesNotThrow(() => guard.begin('new-turn', { action: 'observe' })());
});
