import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const types = read('src', 'types.ts');
const runtime = read('src', 'features', 'appearance', 'themeRuntime.ts');
const app = read('src', 'App.tsx');
const settings = read('src', 'features', 'SettingsView.tsx');
const renderer = read('src', 'main.tsx');
const startup = read('index.html');
const electronMain = read('electron', 'main.ts');
const preload = read('electron', 'preload.ts');
const electronTypes = read('src', 'types', 'electron.d.ts');
const shadow = read('src', 'ShadowWindow.tsx');
const cardling = read('src', 'CardlingWindow.tsx');
const theme = read('src', 'styles', 'themes', 'cyberpunk.css');
const skill = read('assets', 'skills', 'cardbush-style-management', 'SKILL.md');
const skillReference = read(
  'assets', 'skills', 'cardbush-style-management', 'references', 'theme-contract.md',
);

assert.match(types, /ThemeMode\s*=\s*[^;]*'cyberpunk'/);
assert.match(types, /ThemePreference\s*=\s*[^;]*'cyberpunk'/);
assert.match(runtime, /cyberpunk:\s*'#050607'/);
assert.match(runtime, /theme === 'cyberpunk'[\s\S]*?'theme-dark theme-cyberpunk'/);
assert.match(app, /stored === 'cyberpunk'/);
assert.match(app, /preference === 'cyberpunk'/);
assert.match(app, /themeClassNames\(theme\)/);
assert.match(settings, /value="cyberpunk"/);
assert.match(settings, /onThemePreferenceChange\('cyberpunk'\)/);
assert.match(renderer, /styles\/themes\/cyberpunk\.css/);
assert.match(startup, /cyberpunk:\s*'#050607'/);
assert.match(startup, /preference === 'cyberpunk'/);
assert.match(startup, /data-start-theme='cyberpunk'/);
assert.match(electronMain, /cyberpunk:\s*'#050607'/);
assert.match(electronMain, /input\.theme === 'cyberpunk'/);
assert.match(electronMain, /payload\.theme === 'cyberpunk'/);
assert.match(electronMain, /theme === 'cyberpunk'/);
assert.match(preload, /'dark' \| 'cyberpunk'/);
assert.match(electronTypes, /'dark' \| 'cyberpunk'/);
assert.match(shadow, /themeClassNames\(context\?\.theme \?\? 'dark'\)/);
assert.match(shadow, /themeBackgroundColor\(payload\.theme\)/);
assert.match(cardling, /themeClassNames\(state\.theme\)/);

for (const token of [
  '--bg', '--surface', '--surface-strong', '--surface-raised', '--border',
  '--accent', '--accent-soft', '--text', '--text-mid', '--text-soft',
  '--user-bubble', '--terminal-bg', '--danger', '--wallpaper-accent-rgb',
]) {
  assert.ok(theme.includes(`${token}:`), `cyberpunk theme must define ${token}`);
}
assert.match(theme, /\.app\.theme-cyberpunk \.composer-surface/);
assert.match(theme, /\.app\.theme-cyberpunk \.welcome-project-switcher/);
assert.match(theme, /\.app\.theme-cyberpunk \.welcome-project-menu/);
assert.match(theme, /\.app\.theme-cyberpunk \.right-inspector-tab\.active/);
assert.match(theme, /\.app\.theme-cyberpunk \.settings-card/);
assert.match(theme, /\.app\.theme-cyberpunk \.composer-runtime-screen/);
assert.match(theme, /\.app\.theme-cyberpunk \.composer-runtime-screen\.processing/);
assert.match(theme, /\.app\.theme-cyberpunk \.composer-runtime-screen\.changes/);
assert.match(theme, /\.app\.theme-cyberpunk \.runtime-context-panel/);
assert.match(theme, /\.app\.theme-cyberpunk \.runtime-queue-guide/);
assert.match(theme, /\.app\.theme-cyberpunk \.guidance-delivery-status/);
assert.match(theme, /\.app\.theme-cyberpunk \.guidance-dialog textarea/);
assert.match(theme, /\.app\.theme-cyberpunk \.guidance-mode-options button\.active/);
assert.match(theme, /prefers-reduced-motion/);
assert.doesNotMatch(theme, /url\s*\(/i, 'built-in theme must not load remote or local art assets');
assert.doesNotMatch(theme, /@keyframes/i, 'theme must not add perpetual decorative animations');

assert.match(skill, /^---[\s\S]*?name:\s*cardbush-style-management/m);
assert.match(skill, /references\/theme-contract\.md/);
assert.match(skill, /npm run test:cyberpunk-theme/);
assert.match(skillReference, /src\/features\/appearance\/themeRuntime\.ts/);
assert.match(skillReference, /No continuous scanline, glitch, glow, particle/);

console.log('cyberpunk theme contract tests passed');
