import { useCallback, useLayoutEffect, useRef } from 'react';
import { usePageState } from '../navigation/PageNavigation';

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
  const [entries, setEntries, returnToEntries] = usePageState<Entry[]>('plugin-pages', [{ id: 0, page: { kind: 'catalog' }, scrollTop: 0 }]);
  nextId.current = Math.max(nextId.current, ...entries.map(entry => entry.id));
  const current = entries[entries.length - 1];

  const open = useCallback((page: PluginPage, level: 'child' | 'section' = 'child') => {
    const scrollTop = rootRef.current?.closest(scrollContainer)?.scrollTop ?? 0;
    const active = document.activeElement;
    const entry: Entry = { id: ++nextId.current, page, scrollTop: 0 };
    setEntries(items => {
      const current = items[items.length - 1];
      if (page.kind === 'catalog') return items.length > 1 ? [items[0]] : items;
      if (JSON.stringify(current.page) === JSON.stringify(page) && !(level === 'section' && page.kind === 'marketplace')) return items;
      if (level === 'section' && items.length > 1) {
        // Returning from a detail keeps its parent list, search and scroll position.
        if (items.length > 2 && JSON.stringify(items[1].page) === JSON.stringify(page)) return items.slice(0, 2);
        return [items[0], entry];
      }
      if (active instanceof HTMLElement && rootRef.current?.contains(active)) focusTargets.current.set(current.id, active);
      return [...items.slice(0, -1), { ...current, scrollTop }, entry];
    });
  }, [setEntries]);
  const setManageTab = (tab: ManageTab) => setEntries(items => {
    const current = items[items.length - 1];
    if (current.page.kind !== 'manage' || (current.page.tab ?? 'plugins') === tab) return items;
    return [...items.slice(0, -1), { ...current, page: { kind: 'manage', tab } }];
  });
  const back = useCallback(() => returnToEntries(items => items.length > 1 ? items.slice(0, -1) : items,
    (candidate, target) => candidate.length === target.length && candidate.every((entry, index) => entry.id === target[index].id)), [returnToEntries]);
  const reset = useCallback(() => {
    setEntries([{ id: ++nextId.current, page: { kind: 'catalog' }, scrollTop: 0 }]);
  }, [setEntries]);
  const dismissPlugin = useCallback((pluginId: string) => setEntries(items => {
    const index = items.findIndex(entry => 'pluginId' in entry.page && entry.page.pluginId === pluginId);
    return index > 0 ? items.slice(0, index) : items;
  }), [setEntries]);

  const lastVisibleEntry = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    // An Activity reconnect keeps this same DOM and its current reading position.
    if (lastVisibleEntry.current === current.id) return;
    lastVisibleEntry.current = current.id;
    const focusTarget = focusTargets.current.get(current.id);
    if (focusTarget?.isConnected && !document.activeElement?.closest('.plugin-hub-toolbar')) focusTarget.focus({ preventScroll: true });
    const scroller = rootRef.current?.closest(scrollContainer);
    if (scroller) scroller.scrollTop = current.scrollTop;
  }, [current.id]);

  return { rootRef, entries, page: current.page, open, back, reset, dismissPlugin, setManageTab };
}
