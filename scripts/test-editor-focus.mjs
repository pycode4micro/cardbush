import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const { restoreEditorFocus } = createRequire(import.meta.url)('../dist-electron/rendererFocus.js');

function fixture() {
  const state = { destroyed: false, contentsDestroyed: false, crashed: false,
    focused: true, visible: true, minimized: false, enabled: true, pageFocused: false };
  let calls = 0, widgetCalls = 0;
  const contents = { mainFrame: {}, isDestroyed: () => state.contentsDestroyed,
    isCrashed: () => state.crashed, isFocused: () => state.pageFocused,
    focus: () => { calls++; state.pageFocused = true; } };
  const window = { isDestroyed: () => state.destroyed, webContents: contents,
    isFocused: () => state.focused, isVisible: () => state.visible,
    isMinimized: () => state.minimized, isEnabled: () => state.enabled,
    focusOnWebView: () => { widgetCalls++; } };
  return { state, window, event: { sender: contents, senderFrame: contents.mainFrame }, calls: () => calls, widgetCalls: () => widgetCalls };
}

test('an editor click repairs page focus without raising or refocusing the native window', () => {
  const f = fixture();
  assert.equal(restoreEditorFocus(f.event, f.window), true);
  assert.equal(f.calls(), 1);
  assert.equal(f.widgetCalls(), 0, 'healthy clicks do not disturb the render widget or IME');
});

test('a lost document focus repairs the render widget even when native focus already reports true', () => {
  const f = fixture(); f.state.pageFocused = true;
  assert.equal(restoreEditorFocus(f.event, f.window, { documentFocused: false }), true);
  assert.equal(f.widgetCalls(), 1);
});

test('healthy editor activation leaves native focus and active IME composition untouched', () => {
  const f = fixture(); f.state.pageFocused = true;
  assert.equal(restoreEditorFocus(f.event, f.window, { documentFocused: true }), true);
  assert.equal(f.calls(), 0);
  assert.equal(f.widgetCalls(), 0);
});

test('passive recovery repairs a stale editor widget without stealing native focus from a preview', () => {
  const f = fixture();
  assert.equal(restoreEditorFocus(f.event, f.window, { documentFocused: false, passive: true }), false);
  assert.equal(f.calls(), 0);
  assert.equal(f.widgetCalls(), 0);
  f.state.pageFocused = true;
  assert.equal(restoreEditorFocus(f.event, f.window, { documentFocused: false, passive: true }), true);
  assert.equal(f.calls(), 0);
  assert.equal(f.widgetCalls(), 1);
});

test('late editor clicks cannot steal focus from other apps, hidden windows or modal dialogs', () => {
  for (const [key, value] of Object.entries({ destroyed: true, contentsDestroyed: true,
    crashed: true, focused: false, visible: false, minimized: true, enabled: false })) {
    const f = fixture(); f.state[key] = value;
    assert.equal(restoreEditorFocus(f.event, f.window, { documentFocused: false }), false, key);
    assert.equal(f.calls(), 0, key);
    assert.equal(f.widgetCalls(), 0, key);
  }
});

test('preview guests and subframes cannot redirect the main editor focus', () => {
  const f = fixture();
  assert.equal(restoreEditorFocus({ ...f.event, sender: {} }, f.window), false);
  assert.equal(restoreEditorFocus({ ...f.event, senderFrame: {} }, f.window, { documentFocused: false }), false);
  assert.equal(restoreEditorFocus(f.event, null), false);
  assert.equal(f.calls(), 0);
  assert.equal(f.widgetCalls(), 0);
});
