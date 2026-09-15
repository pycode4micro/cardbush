import { useCallback, useLayoutEffect, useRef, useState } from 'react';

export type ManageTab = 'plugins' | 'apps' | 'mcp';
export type PluginPage =
  | { kind: 'catalog' }
  | { kind: 'manage'; tab?: ManageTab }
  | { kind: 'marketplace' }
  | { kind: 'network' }
  | { kind: 'mcp'; serverId?: string }
  | { kind: 'workspace'; pluginId: string; extensionId: string }
  | { kind: 'accounts'; pluginId: string }
  | { kind: 'plugin'; pluginId: string }
  | { kind: 'skill'; skillName: string };

type Entry = { id: number; page: PluginPage; scrollTop: number; focusTarget?: HTMLElement };

/** Retain each ancestor's filters and local state until its child is dismissed. */
export function usePluginNavigation() {
  const rootRef = useRef<HTMLDivElement>(null);
  const nextId = useRef(0);
  const [entries, setEntries] = useState<Entry[]>([{ id: 0, page: { kind: 'catalog' }, scrollTop: 0 }]);
  const current = entries[entries.length - 1];

  const open = useCallback((page: PluginPage) => {
    const scrollTop = rootRef.current?.closest('.settings-content')?.scrollTop ?? 0;
    const active = document.activeElement;
    const focusTarget = active instanceof HTMLElement && rootRef.current?.contains(active) ? active : undefined;
    const entry: Entry = { id: ++nextId.current, page, scrollTop: 0 };
    setEntries(items => [...items.slice(0, -1), { ...items[items.length - 1], scrollTop, focusTarget }, entry]);
  }, []);
  const back = useCallback(() => setEntries(items => items.length > 1 ? items.slice(0, -1) : items), []);
  const reset = useCallback(() => {
    setEntries([{ id: ++nextId.current, page: { kind: 'catalog' }, scrollTop: 0 }]);
  }, []);
  const dismissPlugin = useCallback((pluginId: string) => setEntries(items => {
    const index = items.findIndex(entry => 'pluginId' in entry.page && entry.page.pluginId === pluginId);
    return index > 0 ? items.slice(0, index) : items;
  }), []);

  useLayoutEffect(() => {
    current.focusTarget?.focus({ preventScroll: true });
    const scroller = rootRef.current?.closest('.settings-content');
    if (scroller) scroller.scrollTop = current.scrollTop;
  }, [current.id]);

  return { rootRef, entries, page: current.page, open, back, reset, dismissPlugin };
}
