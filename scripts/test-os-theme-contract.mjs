import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) => fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
const css = read('src', 'styles', 'app.css');
const theme = read('src', 'styles', 'theme.css');

for (const selector of ['.app', '.theme-bright', '.theme-dark']) {
  assert.match(
    theme,
    new RegExp(`${selector.replace('.', '\\.') }\\s*\\{[\\s\\S]*?--surface-raised:`),
    `${selector} must define the raised surface used by OS chrome.`,
  );
}

assert.match(
  css,
  /\.app\.theme-bright\.os-shell-active\s*\{[\s\S]*?--os-floating-surface:\s*rgba\(255,\s*255,\s*255,\s*0\.96\)[\s\S]*?--os-panel-surface:\s*#fbfaf8/,
  'Bright OS mode must use readable, near-opaque foreground surfaces over the wallpaper.',
);
assert.match(css, /\.os-shell-bar\s*\{[\s\S]*?background:\s*var\(--os-chrome-surface\)/);
assert.match(css, /\.os-system-surface\s*\{[\s\S]*?background:\s*var\(--os-panel-surface\)/);
assert.match(
  css,
  /\.app\.os-shell-active \.os-welcome-composer \.composer-surface\s*\{[\s\S]*?background:\s*var\(--os-floating-surface\)/,
  'The OS welcome composer must keep its foreground surface even when generic wallpaper styles are present.',
);
assert.match(
  css,
  /\.os-taskbar-content\s*\{[\s\S]*?opacity:\s*1;[\s\S]*?pointer-events:\s*auto;[\s\S]*?transform:\s*translate\(-50%,\s*0\)/,
  'The bottom taskbar must remain visible and interactive without requiring hover.',
);
assert.match(css, /\.os-taskbar-handle\s*\{\s*display:\s*none;/);
assert.match(
  css,
  /\.os-chat-panel:has\(\.os-bottom-taskbar\) \.composer-dock\s*\{[\s\S]*?padding-bottom:\s*78px/,
  'The chat composer must reserve space for the persistent bottom taskbar.',
);

console.log('OS theme contract tests passed');
