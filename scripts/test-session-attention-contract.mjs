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
const packageJson = JSON.parse(read('package.json'));
const guiRunner = read('scripts', 'run-electron-gui.mjs');
const devRunner = read('scripts', 'run-electron-dev.mjs');
const electronRuntime = read('scripts', 'cardbush-electron-runtime.mjs');
const iconGenerator = read('scripts', 'generate-cardbush-icon.cjs');
const windowsIcon = fs.readFileSync(path.join(process.cwd(), 'assets', 'cardbush.ico'));

assert.match(main, /Notification\.isSupported\(\)/);
assert.match(main, /dark:\s*'#1a1a1a'/);
assert.doesNotMatch(main, /dark:\s*'#ff1a1a1a'/);
assert.match(main, /target\.setBackgroundColor\(background\)/);
assert.match(main, /target\.contentView\.setBackgroundColor\(background\)/);
assert.match(
  main,
  /target\.setBackgroundMaterial\('none'\)[\s\S]*?target\.setBackgroundColor\(background\)/,
  'native material must be applied before the final themed HWND background',
);
assert.match(main, /stage:\s*'background-applied'/);
assert.match(main, /const actualBackground = target\.getBackgroundColor\(\)/);
assert.match(main, /!mainWindow\.isVisible\(\) \|\| !mainWindow\.isFocused\(\)/);
assert.match(main, /notification\.on\('click',[\s\S]*?attention:open-session/);
assert.match(main, /mainWindow\.setOverlayIcon\(/);
assert.match(main, /attention:set-count/);
assert.match(main, /const cardbushProductionAppUserModelId = 'com\.cardbush\.desktop'/);
assert.match(
  main,
  /`\$\{cardbushProductionAppUserModelId\}\.development\.\$\{cardbushDevelopmentRuntimeIdentity\}`/,
);
assert.match(main, /app\.setAppUserModelId\(cardbushAppUserModelId\)/);
assert.match(
  main,
  /match\(\/\^cardbush-dev-\(\[a-f0-9\]\+\)\\\.exe\$\/i\)/,
  'development AppUserModelId should track the branded runtime icon identity',
);
assert.match(
  main,
  /development\.\$\{cardbushDevelopmentRuntimeIdentity\}/,
  'development taskbar grouping should invalidate stale icon caches when the runtime icon changes',
);
assert.match(main, /window\.setIcon\(icon\)/);
assert.match(main, /const logoAssetNames = \['cardbush-logo\.png', 'cardbush-logo-backup\.png', 'cardbush\.ico'\]/);
assert.match(main, /const icon = loadCardbushTrayIcon\(32\)/);
assert.match(main, /function cropTransparentIconPadding\(image: NativeImage\)/);
assert.match(main, /const cropped = cropTransparentIconPadding\(image\)/);
assert.match(main, /const safePadding = Math\.ceil\(Math\.max\(contentWidth, contentHeight\) \* 0\.06\)/);
assert.match(main, /window\.setAppDetails\(\{[\s\S]*?appIconPath:/);
assert.match(main, /relaunchCommand:\s*windowsRelaunchCommand\(\)/);
assert.match(main, /relaunchDisplayName:\s*cardbushDisplayName/);
assert.match(main, /function ensureWindowsTaskbarShortcut\(\)/);
assert.match(main, /Start Menu'[\s\S]*?'Programs'/);
assert.match(main, /const operation = fs\.existsSync\(shortcutPath\) \? 'replace' : 'create'/);
assert.match(main, /shell\.writeShortcutLink\(shortcutPath, operation/);
assert.match(main, /appUserModelId:\s*cardbushAppUserModelId/);
assert.match(
  main,
  /registerLocalFileProtocol\(\);\s*createWindow\(\);[\s\S]*?setImmediate\(\(\) => \{\s*const shortcutUpdated = ensureWindowsTaskbarShortcut\(\);/,
  'Taskbar shortcut maintenance must run after the first window is created so it cannot block startup.',
);
assert.match(main, /window\.on\('show', refreshWindowBackdrop\)/);
assert.match(main, /function traceMainWindowComposition\(/);
assert.match(main, /capturePage\(\)\s*\.then\(capturedFrameTelemetry\)/);
assert.match(main, /whitePixelRatio/);
assert.match(main, /appendDebugLog\('window-composition'/);
assert.match(main, /traceMainWindowComposition\(sourceWindow, 'theme-change'/);
assert.match(main, /'renderer-ready-before-show'/);
assert.match(main, /'renderer-ready-after-show'/);
assert.match(main, /appendDebugLog\('taskbar'/);
assert.equal(packageJson.scripts.gui, 'node scripts/run-electron-gui.mjs');
assert.equal(packageJson.scripts['gui:rebuild'], 'node scripts/run-electron-gui.mjs --force-build');
assert.match(guiRunner, /guiBuildState\(\)/);
assert.match(guiRunner, /oldestOutput >= newestSource/);
assert.match(guiRunner, /build is current; launching immediately/);
assert.match(guiRunner, /source files changed/);
assert.match(guiRunner, /function resolveNpmCli\(\)/);
assert.match(guiRunner, /process\.env\.npm_execpath/);
assert.match(guiRunner, /spawn\(process\.env\.npm_node_execpath \|\| process\.execPath/);
assert.doesNotMatch(guiRunner, /spawn\(npm, \['run', 'build'\]/);
assert.match(guiRunner, /resolveCardbushElectronExecutable\(projectRoot\)/);
assert.match(devRunner, /resolveCardbushElectronExecutable\(projectRoot\)/);
assert.match(guiRunner, /CARDBUSH_DEVELOPMENT_RUNTIME: '1'/);
assert.match(devRunner, /CARDBUSH_DEVELOPMENT_RUNTIME: '1'/);
assert.match(guiRunner, /cardbushElectronEnvironment/);
assert.match(devRunner, /cardbushElectronEnvironment/);
assert.match(electronRuntime, /key\.toUpperCase\(\) === 'NODE_OPTIONS'/);
assert.match(main, /cardbushRuntimeIsPackaged \? 'CardBush\.lnk' : 'CardBush Development\.lnk'/);
assert.match(electronRuntime, /ResEdit\.Resource\.IconGroupEntry\.replaceIconsForResource/);
assert.match(electronRuntime, /FileDescription: 'CardBush desktop'/);
assert.match(iconGenerator, /const iconSizes = \[16, 20, 24, 32, 40, 48, 64, 128, 256\]/);
assert.match(iconGenerator, /function buildPngIcon\(images\)/);
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
