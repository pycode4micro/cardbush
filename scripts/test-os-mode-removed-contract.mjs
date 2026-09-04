import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const app = read('src/App.tsx');
const appTypes = read('src/types.ts');
const settings = read('src/features/SettingsView.tsx');
const composer = read('src/features/composer/Composer.tsx');
const preload = read('electron/preload.ts');
const electronMain = read('electron/main.ts');
const electronTypes = read('src/types/electron.d.ts');
const runtimeChat = read('src/backend/runtimeChat.ts');
const css = read('src/styles/app.css');

assert.equal(
  fs.existsSync(path.join(root, 'src/features/os/OsSystemSurface.tsx')),
  false,
  'the removed OS surface must not remain in the source tree',
);

for (const [name, source] of [
  ['App', app],
  ['settings', settings],
  ['composer', composer],
  ['preload', preload],
  ['Electron main', electronMain],
  ['Electron types', electronTypes],
  ['styles', css],
]) {
  assert.doesNotMatch(source, /OsSystemSurface|osModeEnabled|os-shell-active|cardbush_os|--os-mode|os:set-shell-mode/,
    `${name} must not expose the removed OS mode`);
}

assert.doesNotMatch(appTypes, /AppSection\s*=\s*[^;]*['"]os['"]/);
assert.doesNotMatch(appTypes, /SettingsSection\s*=\s*[\s\S]*?\|\s*['"]os['"]/);
assert.doesNotMatch(settings, /Desktop OS|\u684c\u9762 OS|Open in OS mode/);

assert.match(preload, /filesystemLocations:\s*\(\)\s*=>/);
assert.match(electronTypes, /filesystemLocations:\s*\(\)\s*=>/);
assert.match(electronMain, /ipcMain\.handle\(['"]filesystem:locations['"]/);
assert.match(runtimeChat, /cardbushDesktop\?\.filesystemLocations/);

console.log('OS mode removal contract passed.');
