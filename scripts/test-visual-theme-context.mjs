import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { VisualThemeContextStore } from '../dist-electron/visualThemeContext.js';
import { visualThemeTokens } from '../dist-electron/visualThemeContextSchema.js';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cardbush-theme-context-'));
try {
  const target = path.join(directory, 'appearance', 'current-theme.json');
  const store = new VisualThemeContextStore(target);
  const snapshot = {
    theme: 'dark', preference: 'system', colorScheme: 'dark',
    background: 'rgb(26, 26, 26)', fontFamily: 'Segoe UI, sans-serif',
    tokens: Object.fromEntries(visualThemeTokens.map(token => [token, '#abcdef'])),
    ignoredPrivateSetting: 'must not be published',
  };
  await Promise.all([
    store.write(snapshot),
    store.write({...snapshot, theme:'bright', preference:'custom', colorScheme:'light',background:'rgb(240, 244, 248)'}),
  ]);
  const context = JSON.parse(await fs.readFile(target, 'utf8'));
  assert.equal(context.theme, 'bright', 'latest theme wins ordered concurrent updates');
  assert.equal(context.preference, 'custom');
  assert.equal(context.version, 1);
  assert.ok(Number.isFinite(Date.parse(context.updatedAt)));
  assert.equal(context.ignoredPrivateSetting, undefined, 'only presentation fields are written');
  assert.throws(() => store.write({...snapshot, theme:'invented'}), /Invalid/);
  assert.throws(() => store.write({...snapshot, tokens:{}}), /Invalid/);
  const read = env => spawnSync(process.execPath, ['assets/skills/visualize/scripts/read_theme.mjs'], {
    env: {...process.env, ...env}, encoding:'utf8', windowsHide:true,
  });
  const result = read({CARDBUSH_THEME_CONTEXT_PATH:target});
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {sourcePath:target,...context}, 'shipped skill reads the published theme');
  const missing = read({CARDBUSH_THEME_CONTEXT_PATH:path.join(directory,'missing.json')});
  assert.equal(missing.status, 1, 'missing snapshots do not silently become a guessed dark or light theme');
  assert.match(missing.stderr, /Do not assume a theme/);
  console.log('Visual theme context passed: computed snapshot contract, ordered atomic writes, skill lookup and unavailable-theme handling.');
} finally {
  assert.equal(path.dirname(directory), os.tmpdir());
  assert.ok(path.basename(directory).startsWith('cardbush-theme-context-'));
  await fs.rm(directory, {recursive:true,force:true});
}
