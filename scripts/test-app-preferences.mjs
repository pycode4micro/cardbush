import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import * as productAgent from '@cardbush/bush-product-agent';
import * as protocol from '@cardbush/bush-protocol';

const require = createRequire(import.meta.url);
const modules = new Map();
function load(file) {
  if (modules.has(file)) return modules.get(file).exports;
  const module = { exports: {} };
  modules.set(file, module);
  const source = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', source)(
    id => id.startsWith('.') ? load(path.resolve(path.dirname(file), id + '.ts'))
      : id === '@cardbush/bush-product-agent' ? productAgent
      : id === '@cardbush/bush-protocol' ? protocol : require(id), module, module.exports);
  return module.exports;
}
const settings = load(path.resolve('src/features/settings/appSettingsStore.ts'));
const models = load(path.resolve('src/features/settings/modelPreferences.ts'));
const projects = load(path.resolve('src/features/sidebar/projectStore.ts'));
const theme = load(path.resolve('src/features/appearance/themePreferences.ts'));
const local = load(path.resolve('src/features/settings/localPreferences.ts'));
function storage(t) {
  const previous = globalThis.window, previousStorage = globalThis.localStorage, values = new Map();
  globalThis.window = { cardbushDesktop: { platform: 'win32' }, dispatchEvent: () => true, localStorage: {
    getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key),
  } };
  globalThis.localStorage = window.localStorage;
  t.after(() => {
    if (previous === undefined) delete globalThis.window; else globalThis.window = previous;
    if (previousStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = previousStorage;
  });
  return values;
}

test('settings retain existing storage keys, defaults and secret redaction', t => {
  const values = storage(t), initial = settings.readInitialAppSettings();
  assert.equal(initial.guidance.deliveryMode, 'queue');
  assert.equal(initial.thinking.visible, false);
  const model = { id: 'provider-a', provider: 'custom', modelName: 'fixture', baseUrl: 'https://example.invalid', apiKey: 'fixture-secret',
    apiProtocol: 'anthropic_messages', defaultHeaders: { 'x-session-id': '{{sessionId}}' }, maxContextTokens: 200000, maxCompletionTokens: 8000 };
  settings.persistAppSettings(settings.normalizeAppSettings({ ...initial, guidance: { deliveryMode: 'immediate' }, managedModelConfigs: [model] }));
  const saved = JSON.parse(values.get('cardbush_managed_model_configs'))[0];
  assert.equal(saved.apiKey, ''); assert.equal(saved.hasApiKey, true);
  assert.equal(saved.apiProtocol, 'anthropic_messages'); assert.deepEqual(saved.defaultHeaders, model.defaultHeaders);
  assert.equal(settings.readInitialAppSettings().guidance.deliveryMode, 'immediate');
  assert.ok(![...values.values()].some(value => value.includes('fixture-secret')));
});

test('legacy credentials migrate only to matching models with missing credentials', t => {
  storage(t);
  const remote = { id: 'one', provider: 'custom', modelName: 'fixture', baseUrl: 'https://example.invalid', apiKey: '', hasApiKey: false };
  const migrated = models.mergeLegacyModelCredentials([remote], [{ ...remote, apiKey: 'fixture-key' }]);
  assert.equal(migrated.changed, true); assert.equal(migrated.models[0].apiKey, 'fixture-key');
  assert.equal(models.mergeLegacyModelCredentials(migrated.models, [{ ...remote, apiKey: 'different' }]).changed, false);
  assert.equal(models.mergeLegacyModelCredentials([remote], [{ ...remote, id: 'other', modelName: 'other', apiKey: 'different' }]).changed, false);
  assert.equal(models.defaultModelConfigId([remote], 'FIXTURE'), 'one');
});

test('legacy themes and project identities survive extraction; corrupt data falls back', t => {
  const values = storage(t);
  values.set('cardbush.theme', 'bright'); assert.equal(theme.readInitialThemePreference(), 'light');
  values.set('cardbush_theme_mode', 'cyberpunk'); assert.equal(theme.readInitialThemePreference(), 'dark');
  values.set('cardbush_language_mode', 'en'); assert.equal(local.readInitialLanguageMode(), 'en');
  values.set('cardbush.sidebar_width', '800'); assert.equal(local.readInitialSidebarWidth(), 420);
  values.set('cardbush_projects', JSON.stringify([{ rootPath: 'C:\\Work\\Sample' }, { rootPath: 'c:/work/sample' }, { rootPath: 'ssh://host/home/User' }]));
  const entries = projects.readProjectItems(); assert.equal(entries.length, 2);
  assert.equal(entries[0].id, 'project-c:/work/sample'); assert.equal(entries[1].id, 'project-ssh://host/home/User');
  projects.persistProjectItems(entries); assert.deepEqual(projects.readProjectItems(), entries);
  values.set('cardbush_projects', '{'); values.set('cardbush_managed_model_configs', '{'); values.set('cardbush_disabled_skills', '{');
  assert.deepEqual(projects.readProjectItems(), []); assert.deepEqual(models.readManagedModelConfigs(), []); assert.equal(local.readDisabledSkillNames().size, 0);
});
