import { inspectorTabsReducer, type InspectorTabsAction, type InspectorTabsState } from './inspectorTabs';
import { onConversationDraftAdopted } from '../../shared/conversationDraft';

export function localInspectorWorkspace(sessionId: string) { return `local:${JSON.stringify(sessionId)}`; }
export function agentInspectorWorkspace(connectionId: string, sessionId: string) {
  return `agent:${JSON.stringify([connectionId, sessionId])}`;
}

export type InspectorDraftAdoption = { from: string; to: string };
export function onInspectorDraftAdopted(listener: (adoption: InspectorDraftAdoption) => void) {
  return onConversationDraftAdopted(({ sessionId, connectionId }) => listener({
    from: connectionId ? agentInspectorWorkspace(connectionId, '') : localInspectorWorkspace(''),
    to: connectionId ? agentInspectorWorkspace(connectionId, sessionId) : localInspectorWorkspace(sessionId),
  }));
}

export function adoptInspectorSessionState<T>(values: Record<string, T>, { from, to }: InspectorDraftAdoption): Record<string, T> {
  if (from === to || !Object.hasOwn(values, from)) return values;
  const next = { ...values, [to]: values[from] };
  delete next[from];
  return next;
}

type Workspace = InspectorTabsState & { open: boolean };
export type InspectorSessionsState = { workspaces: Record<string, Workspace>; lockedIds: ReadonlySet<string> };
export const emptyInspectorSessions: InspectorSessionsState = { workspaces: {}, lockedIds: new Set() };
export type InspectorSessionsAction =
  | ({ type: 'adopt-draft' } & InspectorDraftAdoption)
  | { type: 'tabs'; workspaceId: string; action: InspectorTabsAction }
  | { type: 'open-state'; workspaceId: string; update: boolean | ((open: boolean) => boolean) }
  | { type: 'bind-browser'; workspaceId: string; ids: string[] }
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
  if (action.type === 'adopt-draft') {
    const draft = state.workspaces[action.from];
    if (!draft || action.from === action.to) return state;
    const destination = state.workspaces[action.to];
    const workspaces = adoptInspectorSessionState(state.workspaces, action);
    workspaces[action.to] = { ...draft,
      tabs: [...draft.tabs, ...(destination?.tabs ?? []).filter(tab => !draft.tabs.some(own => own.id === tab.id))],
      activeId: draft.activeId || destination?.activeId || '',
    };
    return { ...state, workspaces };
  }
  if (action.type === 'bind-browser') {
    // An explicit @ reference carries the existing guest into its conversation.
    // Move unlocked resources atomically; locked tabs remain shared by their owner.
    const tabs = action.ids.flatMap(id => {
      const tab = retainedInspectorTabs(state).find(tab => tab.id === id);
      return tab?.kind === 'resource' ? [tab] : [];
    });
    if (!tabs.length) return state;
    const moved = new Set(tabs.filter(tab => !state.lockedIds.has(tab.id)).map(tab => tab.id));
    const own = state.workspaces[action.workspaceId] ?? { tabs: [], activeId: '', open: false };
    const workspaces = Object.fromEntries(Object.entries(state.workspaces).map(([key, workspace]) => [key,
      key === action.workspaceId ? workspace : { ...workspace, ...inspectorTabsReducer(workspace, { type: 'close', ids: moved }) }]));
    workspaces[action.workspaceId] = { ...own, open: true, activeId: tabs[0].id,
      tabs: [...own.tabs, ...tabs.filter(tab => moved.has(tab.id) && !own.tabs.some(existing => existing.id === tab.id))] };
    const next = { ...state, workspaces };
    for (const [key, workspace] of Object.entries(workspaces)) {
      if (!inspectorSession(next, key).tabs.length) workspaces[key] = { ...workspace, open: false };
    }
    return next;
  }
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
        [action.workspaceId]: { ...own, activeId: update.activate === false ? visible.activeId : refreshed.activeId } } };
    }
    if (update.tab.kind === 'resource') return state;
  }
  const next = inspectorTabsReducer(update.activate === false ? { ...own, activeId: visible.activeId } : own, update);
  return { ...state, workspaces: { ...state.workspaces, [action.workspaceId]: { ...own, ...next } } };
}
