let nextRequestId = 0;
let pending: { element: HTMLElement; passive: boolean; cancel(): void } | undefined;

/** Wait for the pointer's normal focus/selection handling before native repair. */
export function restoreNativeEditorFocus(event: { isTrusted: boolean; button: number }, element: HTMLElement): void {
  if (!event.isTrusted || event.button !== 0) return;
  requestEditorFocus(element);
}

/** Explicit activation repairs DOM and native focus without moving the caret. */
export function focusEditor(element: HTMLElement | null): void {
  if (!element) return;
  element.focus({ preventScroll: true });
  requestEditorFocus(element);
}

/** Recover a focused editor's lost widget without taking focus from previews. */
export function observeEditorFocus(element: HTMLElement): () => void {
  const check = () => {
    if (activeEditor(element) && !document.hasFocus()) requestEditorFocus(element, true);
  };
  element.addEventListener('focus', check);
  window.addEventListener('blur', check);
  window.addEventListener('focus', check);
  document.addEventListener('visibilitychange', check);
  return () => {
    if (pending?.element === element) pending.cancel();
    element.removeEventListener('focus', check);
    window.removeEventListener('blur', check);
    window.removeEventListener('focus', check);
    document.removeEventListener('visibilitychange', check);
  };
}

function activeEditor(element: HTMLElement): boolean {
  return element.isConnected && document.activeElement === element && document.visibilityState === 'visible'
    && element.getClientRects().length > 0 && !element.closest('[inert]')
    && (element.isContentEditable || (element instanceof HTMLTextAreaElement && !element.readOnly && !element.disabled));
}

function requestEditorFocus(element: HTMLElement, passive = false): void {
  const restore = window.cardbushDesktop?.restoreEditorFocus;
  if (!restore) return;
  // Window focus events caused by our own repair must not start another repair.
  if (pending?.element === element && (passive || !pending.passive)) return;
  pending?.cancel();
  const requestId = ++nextRequestId;
  let timer: number | undefined;
  let attempts = 0;
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    window.clearTimeout(timer);
    element.removeAttribute('data-editor-focus-request');
    document.removeEventListener('pointerdown', leaveEditor, true);
    document.removeEventListener('focusin', leaveEditor, true);
    if (pending?.cancel === cancel) pending = undefined;
  };
  const leaveEditor = (event: Event) => {
    if (!(event.target instanceof Node) || !element.contains(event.target)) cancel();
  };
  const attempt = async () => {
    if (cancelled || !activeEditor(element)) { cancel(); return; }
    element.setAttribute('data-editor-focus-request', String(requestId));
    attempts++;
    try {
      await restore({ requestId, documentFocused: document.hasFocus(), passive });
      if (cancelled) return;
      // Electron's response is not proof that the renderer can receive keys.
      // Recheck after the native/guest transition; retry at most twice.
      timer = window.setTimeout(() => {
        if (!activeEditor(element) || document.hasFocus()) { cancel(); return; }
        if (attempts < 3) { void attempt(); return; }
        void window.cardbushDesktop?.writeDebugLog?.('input-focus', {
          stage: 'editor-focus-unresolved', passive, attempts,
          documentFocused: document.hasFocus(), visibility: document.visibilityState,
        }).catch(() => undefined);
        cancel();
      }, attempts === 1 ? 60 : 180);
    } catch (error) {
      if (!cancelled) { cancel(); console.warn('Unable to restore editor focus', error); }
    }
  };
  pending = { element, passive, cancel };
  document.addEventListener('pointerdown', leaveEditor, true);
  document.addEventListener('focusin', leaveEditor, true);
  // Pointerdown precedes the browser's default action; sampling immediately can
  // capture the previous preview instead of the editor the user just selected.
  timer = window.setTimeout(() => { void attempt(); }, 0);
}
