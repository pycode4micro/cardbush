import { useCallback, useMemo, useReducer, type SetStateAction } from 'react';
import type { InspectorTab } from '../features/inspector/inspectorTabs';
import { emptyInspectorSessions, inspectorSession, inspectorSessionsReducer, inspectorTabOwner, retainedInspectorTabs } from '../features/inspector/inspectorSessions';

export function useInspectorTabs(workspaceId = 'shared') {
  const [state, dispatch] = useReducer(inspectorSessionsReducer, emptyInspectorSessions);
  const visible = useMemo(() => inspectorSession(state, workspaceId), [state, workspaceId]);
  // Moving an Electron webview in the DOM destroys its native guest, even with
  // a stable React key. Keep retained pages ordered independently of ownership.
  const allTabs = useMemo(() => retainedInspectorTabs(state).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), [state]);
  const openTab = useCallback((tab: InspectorTab, owner = workspaceId) => dispatch({ type: 'tabs', workspaceId: owner, action: { type: 'open', tab } }), [workspaceId]);
  const activateTab = useCallback((id: string, owner = workspaceId) => dispatch({ type: 'tabs', workspaceId: owner, action: { type: 'activate', id } }), [workspaceId]);
  const closeTabs = useCallback((ids: ReadonlySet<string>, owner = workspaceId) => dispatch({ type: 'tabs', workspaceId: owner, action: { type: 'close', ids } }), [workspaceId]);
  const setOpen = useCallback((update: SetStateAction<boolean>, owner = workspaceId) => dispatch({ type: 'open-state', workspaceId: owner, update }), [workspaceId]);
  const toggleLock = useCallback((id: string) => dispatch({ type: 'toggle-lock', id }), []);
  const disposeTabs = useCallback((ids: ReadonlySet<string>) => dispatch({ type: 'dispose', ids }), []);
  const ownerOfTab = useCallback((id: string) => inspectorTabOwner(state, id), [state]);
  const bindBrowserTabs = useCallback((ids: string[], owner = workspaceId) => dispatch({ type: 'bind-browser', workspaceId: owner, ids }), [workspaceId]);
  const snapshot = useCallback((owner = workspaceId) => inspectorSession(state, owner), [state, workspaceId]);
  return {
    tabs: visible.tabs, activeId: visible.activeId, open: visible.open,
    activeTab: visible.tabs.find(tab => tab.id === visible.activeId) ?? null,
    allTabs, lockedIds: state.lockedIds, toggleLock, ownerOfTab, disposeTabs,
    openTab, activateTab, closeTabs, setOpen, bindBrowserTabs, snapshot,
  };
}
