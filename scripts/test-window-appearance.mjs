import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveWindowAppearance, WindowAppearanceController } from '../dist-electron/windowAppearance.js';

const input = {
  theme: 'dark', preference: 'auto', customTheme: false,
  platform: 'win32', release: '10.0.26200', reducedTransparency: false,
  highContrast: false, gpuCompositing: 'enabled',
};

test('native backdrop requires OS, compositor, theme and accessibility support', () => {
  assert.equal(resolveWindowAppearance(input).material, 'mica');
  assert.equal(resolveWindowAppearance({ ...input, theme: 'bright' }).material, 'mica');
  for (const patch of [
    { platform: 'linux' }, { platform: 'darwin' }, { release: '10.0.22000' },
    { release: 'unknown' }, { preference: 'solid' }, { customTheme: true },
    { theme: 'cyberpunk' }, { theme: 'parchment' }, { reducedTransparency: true },
    { highContrast: true }, { gpuCompositing: 'disabled_software' },
  ]) assert.equal(resolveWindowAppearance({ ...input, ...patch }).material, 'none', JSON.stringify(patch));
});

function fixture({ fails = false } = {}) {
  const calls = [], errors = [];
  const target = {
    isDestroyed: () => false,
    setBackgroundColor: value => calls.push(['window', value]),
    contentView: { setBackgroundColor: value => calls.push(['view', value]) },
    setBackgroundMaterial: value => {
      calls.push(['material', value]);
      if (value === 'mica' && fails) throw Error('Native backdrop unavailable');
    },
  };
  return { calls, errors, target, controller: new WindowAppearanceController(target, 'win32', error => errors.push(error)) };
}

test('focus/restore does not repeatedly recreate a material; disabling restores both opaque layers', () => {
  const { calls, controller } = fixture();
  const mica = resolveWindowAppearance(input);
  controller.apply(mica, '#1a1a1a');
  for (let i = 0; i < 20; i++) controller.apply(mica, '#1a1a1a');
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.slice(0, 2), [['window', '#00000000'], ['view', '#00000000']]);
  controller.apply(resolveWindowAppearance({ ...input, preference: 'solid' }), '#1a1a1a');
  assert.deepEqual(calls.slice(-3), [['material', 'none'], ['window', '#1a1a1a'], ['view', '#1a1a1a']]);
  controller.apply(resolveWindowAppearance({ ...input, theme: 'bright' }), '#f5f3ef');
  assert.equal(calls.at(-1)[1], 'mica');
});

test('failed native material is reported once and leaves a readable opaque window without reload', () => {
  const { calls, errors, controller, target } = fixture({ fails: true });
  const mica = resolveWindowAppearance(input);
  assert.equal(controller.apply(mica, '#1a1a1a').material, 'none');
  assert.equal(controller.apply(mica, '#1a1a1a').material, 'none');
  assert.equal(errors.length, 1);
  assert.deepEqual(calls.slice(-3), [['material', 'none'], ['window', '#1a1a1a'], ['view', '#1a1a1a']]);
  const count = calls.length;
  target.isDestroyed = () => true;
  controller.apply(mica, '#1a1a1a');
  assert.equal(calls.length, count);
});
