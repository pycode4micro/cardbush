import { inspectorTabsReducer, type InspectorTabsAction, type InspectorTabsState } from './inspectorTabs';

export function localInspectorWorkspace(sessionId: string) { return `local:${JSON.stringify(sessionId)}`; }
export function agentInspectorWorkspace(connectionId: string, sessionId: string) {
  return `agent:${JSON.stringify([connectionId, sessionId])}`;
}

type Workspace = InspectorTabsState & { open: boolean };
export type InspectorSessionsState = { workspaces: Record<string, Workspace>; lockedIds: ReadonlySet<string> };
export const emptyInspectorSessions: InspectorSessionsState = { workspaces: {}, lockedIds: new Set() };
export type InspectorSessionsAction =
  | { type: 'tabs'; workspaceId: string; action: InspectorTabsAction }
  | { type: 'open-state'; workspaceId: string; update: boolean | ((open: boolean) => boolean) }
  | { type: 'dispose'; ids: ReadonlySet<string> }
  | { type: 'toggle-lock'; id: string };

export function retainedInspectorTabs(state: InspectorSessionsState) {
  const tabs = new Map<string, InspectorTabsState['tabs'][number]>();
  for (const workspace of Object.values(state.workspaces)) for (const tab of workspace.tabs) {
    if (!tabs.has(tab.id)) tabs.set(tab.id, tab);
  }
  return [...tabs.values()];
}
export function inspectorTabOwner(state: InspectorSessionsState, id: string) {
  return Object.keys(state.workspaces).find(key => state.workspaces[key].tabs.some(tab => tab.id === id));
}
export function inspectorSession(state: InspectorSessionsState, workspaceId: string) {
  const own = state.workspaces[workspaceId];
  const locked = retainedInspectorTabs(state).filter(tab => state.lockedIds.has(tab.id));
  const tabs = [...(own?.tabs ?? []), ...locked.filter(tab => !own?.tabs.some(owned => owned.id === tab.id))];
  const activeId = tabs.some(tab => tab.id === own?.activeId) ? own!.activeId : tabs[0]?.id ?? '';
  return { tabs, activeId, open: own?.open ?? locked.length > 0 };
}

/** Resource pages have one owner. A lock shares visibility, never a second guest. */
export function inspectorSessionsReducer(state: InspectorSessionsState, action: InspectorSessionsAction): InspectorSessionsState {
  if (action.type === 'toggle-lock') {
    if (!retainedInspectorTabs(state).some(tab => tab.id === action.id)) return state;
    const lockedIds = new Set(state.lockedIds);
    if (lockedIds.has(action.id)) lockedIds.delete(action.id); else lockedIds.add(action.id);
    return { ...state, lockedIds };
  }
  if (action.type === 'dispose') {
    const workspaces = Object.fromEntries(Object.entries(state.workspaces).map(([key, workspace]) =>
      [key, { ...workspace, ...inspectorTabsReducer(workspace, { type: 'close', ids: action.ids }) }]));
    const next = { workspaces, lockedIds: new Set([...state.lockedIds].filter(id => !action.ids.has(id))) };
    for (const key of Object.keys(workspaces)) if (!inspectorSession(next, key).tabs.length) workspaces[key] = { ...workspaces[key], open: false };
    return next;
  }
  const visible = inspectorSession(state, action.workspaceId);
  const own = state.workspaces[action.workspaceId] ?? { tabs: [], activeId: '', open: visible.open };
  if (action.type === 'open-state') {
    const open = typeof action.update === 'function' ? action.update(visible.open) : action.update;
    return { ...state, workspaces: { ...state.workspaces, [action.workspaceId]: { ...own, open } } };
  }
  const update = action.action;
  if (update.type === 'close') {
    // Resource closure disposes its guest everywhere. Explicitly opened portals
    // (e.g. the same SSH desktop) may also be referenced by another workspace.
    const retained = retainedInspectorTabs(state);
    const ids = new Set([...update.ids].filter(id => retained.some(tab => tab.id === id)));
    if (!ids.size) return state;
    const workspaces = Object.fromEntries(Object.entries(state.workspaces).map(([key, workspace]) => {
      const closing = key === action.workspaceId ? ids : new Set([...ids].filter(id => state.lockedIds.has(id) || retained.some(tab => tab.id === id && tab.kind === 'resource')));
      const next = inspectorTabsReducer(workspace, { type: 'close', ids: closing });
      return [key, { ...workspace, ...next }];
    }));
    const lockedIds = new Set([...state.lockedIds].filter(id => !ids.has(id)));
    const next = { workspaces, lockedIds };
    for (const key of Object.keys(workspaces)) {
      if (!inspectorSession(next, key).tabs.length) workspaces[key] = { ...workspaces[key], open: false };
    }
    return next;
  }
  if (update.type === 'activate') {
    if (!visible.tabs.some(tab => tab.id === update.id)) return state;
    return { ...state, workspaces: { ...state.workspaces, [action.workspaceId]: { ...own, activeId: update.id } } };
  }
  const owner = inspectorTabOwner(state, update.tab.id);
  if (owner && owner !== action.workspaceId) {
    if (state.lockedIds.has(update.tab.id)) {
      // Refresh the original page; selecting a lock must not adopt it into a
      // second conversation where it would linger after unlocking.
      const original = state.workspaces[owner];
      const refreshed = inspectorTabsReducer(original, update);
      return { ...state, workspaces: { ...state.workspaces,
        [owner]: { ...original, tabs: refreshed.tabs },
        [action.workspaceId]: { ...own, activeId: refreshed.activeId } } };
    }
    if (update.tab.kind === 'resource') return state;
  }
  const next = inspectorTabsReducer(own, update);
  return { ...state, workspaces: { ...state.workspaces, [action.workspaceId]: { ...own, ...next } } };
}
