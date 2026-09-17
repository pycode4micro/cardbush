import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';

/** A DOM focus call alone cannot repair a lost native WebContents focus. */
export function restoreEditorFocus(
  event: IpcMainInvokeEvent,
  target: BrowserWindow | null,
  state?: { documentFocused?: boolean },
): boolean {
  if (!target || target.isDestroyed()) return false;
  const contents = target.webContents;
  if (contents.isDestroyed() || contents.isCrashed()
    || event.sender !== contents || event.senderFrame !== contents.mainFrame) return false;
  // Never raise a background window or bypass a modal dialog. The request can
  // arrive after the user has already switched to another app.
  if (!target.isFocused() || !target.isVisible() || target.isMinimized() || !target.isEnabled()) return false;
  contents.focus();
  // The native focus manager can still report true after Chromium's render
  // widget lost focus (for example when a modal closes). Focus() then does
  // nothing. Repair the widget itself without deactivating the OS window.
  if (state?.documentFocused === false) target.focusOnWebView();
  return contents.isFocused();
}
