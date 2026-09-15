import { useEffect, useLayoutEffect, useRef } from 'react';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';

type ConversationTarget = { id: string };
type Options = {
  activeConversationId: string;
  conversations: ConversationTarget[];
  preparedConversations: ConversationTarget[];
  enabled: boolean;
  onOpenConversation: (id: string) => void;
};

/** Window-local navigation history. Background activity never changes recency. */
export function usePreviousConversationShortcut(options: Options) {
  const shortcuts = useKeyboardShortcuts();
  const latest = useRef(options);
  const visited = useRef<string[]>([]);
  useLayoutEffect(() => { latest.current = options; });
  useLayoutEffect(() => {
    const id = options.activeConversationId;
    if (id) visited.current = [id, ...visited.current.filter(previous => previous !== id)].slice(0, 50);
  }, [options.activeConversationId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const current = latest.current;
      if (!current.enabled || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if (event.target instanceof Element && event.target.closest(
        '[inert], dialog, [role="dialog"], [aria-modal="true"], [data-shortcut-recorder]',
      )) return;
      // Consume repeats too, but only a new key press performs navigation.
      const gesture = { key: event.key, code: event.code, ctrlKey: event.ctrlKey,
        metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey };
      if (!shortcuts.matches('previousConversation', gesture)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      const available = new Set([...current.conversations, ...current.preparedConversations].map(item => item.id));
      visited.current = visited.current.filter(id => available.has(id));
      const previous = visited.current.find(id => id !== current.activeConversationId);
      if (previous) current.onOpenConversation(previous);
    };
    // A composer suggestion menu must not consume Ctrl+Tab as plain Tab.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [shortcuts]);
}
