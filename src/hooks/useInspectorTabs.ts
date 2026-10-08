import { useCallback, useMemo, useReducer, type SetStateAction } from 'react';
import type { InspectorTab } from '../features/inspector/inspectorTabs';
import { emptyInspectorSessions, inspectorSession, inspectorSessionsReducer, inspectorTabOwner, retainedInspectorTabs } from '../features/inspector/inspectorSessions';

export function useInspectorTabs(workspaceId = 'shared') {
  const [state, dispatch] = useReducer(inspectorSessionsReducer, emptyInspectorSessions);
  const visible = useMemo(() => inspectorSession(state, workspaceId), [state, workspaceId]);
  const allTabs = useMemo(() => retainedInspectorTabs(state), [state]);
  const openTab = useCallback((tab: InspectorTab, owner = workspaceId) => dispatch({ type: 'tabs', workspaceId: owner, action: { type: 'open', tab } }), [workspaceId]);
  const activateTab = useCallback((id: string, owner = workspaceId) => dispatch({ type: 'tabs', workspaceId: owner, action: { type: 'activate', id } }), [workspaceId]);
  const closeTabs = useCallback((ids: ReadonlySet<string>, owner = workspaceId) => dispatch({ type: 'tabs', workspaceId: owner, action: { type: 'close', ids } }), [workspaceId]);
  const setOpen = useCallback((update: SetStateAction<boolean>, owner = workspaceId) => dispatch({ type: 'open-state', workspaceId: owner, update }), [workspaceId]);
  const toggleLock = useCallback((id: string) => dispatch({ type: 'toggle-lock', id }), []);
  const disposeTabs = useCallback((ids: ReadonlySet<string>) => dispatch({ type: 'dispose', ids }), []);
  const ownerOfTab = useCallback((id: string) => inspectorTabOwner(state, id), [state]);
  return {
    tabs: visible.tabs, activeId: visible.activeId, open: visible.open,
    activeTab: visible.tabs.find(tab => tab.id === visible.activeId) ?? null,
    allTabs, lockedIds: state.lockedIds, toggleLock, ownerOfTab, disposeTabs,
    openTab, activateTab, closeTabs, setOpen,
  };
}
