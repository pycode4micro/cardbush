import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';

/** A DOM focus call alone cannot repair a lost native WebContents focus. */
export function restoreEditorFocus(event: IpcMainInvokeEvent, target: BrowserWindow | null): boolean {
  if (!target || target.isDestroyed()) return false;
  const contents = target.webContents;
  if (contents.isDestroyed() || contents.isCrashed()
    || event.sender !== contents || event.senderFrame !== contents.mainFrame) return false;
  // Never raise a background window or bypass a modal dialog. The request can
  // arrive after the user has already switched to another app.
  if (!target.isFocused() || !target.isVisible() || target.isMinimized() || !target.isEnabled()) return false;
  contents.focus();
  return contents.isFocused();
}
