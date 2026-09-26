import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const { restoreEditorFocus } = createRequire(import.meta.url)('../dist-electron/rendererFocus.js');

function fixture() {
  const state = { destroyed: false, contentsDestroyed: false, crashed: false,
    focused: true, visible: true, minimized: false, enabled: true, pageFocused: false,
    editorActive: true, documentFocused: true, owner: null, afterRead: undefined };
  let calls = 0, widgetCalls = 0, reads = 0;
  const mainFrame = {};
  const contents = { mainFrame, focusedFrame: mainFrame, isDestroyed: () => state.contentsDestroyed,
    isCrashed: () => state.crashed, isFocused: () => state.pageFocused,
    focus: () => { calls++; state.pageFocused = true; },
    executeJavaScript: async () => {
      reads++; const result = { active: state.editorActive, documentFocused: state.documentFocused };
      state.afterRead?.(); return result;
    } };
  const window = { isDestroyed: () => state.destroyed, webContents: contents,
    isFocused: () => state.focused, isVisible: () => state.visible,
    isMinimized: () => state.minimized, isEnabled: () => state.enabled,
    focusOnWebView: () => { widgetCalls++; } };
  const event = { sender: contents, senderFrame: mainFrame };
  const restore = (request = {}, sender = event, target = window) => restoreEditorFocus(sender, target,
    { requestId: 1, documentFocused: false, ...request }, () => state.owner);
  return { state, window, contents, event, restore, calls: () => calls, widgetCalls: () => widgetCalls, reads: () => reads };
}

test('explicit editor activation repairs native page and widget focus without raising the OS window', async () => {
  const f = fixture();
  assert.equal(await f.restore(), true);
  assert.equal(f.calls(), 1);
  assert.equal(f.widgetCalls(), 1);
});

test('use current DOM focus, not the stale state sampled before the pointer default action', async () => {
  const f = fixture(); f.state.pageFocused = true;
  assert.equal(await f.restore({ documentFocused: false }), true);
  assert.equal(f.calls(), 0);
  assert.equal(f.widgetCalls(), 0, 'healthy editor/IME is untouched');
  f.state.documentFocused = false;
  assert.equal(await f.restore({ documentFocused: true }), true);
  assert.equal(f.widgetCalls(), 1, 'widget loss after the request was sent is repaired');
});

test('passive recovery repairs ownerless focus instead of mistaking it for preview focus', async () => {
  const f = fixture(); f.state.documentFocused = false;
  assert.equal(await f.restore({ passive: true }), true);
  assert.equal(f.calls(), 1);
  assert.equal(f.widgetCalls(), 1);
});

test('passive recovery does not steal focus from a native preview, webview or iframe', async () => {
  const f = fixture(); f.state.documentFocused = false;
  f.state.owner = { isDestroyed: () => false };
  assert.equal(await f.restore({ passive: true }), false);
  f.state.owner = f.contents; f.contents.focusedFrame = {};
  assert.equal(await f.restore({ passive: true }), false);
  assert.equal(f.calls(), 0);
  assert.equal(f.widgetCalls(), 0);
  f.contents.focusedFrame = f.contents.mainFrame;
  assert.equal(await f.restore({ passive: true }), true);
});

test('discard requests whose editor was blurred, unmounted, disabled or superseded', async () => {
  const f = fixture(); f.state.editorActive = false;
  assert.equal(await f.restore(), false);
  assert.equal(f.calls(), 0);
  assert.equal(f.widgetCalls(), 0);
});

test('late requests cannot steal focus from another app, hidden windows or modal dialogs', async () => {
  const guards = { destroyed: true, contentsDestroyed: true, crashed: true,
    focused: false, visible: false, minimized: true, enabled: false };
  for (const [key, value] of Object.entries(guards)) {
    for (const duringRead of [false, true]) {
      const f = fixture();
      if (duringRead) f.state.afterRead = () => { f.state[key] = value; };
      else f.state[key] = value;
      assert.equal(await f.restore(), false, `${key}, during read=${duringRead}`);
      assert.equal(f.calls(), 0, key);
      assert.equal(f.widgetCalls(), 0, key);
    }
  }
});

test('only the owning main frame with a valid focus request can activate the editor', async () => {
  const f = fixture();
  assert.equal(await f.restore({}, { ...f.event, sender: {} }), false);
  assert.equal(await f.restore({}, { ...f.event, senderFrame: {} }), false);
  assert.equal(await f.restore({}, f.event, null), false);
  for (const requestId of [undefined, 0, -1, 1.5, Infinity, '1']) assert.equal(await f.restore({ requestId }), false);
  assert.equal(f.reads(), 0);
  assert.equal(f.calls(), 0);
});

test('renderer shutdown during a focus check is a cancelled repair', async () => {
  const f = fixture();
  f.contents.executeJavaScript = async () => { throw Error('frame disposed'); };
  assert.equal(await f.restore(), false);
  assert.equal(f.calls(), 0);
});
