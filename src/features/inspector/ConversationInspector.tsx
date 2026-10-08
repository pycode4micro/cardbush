import { createContext, useCallback, useRef, useState } from 'react';

/** A conversation can render scoped content inside the shared inspector tabs.
 * Portals preserve its host context, including remote file and Runtime routing. */
export const ConversationInspectorContext = createContext<{
  open: (id: string, title: string) => void;
  close: (id: string) => void;
  outlets: ReadonlyMap<string, HTMLDivElement>;
  visible: boolean;
  visibleTabIds?: ReadonlySet<string>;
} | null>(null);

/** Portal cleanup depends on these callbacks; navigation must not look like unmounting its host. */
export function useConversationInspectorActions(actions: { open(id: string, title: string): void; close(id: string): void }) {
  const current = useRef(actions); current.current = actions;
  const open = useCallback((id: string, title: string) => current.current.open(id, title), []);
  const close = useCallback((id: string) => current.current.close(id), []);
  return { open, close };
}

export function useConversationInspectorOutlets() {
  const [outlets, setOutlets] = useState<ReadonlyMap<string, HTMLDivElement>>(new Map());
  const register = useCallback((id: string, element: HTMLDivElement | null) => {
    setOutlets(current => {
      if ((current.get(id) ?? null) === element) return current;
      const next = new Map(current);
      if (element) next.set(id, element); else next.delete(id);
      return next;
    });
  }, []);
  return { outlets, register };
}

export function ConversationInspectorOutlet({ id, register }: {
  id: string; register: (id: string, element: HTMLDivElement | null) => void;
}) {
  const ref = useCallback((element: HTMLDivElement | null) => register(id, element), [id, register]);
  return <div className="conversation-inspector-outlet" ref={ref} />;
}
