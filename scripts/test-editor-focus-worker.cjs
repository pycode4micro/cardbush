const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const electron = require('electron');

if (typeof electron === 'string') {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const result = require('node:child_process').spawnSync(electron, [__filename], {
    env, stdio: 'inherit', windowsHide: true, timeout: 25000,
  });
  if (result.error) console.error(result.error);
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow, WebContentsView, ipcMain } = electron;
const { restoreEditorFocus } = require('../dist-electron/rendererFocus.js');
const testProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'cardbush-editor-focus-'));
app.setPath('userData', testProfile);
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
let window;
const deadline = setTimeout(() => app.exit(1), 20000);
app.whenReady().then(async () => {
  window = new BrowserWindow({ width: 600, height: 400, show: false,
    title: 'CardBush input focus test', webPreferences: {
      preload: path.resolve('dist-electron/preload.js'), sandbox: true, contextIsolation: true,
    } });
  const run = code => window.webContents.executeJavaScript(code);
  const calls = [];
  ipcMain.handle('debug:append-log', () => 'fixture-log');
  ipcMain.handle('window:restore-editor-focus', (event, state) => {
    calls.push(state);
    return restoreEditorFocus(event, window, state);
  });
  const ts = require('typescript');
  const editorCode = ts.transpileModule(fs.readFileSync('src/shared/editorFocus.ts', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  await window.loadURL('data:text/html,<textarea style="position:absolute;left:20px;top:20px;width:200px;height:80px">draft</textarea>');
  await run(`(() => {
    const exports = {};
    ${editorCode}
    window.editorFocus = exports;
    const editor = document.querySelector('textarea');
    editor.addEventListener('pointerdown', exports.restoreNativeEditorFocus);
    editor.focus(); editor.setSelectionRange(2, 2);
  })()`);
  window.show(); window.focus();
  await pause();
  const guest = new WebContentsView();
  window.contentView.addChildView(guest);
  guest.setBounds({ x: 300, y: 0, width: 280, height: 300 });
  await guest.webContents.loadURL('data:text/html,<input autofocus placeholder="preview input">');
  window.show(); window.focus();
  guest.webContents.focus();
  await pause();
  assert.equal(window.isFocused(), true);
  assert.equal(window.webContents.isFocused(), false, 'preview owns native page focus');
  assert.equal(await run('document.activeElement.tagName'), 'TEXTAREA', 'DOM focus can remain on the editor');
  assert.equal(window.isVisible(), true, 'test window is visible');
  assert.equal(restoreEditorFocus({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, window), true);
  await pause();
  assert.equal(window.webContents.isFocused(), true, 'page focus returns after the native focus transition');
  assert.deepEqual(await run('Array.from([document.querySelector("textarea").selectionStart, document.querySelector("textarea").selectionEnd])'), [2, 2], 'native repair preserves selection');
  window.webContents.sendInputEvent({ type: 'char', keyCode: 'X' });
  await pause();
  assert.equal(await run('document.querySelector("textarea").value'), 'drXaft', 'keyboard events reach the repaired editor');
  await run('document.querySelector("textarea").dispatchEvent(new PointerEvent("pointerdown", {bubbles:true, button:0}))');
  await pause();
  assert.equal(calls.length, 0, 'synthetic page events do not request focus');
  window.webContents.sendInputEvent({ type: 'mouseDown', x: 50, y: 45, button: 'left', clickCount: 1 });
  window.webContents.sendInputEvent({ type: 'mouseUp', x: 50, y: 45, button: 'left', clickCount: 1 });
  await pause();
  assert.equal(calls.length, 1, 'real editor click reaches the production preload bridge');
  await run('document.querySelector("textarea").focus(); document.querySelector("textarea").setSelectionRange(2, 4)');
  let windowBlurCount = 0;
  window.on('blur', () => { windowBlurCount++; });
  // Reproduce the incident's exact state: the native focus manager claims
  // success while Chromium's render widget no longer accepts keyboard input.
  window.blurWebView();
  await pause();
  assert.equal(window.webContents.isFocused(), true);
  assert.equal(await run('document.hasFocus()'), false);
  window.webContents.focus();
  await pause();
  assert.equal(await run('document.hasFocus()'), false, 'the previous focus-only repair is a no-op in this state');
  await run('window.cardbushDesktop.restoreEditorFocus({ documentFocused: document.hasFocus() })');
  await pause();
  assert.equal(await run('document.hasFocus()'), true, 'native/DOM focus mismatch must actually restore document keyboard focus');
  assert.deepEqual(await run('[document.querySelector("textarea").selectionStart, document.querySelector("textarea").selectionEnd]'), [2, 4]);
  window.webContents.sendInputEvent({ type: 'char', keyCode: '中' });
  await pause();
  assert.equal(await run('document.querySelector("textarea").value'), 'dr中ft', 'restored input replaces the selected range, preserving the draft');
  for (let i = 0; i < 3; i++) {
    window.blurWebView();
    await pause();
    assert.equal(await run('document.hasFocus()'), false);
    const callCount = calls.length;
    window.webContents.sendInputEvent({ type: 'mouseDown', x: 50, y: 45, button: 'left', clickCount: 1 });
    window.webContents.sendInputEvent({ type: 'mouseUp', x: 50, y: 45, button: 'left', clickCount: 1 });
    await pause();
    assert.equal(calls.length, callCount + 1);
    assert.equal(calls.at(-1).documentFocused, false, 'trusted click carries the real missing document focus');
    assert.equal(await run('document.hasFocus()'), true, 'clicking the editor repairs each recurrence');
  }
  assert.equal(windowBlurCount, 0, 'recovery never switches or deactivates the OS window');

  window.blurWebView();
  await pause();
  await run('editorFocus.focusEditor(document.querySelector("textarea"))');
  await pause();
  assert.equal(await run('document.hasFocus()'), true, 'explicit activation repairs an already-active DOM editor without another pointer event');

  await run('window.stopFocusObserver = editorFocus.observeEditorFocus(document.querySelector("textarea")); document.querySelector("textarea").setSelectionRange(2, 3)');
  for (let i = 0; i < 3; i++) {
    const callCount = calls.length;
    window.blurWebView();
    await pause();
    assert.equal(await run('document.hasFocus()'), true, 'losing widget focus while editing recovers without a click');
    assert.equal(calls.length, callCount + 1);
    assert.equal(calls.at(-1).passive, true);
    assert.deepEqual(await run('[document.querySelector("textarea").selectionStart, document.querySelector("textarea").selectionEnd]'), [2, 3]);
  }
  window.webContents.sendInputEvent({ type: 'char', keyCode: '文' });
  await pause();
  assert.equal(await run('document.querySelector("textarea").value'), 'dr文ft', 'typing continues after passive recovery');

  guest.webContents.focus();
  await pause();
  assert.equal(guest.webContents.isFocused(), true, 'a preview keeps native focus despite the stale DOM editor');
  assert.equal(await run('document.hasFocus()'), false);
  assert.equal(calls.at(-1).passive, true);
  await run('editorFocus.focusEditor(document.querySelector("textarea"))');
  await pause();
  assert.equal(await run('document.hasFocus()'), true, 'explicit editor activation can return from the preview');

  await run('const other = document.createElement("input"); document.body.append(other); other.focus();');
  const otherCallCount = calls.length;
  window.blurWebView();
  await pause();
  assert.equal(calls.length, otherCallCount, 'the composer observer does not redirect other inputs');
  assert.equal(await run('document.activeElement.tagName'), 'INPUT');
  await run('editorFocus.focusEditor(document.querySelector("textarea")); stopFocusObserver();');
  await pause();
  const stoppedCallCount = calls.length;
  window.blurWebView();
  await pause();
  assert.equal(calls.length, stoppedCallCount, 'unmounted observers stop repairing focus');
  assert.equal(await run('document.hasFocus()'), false);
  assert.equal(windowBlurCount, 0, 'automatic recovery never deactivates the OS window');
  window.hide();
  assert.equal(restoreEditorFocus({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, window), false);
  assert.equal(window.isVisible(), false, 'a late IPC never reveals the hidden window');
  guest.webContents.close();
  console.log('Electron editor focus passed: guest handoff, stale native focus, click/explicit/passive recovery, selection/Chinese input, observer cleanup and no OS window switching.');
}).then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); }).finally(() => {
  clearTimeout(deadline);
  if (window && !window.isDestroyed()) window.destroy();
});
