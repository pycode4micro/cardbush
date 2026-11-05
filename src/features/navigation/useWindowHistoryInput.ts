import { useCallback, useEffect, useMemo, useRef } from 'react';
import { matchHistoryInput, type HistoryDirection, type HistoryInput } from '../../../electron/shortcutBinding';
import { historyBindings, type ShortcutOverrides } from '../shortcuts/keyboardShortcuts';

type Routes = {
  onBack?: () => void;
  onForward?: () => void;
  onInspectorHistory?: (direction: HistoryDirection, tabId?: string) => void;
};

function historyInputBlocked(target?: EventTarget | null) {
  const blocked = '[inert], dialog, [role="dialog"], [data-shortcut-recorder]';
  return (target instanceof Element && target.closest(blocked)) || document.activeElement?.closest(blocked)
    || Array.from(document.querySelectorAll('[aria-modal="true"]')).some(node => node.checkVisibility());
}

export function useWindowHistoryInput(routes: Routes, overrides: ShortcutOverrides) {
  const latest = useRef(routes);
  latest.current = routes;
  const bindings = useMemo(() => historyBindings(overrides), [overrides]);
  // Removing a preview can move DOM focus to body. The tab's containing section
  // survives traversal and still owns the next shortcut until focus moves away.
  const lastScope = useRef<Element | null>(null);
  const route = useCallback(({ direction, guestId }: HistoryInput) => {
    let focused = document.activeElement;
    if (guestId !== undefined) {
      focused = Array.from(document.querySelectorAll<HTMLElement & { getWebContentsId?(): number }>('webview')).find(node => {
        try { return node.getWebContentsId?.() === guestId; } catch { return false; }
      }) ?? null;
      if (!focused) return;
    } else if (!focused || focused === document.body || focused === document.documentElement) {
      focused = lastScope.current;
    }
    if (focused && (!focused.isConnected || focused.closest('[inert], [aria-hidden="true"]'))) return;
    if (focused?.closest('#right-inspector')) {
      const scope = focused.closest<HTMLElement>('[data-inspector-page-id], #right-inspector');
      lastScope.current = scope;
      latest.current.onInspectorHistory?.(direction, scope?.dataset.inspectorPageId);
      return;
    }
    if (direction === 'back') latest.current.onBack?.();
    else latest.current.onForward?.();
  }, []);
  const keydown = useCallback((event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    const direction = matchHistoryInput(bindings, event);
    if (!direction || historyInputBlocked(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) route({ direction });
  }, [bindings, route]);
  useEffect(() => {
    window.cardbushDesktop?.setHistoryBindings?.(bindings);
    const unsubscribe = window.cardbushDesktop?.onHistoryInput?.(input => {
      if (!historyInputBlocked()) route(input);
    });
    const remember = (event: FocusEvent | PointerEvent) => {
      if (event instanceof PointerEvent && event.button > 2) return;
      const target = event.target;
      if (target instanceof Element && target !== document.body && target !== document.documentElement) {
        lastScope.current = target.closest('[data-inspector-page-id], #right-inspector');
      }
    };
    window.addEventListener('focusin', remember, true);
    window.addEventListener('pointerdown', remember, true);
    window.addEventListener('keydown', keydown, true);
    return () => {
      unsubscribe?.();
      window.removeEventListener('focusin', remember, true);
      window.removeEventListener('pointerdown', remember, true);
      window.removeEventListener('keydown', keydown, true);
    };
  }, [bindings, keydown, route]);
}
