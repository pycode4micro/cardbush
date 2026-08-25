import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) => fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
const main = read('electron', 'main.ts');
const preload = read('electron', 'preload.ts');
const hook = read('src', 'hooks', 'useCardbushChat.ts');
const app = read('src', 'App.tsx');
const sidebar = read('src', 'features', 'sidebar', 'ChatSidebar.tsx');
const storage = read('src', 'features', 'sessionAttention.ts');
const css = read('src', 'styles', 'app.css');
const windowsIcon = fs.readFileSync(path.join(process.cwd(), 'assets', 'cardbush.ico'));

assert.match(main, /Notification\.isSupported\(\)/);
assert.match(main, /!mainWindow\.isVisible\(\) \|\| !mainWindow\.isFocused\(\)/);
assert.match(main, /notification\.on\('click',[\s\S]*?attention:open-session/);
assert.match(main, /mainWindow\.setOverlayIcon\(/);
assert.match(main, /attention:set-count/);
assert.match(main, /const cardbushAppUserModelId = 'com\.cardbush\.desktop'/);
assert.match(main, /app\.setAppUserModelId\(cardbushAppUserModelId\)/);
assert.match(main, /window\.setIcon\(icon\)/);
assert.match(main, /window\.setAppDetails\(\{[\s\S]*?appIconPath:/);
assert.match(main, /relaunchCommand:\s*windowsRelaunchCommand\(\)/);
assert.match(main, /relaunchDisplayName:\s*cardbushDisplayName/);
assert.match(main, /function ensureWindowsTaskbarShortcut\(\)/);
assert.match(main, /Start Menu'[\s\S]*?'Programs'/);
assert.match(main, /shell\.writeShortcutLink\(shortcutPath, 'replace'/);
assert.match(main, /appUserModelId:\s*cardbushAppUserModelId/);
assert.match(main, /ensureWindowsTaskbarShortcut\(\);[\s\S]*?registerLocalFileProtocol\(\);/);
assert.match(main, /window\.on\('show', refreshWindowBackdrop\)/);
assert.deepEqual([...windowsIcon.subarray(0, 4)], [0, 0, 1, 0]);
assert.ok(windowsIcon.readUInt16LE(4) >= 6, 'Windows icon should contain multiple resolutions');

assert.match(preload, /notifySessionAttention:[\s\S]*?attention:notify-session/);
assert.match(preload, /setSessionAttentionCount:[\s\S]*?attention:set-count/);
assert.match(preload, /onOpenSessionAttention:[\s\S]*?attention:open-session/);

assert.match(storage, /cardbush_session_attention_v1/);
assert.match(storage, /maxPersistedAttentionAgeMs/);
assert.match(hook, /attentionByConversation/);
assert.match(hook, /markSessionAttention\([\s\S]*?'completed'/);
assert.match(hook, /markSessionAttention\([\s\S]*?'waiting'/);
assert.match(hook, /setSessionAttentionCount\?\.\(Object\.keys\(attentionByConversation\)\.length\)/);
assert.match(hook, /clearSessionAttention\(normalized, 'completed'\)/);

assert.match(app, /attentionByConversation=\{chat\.attentionByConversation\}/);
assert.match(app, /onOpenSessionAttention[\s\S]*?chat\.openConversation\(normalized\)/);
assert.match(sidebar, /conversation-attention-indicator/);
assert.match(sidebar, /已完成，待查看/);
assert.match(css, /\.conversation-attention-indicator\s*\{/);

console.log('session attention contract tests passed');
