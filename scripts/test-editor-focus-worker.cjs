const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const electron = require('electron');

if (typeof electron === 'string') {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const result = require('node:child_process').spawnSync(electron, [__filename], {
    env, stdio: 'inherit', windowsHide: true, timeout: 30000,
  });
  if (result.error) console.error(result.error);
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow, ipcMain } = electron;
const { restoreEditorFocus } = require('../dist-electron/rendererFocus.js');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'cardbush-editor-focus-')));
const pause = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms));
let window;
const deadline = setTimeout(() => app.exit(1), 25000);
app.whenReady().then(async () => {
  // Keep the fixture hidden: the real renderer/widget, webview, IPC and keyboard
  // are exercised here; OS activation/modal guards are covered in the unit test.
  window = new BrowserWindow({ width: 800, height: 450, show: false,
    webPreferences: { preload: path.resolve('dist-electron/preload.js'), sandbox: true,
      contextIsolation: true, offscreen: true, webviewTag: true, backgroundThrottling: false } });
  const run = code => window.webContents.executeJavaScript(code);
  const until = async (code, message) => {
    for (let i = 0; i < 100; i++) { if (await run(code)) return; await pause(20); }
    throw Error(message);
  };
  const settled = () => until('!document.querySelector("[data-editor-focus-request]")', 'focus request should settle');
  const native = { focused: true, visible: true, enabled: true, pageFocused: true, owner: null };
  let widgetCalls = 0;
  const contents = new Proxy(window.webContents, { get(target, key) {
    if (key === 'isFocused') return () => native.pageFocused;
    if (key === 'focus') return () => { native.pageFocused = true; target.focus(); };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const target = { webContents: contents, isDestroyed: () => window.isDestroyed(),
    isFocused: () => native.focused, isVisible: () => native.visible,
    isEnabled: () => native.enabled, isMinimized: () => false,
    focusOnWebView: () => { widgetCalls++; window.focusOnWebView(); } };
  const calls = [], debug = [];
  let skippedRepairs = 0, deferNext = false, release;
  ipcMain.handle('debug:append-log', (_, scope, payload) => { debug.push({ scope, payload }); return 'fixture-log'; });
  ipcMain.handle('window:restore-editor-focus', async (event, state) => {
    calls.push(state);
    if (skippedRepairs > 0) { skippedRepairs--; return true; }
    if (deferNext) { deferNext = false; await new Promise(resolve => { release = resolve; }); }
    return restoreEditorFocus({ sender: contents, senderFrame: event.senderFrame }, target, state, () => native.owner);
  });
  const ts = require('typescript');
  const editorCode = ts.transpileModule(fs.readFileSync('src/shared/editorFocus.ts', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  await window.loadURL('data:text/html,' + encodeURIComponent(`
    <textarea id="plain" style="position:absolute;left:20px;top:20px;width:240px;height:80px">draft</textarea>
    <div id="rich" contenteditable style="position:absolute;left:20px;top:140px;width:240px;height:80px">reference draft</div>
    <input id="other" style="position:absolute;left:20px;top:270px" value="other">
    <webview style="position:absolute;left:350px;top:20px;width:400px;height:350px"></webview>`));
  await run(`(() => {
    const exports = {}; ${editorCode}
    window.editorFocus = exports;
    window.plain = document.querySelector('#plain'); window.rich = document.querySelector('#rich');
    for (const editor of [plain, rich]) editor.addEventListener('pointerdown', event => exports.restoreNativeEditorFocus(event, editor));
    plain.focus(); plain.setSelectionRange(2, 4);
  })()`);
  window.focusOnWebView();
  await until('document.hasFocus()', 'fixture widget focused');
  const click = async (y = 45) => {
    window.webContents.sendInputEvent({ type: 'mouseDown', x: 70, y, button: 'left', clickCount: 1 });
    window.webContents.sendInputEvent({ type: 'mouseUp', x: 70, y, button: 'left', clickCount: 1 });
    await pause(); await settled();
  };
  const type = async keyCode => { window.webContents.sendInputEvent({ type: 'char', keyCode }); await pause(30); };

  await run('plain.dispatchEvent(new PointerEvent("pointerdown", { bubbles:true, button:0 }))');
  await pause(); assert.equal(calls.length, 0, 'synthetic pointer events cannot request native focus');
  window.blurWebView(); await pause();
  assert.equal(await run('document.hasFocus()'), false);
  window.webContents.focus(); await pause();
  assert.equal(await run('document.hasFocus()'), false, 'contents.focus alone does not repair the stale widget');
  await run('editorFocus.focusEditor(plain)');
  await until('document.hasFocus()', 'explicit activation repairs stale widget'); await settled();
  assert.deepEqual(await run('[plain.selectionStart, plain.selectionEnd]'), [2, 4]);
  await type('中');
  assert.equal(await run('plain.value'), 'dr中t', 'repair preserves draft and selected replacement range');
  const healthyCalls = widgetCalls;
  await click();
  assert.equal(widgetCalls, healthyCalls, 'healthy clicks do not reset the widget or IME');

  let guest;
  window.webContents.on('did-attach-webview', (_, value) => { guest = value; });
  await run(`document.querySelector('webview').addEventListener('dom-ready', () => { window.guestReady = true; });
    document.querySelector('webview').src = 'data:text/html,' + encodeURIComponent('<input autofocus value="preview">');`);
  await until('window.guestReady', 'real webview attached');
  await run('window.stopPlain = editorFocus.observeEditorFocus(plain); window.stopRich = editorFocus.observeEditorFocus(rich); void 0');
  for (let i = 0; i < 8; i++) {
    await run('document.querySelector("webview").focus()'); await pause();
    assert.equal(await run('document.activeElement.tagName'), 'WEBVIEW');
    assert.equal(await run('document.hasFocus()'), false);
    assert.notEqual(window.webContents.focusedFrame, window.webContents.mainFrame, 'guest frame owns keyboard focus');
    const before = calls.length;
    await pause(100);
    assert.equal(calls.length, before, 'passive editor checks do not fight the webview');
    guest.sendInputEvent({ type: 'char', keyCode: 'G' });
    await pause(20);
    assert.ok((await guest.executeJavaScript('document.querySelector("input").value')).includes('G'), 'preview inputs remain usable');
    if (i % 2) await click(160);
    else await run('editorFocus.focusEditor(plain)');
    await until('document.hasFocus()', 'editor returns from real webview'); await settled();
    await type('X');
    assert.ok(await run(i % 2 ? 'rich.textContent.includes("X")' : 'plain.value.includes("X")'));
  }

  await run('editorFocus.focusEditor(plain); plain.setSelectionRange(1, 3)'); await settled();
  // Reproduce the missing case: editor still active, no native focus owner.
  native.pageFocused = false;
  window.blurWebView();
  await until('document.hasFocus()', 'ownerless widget focus recovers without alt-tab or another click'); await settled();
  assert.equal(calls.at(-1).passive, true);
  assert.deepEqual(await run('[plain.selectionStart, plain.selectionEnd]'), [1, 3]);
  await type('文'); assert.ok(await run('plain.value.includes("文")'));

  // A reported successful IPC may precede (or lose to) a guest focus transition.
  const beforeRetry = calls.length;
  skippedRepairs = 1;
  window.blurWebView();
  await until('document.hasFocus()', 'one transient failed handoff is rechecked'); await settled();
  assert.equal(calls.length, beforeRetry + 2, 'one bounded retry after an ineffective native response');

  // Delayed requests must not focus an editor that the user already left.
  const beforeLate = widgetCalls;
  deferNext = true;
  await run('editorFocus.focusEditor(plain)');
  for (let i = 0; !release && i < 100; i++) await pause(10);
  assert.ok(release);
  await run('document.querySelector("webview").focus()');
  release(); release = undefined; await pause(150);
  assert.equal(widgetCalls, beforeLate, 'stale IPC cannot steal the preview focus');
  assert.equal(await run('document.activeElement.tagName'), 'WEBVIEW');

  await run('document.querySelector("webview").remove(); editorFocus.focusEditor(plain)');
  await until('document.hasFocus()', 'closing the focused preview does not strand the editor'); await settled();
  await type('Y'); assert.ok(await run('plain.value.includes("Y")'));

  // Preserve an actual Chromium IME composition through a healthy activation.
  window.webContents.debugger.attach('1.3');
  for (const editor of ['plain', 'rich']) {
    await run(`editorFocus.focusEditor(${editor})`); await settled();
    const beforeIme = widgetCalls;
    await window.webContents.debugger.sendCommand('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 });
    await run(`editorFocus.focusEditor(${editor})`); await settled();
    assert.equal(widgetCalls, beforeIme, 'healthy activation leaves native composition alone');
    await window.webContents.debugger.sendCommand('Input.insertText', { text: '你' });
    assert.ok(await run(editor === 'plain' ? 'plain.value.includes("你")' : 'rich.textContent.includes("你")'));
  }
  window.webContents.debugger.detach();

  await run('editorFocus.focusEditor(plain)'); await settled();
  native.owner = { isDestroyed: () => false };
  window.blurWebView(); await pause(550);
  assert.equal(await run('document.hasFocus()'), false, 'an intentional native preview focus is never stolen');
  const afterBound = calls.length; await pause(300);
  assert.equal(calls.length, afterBound, 'recovery attempts stop instead of polling indefinitely');
  native.owner = null;
  await run('editorFocus.focusEditor(plain)'); await settled();
  await run('document.querySelector("#other").focus()');
  const beforeOther = calls.length;
  window.blurWebView(); await pause(150);
  assert.equal(calls.length, beforeOther, 'other inputs are not redirected');

  await run('editorFocus.focusEditor(plain)'); await settled();
  deferNext = true;
  await run('editorFocus.focusEditor(plain)');
  for (let i = 0; !release && i < 100; i++) await pause(10);
  assert.ok(release);
  const beforeUnmount = widgetCalls;
  await run('stopPlain(); plain.remove(); stopRich(); rich.remove()');
  release(); release = undefined; await pause(150);
  assert.equal(widgetCalls, beforeUnmount, 'unmount invalidates an in-flight request');
  assert.equal(window.isVisible(), false, 'test never opens or activates a desktop window');
  assert.ok(debug.some(item => item.payload?.stage === 'editor-focus-unresolved'), 'bounded failure has diagnostics without draft content');
  console.log('Electron editor focus passed: real webview handoffs, ownerless focus, bounded retry, stale IPC cancellation, preview close, textarea/rich editor, draft selection and native Chinese IME. OS focus/modal guards passed separately.');
}).then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); }).finally(() => {
  clearTimeout(deadline);
  if (window && !window.isDestroyed()) window.destroy();
});
