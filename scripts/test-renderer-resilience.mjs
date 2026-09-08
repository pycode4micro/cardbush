import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync('electron/main.ts', 'utf8');
const parsed = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
const names = new Set(['showWindowError', 'installMainRendererResilience', 'installMainWindowNavigationGuard']);
const functions = parsed.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text));
assert.equal(functions.length, names.size);
const code = ts.transpileModule(
  'const windowErrorDialogs = new WeakMap();\n' + functions.map(node => node.getText(parsed)).join('\n'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
).outputText;

const dialogs = [];
const logs = [];
let resolveDialog;
let rejectDialog;
let reloads = 0;
let timers = 0;
const context = {
  process: { versions: { electron: 'fixture', chrome: 'fixture' } },
  app: { getPath: () => 'fixture-crash-dumps' },
  isQuitting: false,
  appendDebugLog: (scope, payload) => logs.push({ scope, ...payload }),
  dialog: { showMessageBox: (owner, options) => {
    dialogs.push({ owner, options });
    return new Promise((resolve, reject) => { resolveDialog = resolve; rejectDialog = reject; });
  } },
  setTimeout: () => { timers++; },
  isAllowedAppNavigation: url => url === 'file:///fixture/index.html',
  sendUiPreviewToInspector: () => false,
  safeUrl: url => new URL(url),
  isWebProtocol: url => /^https?:$/.test(url.protocol),
  openUiPreview: () => {},
  openTargetExternally: () => {},
};
vm.runInNewContext(code, context);
const target = new EventEmitter();
target.isDestroyed = () => false;
target.webContents = new EventEmitter();
target.webContents.isDestroyed = () => false;
target.webContents.reload = () => { reloads++; };
target.webContents.setWindowOpenHandler = () => {};
context.installMainRendererResilience(target);
const settle = () => new Promise(resolve => setImmediate(resolve));

target.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: -2147483645 });
target.webContents.emit('render-process-gone', {}, { reason: 'oom', exitCode: -1 });
assert.equal(dialogs.length, 1, 'simultaneous failures share one error dialog');
assert.match(dialogs[0].options.message, /crashed/);
assert.equal(dialogs[0].options.buttons.length, 1, 'error handling offers no reload action');
resolveDialog({ response: 0 });
await settle();
target.emit('unresponsive');
assert.equal(dialogs.length, 2);
rejectDialog(new Error('window closed while showing error'));
await settle();
assert.ok(logs.some(log => log.stage === 'error-dialog-failed'));
target.webContents.emit('did-fail-load', {}, -3, 'aborted', 'file:///fixture/index.html', true);
target.webContents.emit('did-fail-load', {}, -2, 'subframe failed', 'file:///fixture/index.html', false);
assert.equal(dialogs.length, 2, 'aborted and subframe loads do not report main-frame failure');
target.webContents.emit('did-fail-load', {}, -6, 'not found', 'file:///fixture/index.html', true);
assert.equal(dialogs.length, 3);
resolveDialog({ response: 0 });
await settle();
target.webContents.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 });
context.isQuitting = true;
target.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
assert.equal(dialogs.length, 3, 'normal shutdown does not prompt');
context.isQuitting = false;

context.installMainWindowNavigationGuard(target);
let prevented = 0;
target.webContents.emit('will-navigate', { preventDefault: () => { prevented++; } }, 'file:///fixture/index.html');
assert.equal(prevented, 1, 'an empty link cannot reload the app through main-frame navigation');
assert.equal(dialogs.length, 4);
resolveDialog({ response: 0 });
await settle();
for (const input of [{ key: 'F5' }, { key: 'r', control: true }, { key: 'r', meta: true }]) {
  let blocked = false;
  target.webContents.emit('before-input-event', { preventDefault: () => { blocked = true; } }, input);
  assert.equal(blocked, true);
}
assert.equal(reloads, 0, 'no failure or dialog outcome reloads the renderer');
assert.equal(timers, 0, 'no deferred reload is scheduled');
console.log('Renderer resilience passed: crash, OOM, unresponsive, failed load, dialog failure, shutdown and accidental app navigation never reload.');
