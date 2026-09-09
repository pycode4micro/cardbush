/** Preserve the browser's caret/selection handling while repairing native focus. */
export function restoreNativeEditorFocus(event: { isTrusted: boolean; button: number }): void {
  if (!event.isTrusted || event.button !== 0) return;
  const restore = window.cardbushDesktop?.restoreEditorFocus;
  if (!restore) return;
  void restore({ documentFocused: document.hasFocus() }).catch(error => {
    console.warn('Unable to restore editor focus', error);
  });
}
