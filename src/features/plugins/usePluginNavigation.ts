import { useCallback, useLayoutEffect, useRef } from 'react';
import { usePageState, usePageBack } from '../navigation/PageNavigation';

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

type Entry = { id: number; page: PluginPage; scrollTop: number };
const scrollContainer = '[data-plugin-scroll-container], .settings-content';

/** Retain each ancestor's filters and local state until its child is dismissed. */
export function usePluginNavigation() {
  const rootRef = useRef<HTMLDivElement>(null);
  const nextId = useRef(0);
  const focusTargets = useRef(new Map<number, HTMLElement>());
  const [entries, setEntries] = usePageState<Entry[]>('plugin-pages', [{ id: 0, page: { kind: 'catalog' }, scrollTop: 0 }]);
  nextId.current = Math.max(nextId.current, ...entries.map(entry => entry.id));
  const current = entries[entries.length - 1];

  const open = useCallback((page: PluginPage) => {
    const scrollTop = rootRef.current?.closest(scrollContainer)?.scrollTop ?? 0;
    const active = document.activeElement;
    const entry: Entry = { id: ++nextId.current, page, scrollTop: 0 };
    setEntries(items => {
      if (JSON.stringify(items[items.length - 1].page) === JSON.stringify(page)) return items;
      if (active instanceof HTMLElement && rootRef.current?.contains(active)) focusTargets.current.set(items[items.length - 1].id, active);
      return [...items.slice(0, -1), { ...items[items.length - 1], scrollTop }, entry];
    });
  }, [setEntries]);
  const back = usePageBack(() => setEntries(items => items.length > 1 ? items.slice(0, -1) : items));
  const reset = useCallback(() => {
    setEntries([{ id: ++nextId.current, page: { kind: 'catalog' }, scrollTop: 0 }]);
  }, [setEntries]);
  const dismissPlugin = useCallback((pluginId: string) => setEntries(items => {
    const index = items.findIndex(entry => 'pluginId' in entry.page && entry.page.pluginId === pluginId);
    return index > 0 ? items.slice(0, index) : items;
  }), [setEntries]);

  useLayoutEffect(() => {
    const focusTarget = focusTargets.current.get(current.id);
    if (focusTarget?.isConnected) focusTarget.focus({ preventScroll: true });
    const scroller = rootRef.current?.closest(scrollContainer);
    if (scroller) scroller.scrollTop = current.scrollTop;
  }, [current.id]);

  return { rootRef, entries, page: current.page, open, back, reset, dismissPlugin };
}
