import { useCallback, useLayoutEffect, useMemo, useReducer, type SetStateAction } from 'react';
import type { InspectorHistoryTab, InspectorResourceTab, InspectorTab } from '../features/inspector/inspectorTabs';
import { emptyInspectorSessions, inspectorSession, inspectorSessionsReducer, inspectorTabOwner, onInspectorDraftAdopted, onInspectorSessionDeleted, retainedInspectorTabs, type InspectorSessionsAction } from '../features/inspector/inspectorSessions';
import { useInspectorSessionRef } from '../features/inspector/useInspectorSessionState';

export function useInspectorTabs(workspaceId = 'shared', page?: string) {
  const [state, dispatch] = useReducer(inspectorSessionsReducer, emptyInspectorSessions);
  const workspace = useInspectorSessionRef(workspaceId, null);
  useLayoutEffect(() => onInspectorDraftAdopted(adoption => dispatch({ type: 'adopt-draft', ...adoption })), []);
  useLayoutEffect(() => onInspectorSessionDeleted((workspaceId, draftId) => dispatch({ type: 'delete-workspace', workspaceId, draftId })), []);
  const visible = useMemo(() => inspectorSession(state, workspaceId, page), [state, workspaceId, page]);
  // Moving an Electron webview in the DOM destroys its native guest, even with
  // a stable React key. Keep retained pages ordered independently of ownership.
  const allTabs = useMemo(() => retainedInspectorTabs(state).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), [state]);
  // A picker or delayed callback from a deleted conversation cannot recreate it.
  const dispatchOwned = useCallback((action: Extract<InspectorSessionsAction, { workspaceId: string }>) => {
    if (!workspace.deleted || action.workspaceId !== workspace.workspaceId) dispatch(action);
  }, [workspace]);
  const openTab = useCallback((tab: InspectorTab, owner = workspace.workspaceId, activate = true) =>
    dispatchOwned({ type: 'tabs', workspaceId: owner, action: { type: 'open', tab, activate } }), [workspace, dispatchOwned]);
  const navigateStartPage = useCallback((tabId: string, pages: (InspectorResourceTab | InspectorHistoryTab)[]) =>
    dispatchOwned({ type: 'navigate-start', workspaceId: workspace.workspaceId, tabId, pages }), [workspace, dispatchOwned]);
  const stepStartHistory = useCallback((tabId: string, step: 'back' | 'forward' | 'discard-forward') =>
    dispatch({ type: 'start-history', tabId, step }), []);
  const activateTab = useCallback((id: string, owner = workspace.workspaceId) => dispatchOwned({ type: 'tabs', workspaceId: owner, action: { type: 'activate', id } }), [workspace, dispatchOwned]);
  const closeTabs = useCallback((ids: ReadonlySet<string>, owner = workspace.workspaceId) => dispatchOwned({ type: 'tabs', workspaceId: owner, action: { type: 'close', ids } }), [workspace, dispatchOwned]);
  const setOpen = useCallback((update: SetStateAction<boolean>, owner = workspace.workspaceId) => dispatchOwned({
    type: 'open-state', workspaceId: owner, page: owner === workspace.workspaceId ? page : undefined, update,
  }), [workspace, dispatchOwned, page]);
  const toggleLock = useCallback((id: string) => dispatch({ type: 'toggle-lock', id }), []);
  const disposeTabs = useCallback((ids: ReadonlySet<string>) => dispatch({ type: 'dispose', ids }), []);
  const ownerOfTab = useCallback((id: string) => inspectorTabOwner(state, id), [state]);
  const bindBrowserTabs = useCallback((ids: string[], owner = workspace.workspaceId) => dispatchOwned({ type: 'bind-browser', workspaceId: owner, ids }), [workspace, dispatchOwned]);
  const snapshot = useCallback((owner = workspace.workspaceId) => inspectorSession(state, owner), [state, workspace]);
  return {
    tabs: visible.tabs, activeId: visible.activeId, open: visible.open,
    activeTab: visible.tabs.find(tab => tab.id === visible.activeId) ?? null,
    allTabs, lockedIds: state.lockedIds, toggleLock, ownerOfTab, disposeTabs,
    openTab, navigateStartPage, stepStartHistory, activateTab, closeTabs, setOpen, bindBrowserTabs, snapshot,
  };
}
