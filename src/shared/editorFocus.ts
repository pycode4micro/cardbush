/** Preserve the browser's caret/selection handling while repairing native focus. */
export function restoreNativeEditorFocus(event: { isTrusted: boolean; button: number }): void {
  if (!event.isTrusted || event.button !== 0) return;
  requestEditorFocus();
}

/** Explicit editor activation must restore the native widget as well as the DOM. */
export function focusEditor(element: HTMLElement | null): void {
  if (!element) return;
  element.focus({ preventScroll: true });
  if (document.activeElement === element && !document.hasFocus()) requestEditorFocus();
}

/** Recover a focused editor's lost widget without taking focus from preview guests. */
export function observeEditorFocus(element: HTMLElement): () => void {
  let timer: number | undefined;
  const check = () => {
    timer = undefined;
    if (!element.isConnected || document.activeElement !== element ||
        document.visibilityState !== 'visible' || document.hasFocus()) return;
    requestEditorFocus(true);
  };
  const schedule = () => {
    window.clearTimeout(timer);
    // Let window/guest focus transitions settle before checking native ownership.
    timer = window.setTimeout(check, 0);
  };
  element.addEventListener('focus', schedule);
  window.addEventListener('blur', schedule);
  window.addEventListener('focus', schedule);
  document.addEventListener('visibilitychange', schedule);
  return () => {
    window.clearTimeout(timer);
    element.removeEventListener('focus', schedule);
    window.removeEventListener('blur', schedule);
    window.removeEventListener('focus', schedule);
    document.removeEventListener('visibilitychange', schedule);
  };
}

function requestEditorFocus(passive = false): void {
  const restore = window.cardbushDesktop?.restoreEditorFocus;
  if (!restore) return;
  const documentFocused = document.hasFocus();
  void restore({ documentFocused, passive }).then(restored => {
    if (documentFocused || !restored) return;
    // The native focus bit alone is not proof that keyboard input was restored.
    requestAnimationFrame(() => {
      void window.cardbushDesktop?.writeDebugLog?.('input-focus', {
        stage: 'editor-focus-result', passive, documentFocused: document.hasFocus(),
        visibility: document.visibilityState,
      }).catch(() => undefined);
    });
  }).catch(error => {
    console.warn('Unable to restore editor focus', error);
  });
}
