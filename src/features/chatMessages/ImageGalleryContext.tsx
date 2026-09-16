import { createContext, useLayoutEffect, useMemo, type ReactNode } from 'react';
import type { AppLanguage, ChatMessage } from '../../types';
import type { ProjectPathAlias } from '../conversationScope';

export type ImageGalleryContextValue = {
  sessionId: string;
  messages: ChatMessage[];
  workspaceRoot?: string;
  pathAliases?: ProjectPathAlias[];
  language?: AppLanguage;
};
type GalleryContext = Omit<ImageGalleryContextValue, 'messages'> & {
  read: () => ChatMessage[];
  subscribe: (listener: () => void) => () => void;
};
export const ImageGalleryContext = createContext<GalleryContext | null>(null);

/** Uses conversation facts directly; collection happens only while a viewer is open. */
export function ImageGalleryProvider({ children, ...value }: ImageGalleryContextValue & { children: ReactNode }) {
  const store = useMemo(() => {
    const listeners = new Set<() => void>();
    return { messages: value.messages, listeners, subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    } };
  }, [value.sessionId]);
  const context = useMemo(() => ({ sessionId: value.sessionId, workspaceRoot: value.workspaceRoot,
    pathAliases: value.pathAliases, language: value.language, read: () => store.messages, subscribe: store.subscribe,
  }), [store, value.sessionId, value.workspaceRoot, JSON.stringify(value.pathAliases), value.language]);
  useLayoutEffect(() => {
    if (store.messages === value.messages) return;
    store.messages = value.messages;
    store.listeners.forEach(listener => listener());
  }, [store, value.messages]);
  return <ImageGalleryContext.Provider value={context}>{children}</ImageGalleryContext.Provider>;
}
