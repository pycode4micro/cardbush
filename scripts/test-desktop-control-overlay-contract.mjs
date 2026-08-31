import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (...segments) => fs.readFileSync(path.join(root, ...segments), 'utf8');
const overlay = read('electron', 'desktopControlOverlay.ts');
const main = read('electron', 'main.ts');

assert.match(overlay, /transparent: true/);
assert.match(overlay, /setIgnoreMouseEvents\(true\)/);
assert.match(overlay, /setContentProtection\(true\)/);
assert.match(overlay, /setAlwaysOnTop\(true, 'screen-saver'\)/);
assert.match(overlay, /setVisibleOnAllWorkspaces\(true, \{ visibleOnFullScreen: true \}\)/);
assert.match(overlay, /CardBush 正在控制/);
assert.match(overlay, /Esc 取消/);
assert.match(overlay, /globalShortcut\.register\(accelerator, cancel\)/);
assert.match(overlay, /screen\.getCursorScreenPoint\(\)/);
assert.match(overlay, /background: rgba\(11, 15, 24, 0\.13\)/);

assert.match(main, /event\.kind === 'tool_running'/);
assert.match(main, /isComputerUseRuntimeTool\(event\.payload\.toolName\)/);
assert.match(main, /event\.kind === 'turn_terminal'/);
assert.match(main, /kind: stopRuntimeTurnCommand/);
assert.match(main, /disposeDesktopControlMonitor\(\)/);

const computerUse = read('packages', 'cardbush-apps-mcp', 'src', 'plugins', 'computerUse.ts');
const computerUseRuntime = read('packages', 'cardbush-apps-mcp', 'src', 'plugins', 'computerUseRuntime.ts');
assert.match(computerUse, /executeComputerUse\(input, config, context\.mcpReq\.signal\)/);
assert.match(computerUseRuntime, /signal\?: AbortSignal/);
assert.match(computerUseRuntime, /signal,/);

console.log('desktop control overlay contract passed');
