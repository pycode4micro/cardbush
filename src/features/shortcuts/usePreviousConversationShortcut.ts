import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import { emptyConversationNavigation, pruneConversationNavigation, visitConversation } from './conversationNavigation';

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
  const [navigation, setNavigation] = useState(emptyConversationNavigation);
  const navigationRef = useRef(navigation);
  navigationRef.current = navigation;
  useLayoutEffect(() => { latest.current = options; });
  useLayoutEffect(() => {
    const available = new Set([...options.conversations, ...options.preparedConversations].map(item => item.id));
    setNavigation(state => {
      const pruned = pruneConversationNavigation(state, available);
      return available.has(options.activeConversationId) ? visitConversation(pruned, options.activeConversationId) : pruned;
    });
  }, [options.activeConversationId, options.conversations, options.preparedConversations]);

  const previous = () => {
    const current = latest.current;
    const id = navigationRef.current.recent.find(value => value !== current.activeConversationId);
    if (id) current.onOpenConversation(id);
  };
  const previousRef = useRef(previous);
  previousRef.current = previous;

  const move = (delta: number) => {
    const state = navigationRef.current;
    const index = state.index + delta;
    const id = state.entries[index];
    if (!id) return;
    const next = { ...state, index };
    navigationRef.current = next;
    setNavigation(next);
    latest.current.onOpenConversation(id);
  };

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
      previousRef.current();
    };
    // A composer suggestion menu must not consume Ctrl+Tab as plain Tab.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [shortcuts]);
  return {
    canGoBack: navigation.index > 0,
    canGoForward: navigation.index >= 0 && navigation.index < navigation.entries.length - 1,
    canGoPrevious: navigation.recent.some(id => id !== options.activeConversationId),
    goBack: () => move(-1), goForward: () => move(1), previous,
  };
}
