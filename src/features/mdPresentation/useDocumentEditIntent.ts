import { useEffect, useRef, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { changedRange } from './fileEditPreview';

const textSurface = '.bush-page-content[contenteditable="true"], .md-source, .bush-page-title, .bush-section-title';

/** A preview has no keyboard ownership. Only a real document mutation leaves it. */
export function useDocumentEditIntent(root: RefObject<HTMLElement | null>, previewing: boolean,
  onBeforeEdit?: () => void, onCompositionChange?: (composing: boolean) => void) {
  const current = useRef({ previewing, onBeforeEdit, onCompositionChange });
  current.current = { previewing, onBeforeEdit, onCompositionChange };
  const prepare = () => {
    const { previewing, onBeforeEdit } = current.current;
    const input = document.activeElement;
    const selection = previewing && (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement)
      && root.current?.contains(input) && input.matches(textSurface) && input.selectionStart !== null
      ? { value: input.value, start: input.selectionStart, end: input.selectionEnd!, direction: input.selectionDirection } : undefined;
    // Restore the committed document before the browser/ProseMirror applies
    // the user's input. Never turn a partial tool-call preview into a draft.
    if (previewing) flushSync(() => onBeforeEdit?.());
    else onBeforeEdit?.();
    if (selection && input instanceof HTMLElement && input.isConnected && (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement)) {
      const range = changedRange(selection.value, input.value);
      const map = (position: number) => position <= range.start ? position : position >= range.oldEnd
        ? position + range.end - range.oldEnd : Math.min(range.end, position);
      input.setSelectionRange(map(selection.start), map(selection.end), selection.direction ?? undefined);
    }
    return previewing;
  };
  const callback = useRef(prepare); callback.current = prepare;
  useEffect(() => {
    const element = root.current; if (!element) return;
    let composing = false;
    const editable = (event: Event) => event.target instanceof Element && !!event.target.closest(textSurface)
      && !event.target.closest('[readonly], [contenteditable="false"]');
    const input = (event: Event) => { if (editable(event)) callback.current(); };
    const checkbox = (event: Event) => {
      if (!(event.target instanceof HTMLInputElement) || event.target.type !== 'checkbox' || !event.target.closest('.bush-page-content')) return;
      const checked = event.target.checked;
      callback.current();
      if (event.target.isConnected) event.target.checked = checked;
    };
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !editable(event) || event.isComposing) return;
      // Editor commands may mutate before a native beforeinput event occurs.
      // Navigation, focus, shortcuts such as Save, and Escape are not edits.
      if (['Enter', 'Backspace', 'Delete'].includes(event.key)
        || (event.ctrlKey || event.metaKey) && !event.altKey && /^[zybiu]$/i.test(event.key)) callback.current();
    };
    const start = (event: Event) => { if (editable(event)) { input(event); composing = true; current.current.onCompositionChange?.(true); } };
    const end = () => { if (composing) { composing = false; current.current.onCompositionChange?.(false); } };
    const mutations = ['beforeinput', 'paste', 'cut', 'drop'] as const;
    mutations.forEach(name => element.addEventListener(name, input, true));
    element.addEventListener('keydown', key, true);
    element.addEventListener('click', checkbox, true);
    element.addEventListener('compositionstart', start, true); element.addEventListener('compositionend', end, true);
    element.addEventListener('focusout', end);
    return () => {
      mutations.forEach(name => element.removeEventListener(name, input, true));
      element.removeEventListener('keydown', key, true);
      element.removeEventListener('click', checkbox, true);
      element.removeEventListener('compositionstart', start, true); element.removeEventListener('compositionend', end, true);
      element.removeEventListener('focusout', end); end();
    };
  }, [root]);
  return prepare;
}
