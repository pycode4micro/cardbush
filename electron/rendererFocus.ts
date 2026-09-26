import { webContents, type BrowserWindow, type IpcMainInvokeEvent, type WebContents } from 'electron';

export interface EditorFocusRequest {
  documentFocused: boolean;
  passive?: boolean;
  requestId: number;
}

/** A DOM focus call alone cannot repair a lost native WebContents focus. */
export async function restoreEditorFocus(
  event: IpcMainInvokeEvent,
  target: BrowserWindow | null,
  state: EditorFocusRequest,
  focusedContents: () => WebContents | null = () => webContents.getFocusedWebContents(),
): Promise<boolean> {
  const eligible = () => target && !target.isDestroyed() && !target.webContents.isDestroyed()
    && !target.webContents.isCrashed() && event.sender === target.webContents
    && event.senderFrame === target.webContents.mainFrame && target.isFocused()
    && target.isVisible() && !target.isMinimized() && target.isEnabled();
  if (!state || !Number.isSafeInteger(state.requestId) || state.requestId < 1 || !eligible()) return false;
  const contents = target!.webContents;
  try {
    // IPC can arrive after a different input/preview was selected. Check the
    // live editor lease, not the document-focus bit captured before a click.
    const current = await contents.executeJavaScript(`(() => {
      const editor = document.activeElement;
      return {
        active: editor?.getAttribute('data-editor-focus-request') === '${state.requestId}'
          && !editor.closest('[inert]') && editor.getClientRects().length > 0
          && (editor.isContentEditable || (editor.tagName === 'TEXTAREA' && !editor.readOnly && !editor.disabled)),
        documentFocused: document.hasFocus()
      };
    })()`);
    // Do not raise a background window or bypass a modal, including a window
    // deactivated while the renderer was answering the focus check.
    if (!current?.active || !eligible()) return false;
    if (state.passive) {
      const owner = focusedContents();
      if (owner && owner !== contents && !owner.isDestroyed()) return false;
      if (contents.focusedFrame && contents.focusedFrame !== contents.mainFrame) return false;
      // No native owner is a lost focus, not proof that a preview owns it.
    }
    const wasFocused = contents.isFocused();
    if (!wasFocused) contents.focus();
    // focus() can be a no-op when Chromium's widget and native focus disagree.
    if (!current.documentFocused || !wasFocused) target!.focusOnWebView();
    return contents.isFocused();
  } catch {
    // Closing/navigating a view can dispose its frame during the check.
    return false;
  }
}
