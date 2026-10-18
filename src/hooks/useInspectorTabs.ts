import { useCallback, useLayoutEffect, useMemo, useReducer, type SetStateAction } from 'react';
import type { InspectorTab } from '../features/inspector/inspectorTabs';
import { emptyInspectorSessions, inspectorSession, inspectorSessionsReducer, inspectorTabOwner, onInspectorDraftAdopted, retainedInspectorTabs } from '../features/inspector/inspectorSessions';
import { useInspectorSessionRef } from '../features/inspector/useInspectorSessionState';

export function useInspectorTabs(workspaceId = 'shared') {
  const [state, dispatch] = useReducer(inspectorSessionsReducer, emptyInspectorSessions);
  const workspace = useInspectorSessionRef(workspaceId, null);
  useLayoutEffect(() => onInspectorDraftAdopted(adoption => dispatch({ type: 'adopt-draft', ...adoption })), []);
  const visible = useMemo(() => inspectorSession(state, workspaceId), [state, workspaceId]);
  // Moving an Electron webview in the DOM destroys its native guest, even with
  // a stable React key. Keep retained pages ordered independently of ownership.
  const allTabs = useMemo(() => retainedInspectorTabs(state).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), [state]);
  const openTab = useCallback((tab: InspectorTab, owner = workspace.workspaceId) => dispatch({ type: 'tabs', workspaceId: owner, action: { type: 'open', tab } }), [workspace]);
  const activateTab = useCallback((id: string, owner = workspace.workspaceId) => dispatch({ type: 'tabs', workspaceId: owner, action: { type: 'activate', id } }), [workspace]);
  const closeTabs = useCallback((ids: ReadonlySet<string>, owner = workspace.workspaceId) => dispatch({ type: 'tabs', workspaceId: owner, action: { type: 'close', ids } }), [workspace]);
  const setOpen = useCallback((update: SetStateAction<boolean>, owner = workspace.workspaceId) => dispatch({ type: 'open-state', workspaceId: owner, update }), [workspace]);
  const toggleLock = useCallback((id: string) => dispatch({ type: 'toggle-lock', id }), []);
  const disposeTabs = useCallback((ids: ReadonlySet<string>) => dispatch({ type: 'dispose', ids }), []);
  const ownerOfTab = useCallback((id: string) => inspectorTabOwner(state, id), [state]);
  const bindBrowserTabs = useCallback((ids: string[], owner = workspace.workspaceId) => dispatch({ type: 'bind-browser', workspaceId: owner, ids }), [workspace]);
  const snapshot = useCallback((owner = workspace.workspaceId) => inspectorSession(state, owner), [state, workspace]);
  return {
    tabs: visible.tabs, activeId: visible.activeId, open: visible.open,
    activeTab: visible.tabs.find(tab => tab.id === visible.activeId) ?? null,
    allTabs, lockedIds: state.lockedIds, toggleLock, ownerOfTab, disposeTabs,
    openTab, activateTab, closeTabs, setOpen, bindBrowserTabs, snapshot,
  };
}
