import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (...segments) => fs.readFileSync(path.join(root, ...segments), 'utf8');
const main = read('electron', 'main.ts');

assert.equal(fs.existsSync(path.join(root, 'electron', 'desktopControlOverlay.ts')), false);
assert.doesNotMatch(main, /DesktopControlOverlay|desktopControlOverlay|ensureDesktopControlOverlay/);
const presentation = read('packages', 'cardbush-apps-mcp', 'src', 'plugins', 'computerUsePresentation.ts');
assert.doesNotMatch(presentation, /from ['"](?:electron|@cardbush\/bush-runtime|@cardbush\/bush-protocol)/);

assert.match(main, /event\.kind === 'tool_running'/);
assert.match(main, /isComputerUseRuntimeTool\(event\.payload\.toolName\)/);
assert.match(main, /event\.kind === 'tool_returned'/);
assert.match(main, /event\.kind === 'tool_failed'/);
assert.match(main, /event\.kind === 'tool_cancelled'/);
assert.match(main, /event\.kind === 'permission_requested'/);
assert.match(main, /event\.kind === 'turn_terminal'/);
assert.match(main, /kind: cancelRuntimeToolCommand/);
assert.doesNotMatch(main, /desktop-control-stop-|escape-stop-sent/);
assert.match(main, /disposeDesktopControlMonitor\(\)/);

const computerUse = read('packages', 'cardbush-apps-mcp', 'src', 'plugins', 'computerUse.ts');
const computerUseRuntime = read('packages', 'cardbush-apps-mcp', 'src', 'plugins', 'computerUseRuntime.ts');
assert.match(computerUse, /safetyScope\(context\.mcpReq\._meta\)/);
assert.match(computerUseRuntime, /signal\?: AbortSignal/);
assert.match(computerUseRuntime, /signal,/);
assert.match(computerUseRuntime, /ComputerUseSafetyGuard/);
assert.match(computerUseRuntime, /yielded_to_user/);
assert.match(computerUseRuntime, /pointer_restored/);
assert.match(computerUseRuntime, /repeated action loop/);

console.log('Computer Use presentation belongs to the plugin; product permission cancellation is preserved.');
