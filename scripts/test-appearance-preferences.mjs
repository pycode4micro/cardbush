import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
function load(file) {
  const source = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', source)(id => id.startsWith('.') ? load(path.resolve(path.dirname(file), id + '.ts')) : require(id), module, module.exports);
  return module.exports;
}
const preferences = load(path.resolve('src/features/appearance/appearancePreferences.ts'));
const { normalizeAppearance, appearanceVariables, appearanceHasCustomPalette, updateAppearanceProfile, setSeparateAppearanceModes, readAppearance, resolveReducedMotion } = preferences;

test('corrupt preferences cannot inject CSS or break typography; older defaults survive', () => {
  const saved = normalizeAppearance({ interfaceSize: Infinity, codeSize: 900, contrast: -3,
    shared: { accent: 'red;display:none', background: 'url(file:///private)', font: 'untrusted', foreground: '#aabbcc' } });
  assert.equal(saved.interfaceSize, 14); assert.equal(saved.codeSize, 20); assert.equal(saved.contrast, 0);
  assert.equal(saved.shared.foreground, '#AABBCC');
  assert.equal(saved.shared.accent, ''); assert.equal(saved.shared.background, '');
  assert.equal(saved.shared.font, 'system');
  assert.equal(normalizeAppearance(null).reducedMotion, 'system');
});

test('separate profiles survive mode changes, shared mode and serialization', () => {
  let state = updateAppearanceProfile(normalizeAppearance(), 'dark', { accent: '#AABBCC' });
  state = setSeparateAppearanceModes(state, true, 'dark');
  state = updateAppearanceProfile(state, 'bright', { background: '#FAFAFA', font: 'serif' });
  state = updateAppearanceProfile(state, 'dark', { background: '#202124', font: 'mono' });
  state = setSeparateAppearanceModes(state, false, 'bright');
  assert.equal(state.shared.font, 'serif');
  state = setSeparateAppearanceModes(normalizeAppearance(JSON.parse(JSON.stringify(state))), true, 'dark');
  assert.equal(state.light.background, '#FAFAFA'); assert.equal(state.dark.background, '#202124');
  assert.equal(state.light.font, 'serif'); assert.equal(state.dark.font, 'mono');
  assert.notEqual(state.light, state.dark);
});

test('an imported palette applies only in its matching mode; explicit edits take precedence', () => {
  const imported = { protocol: 'cardbush.appearance_style.v1', base: 'dark', name: 'Test', sourcePath: '', colors: { background: '#101010', text: '#ffffff', accent: '#123456' } };
  let state = updateAppearanceProfile(normalizeAppearance(), 'dark', { theme: 'imported' });
  assert.equal(appearanceVariables(state, 'dark', imported)['--accent'], '#123456');
  assert.equal(appearanceVariables(state, 'bright', imported)['--bg'], undefined);
  assert.equal(appearanceHasCustomPalette(state, 'bright', imported), false);
  state = updateAppearanceProfile(state, 'dark', { accent: '#ABCDEF', foreground: '#EEEEEE', font: 'imported' });
  const variables = appearanceVariables(state, 'dark', imported, 'My Font');
  assert.equal(variables['--accent'], '#ABCDEF');
  assert.equal(variables['--appearance-accent'], '#ABCDEF');
  assert.equal(variables['--text'], '#EEEEEE');
  assert.equal(variables['--bg'], '#101010', 'changing foreground keeps the imported background');
  assert.match(variables['--app-font-family'], /My Font/);
  assert.equal(variables['--code-font-size'], '12px');
});

test('legacy imported theme/font migrate once and explicit reset remains reset', () => {
  const values = new Map([['cardbush_theme_mode', 'custom'], ['cardbush_font_family', 'Saved Font']]);
  globalThis.localStorage = { getItem: key => values.get(key) ?? null };
  try {
    const migrated = readAppearance();
    assert.equal(migrated.shared.theme, 'imported'); assert.equal(migrated.shared.font, 'imported');
    values.set(preferences.APPEARANCE_STORAGE_KEY, JSON.stringify(normalizeAppearance()));
    assert.equal(readAppearance().shared.theme, 'default'); assert.equal(readAppearance().shared.font, 'system');
    values.set(preferences.APPEARANCE_STORAGE_KEY, '{broken');
    assert.equal(readAppearance().shared.theme, 'imported');
  } finally { delete globalThis.localStorage; }
});

test('reduce motion obeys explicit On and Off before the system setting', () => {
  for (const system of [true, false]) {
    assert.equal(resolveReducedMotion('on', system), true);
    assert.equal(resolveReducedMotion('off', system), false);
    assert.equal(resolveReducedMotion('system', system), system);
  }
  const { prefersReducedMotion } = load(path.resolve('src/shared/motionPreference.ts'));
  globalThis.window = { matchMedia: () => ({ matches: true }) };
  globalThis.document = { documentElement: { dataset: { motionPreference: 'off' } } };
  try {
    assert.equal(prefersReducedMotion(), false);
    document.documentElement.dataset.motionPreference = 'on'; assert.equal(prefersReducedMotion(), true);
    document.documentElement.dataset.motionPreference = 'system'; assert.equal(prefersReducedMotion(), true);
  } finally { delete globalThis.window; delete globalThis.document; }
});
