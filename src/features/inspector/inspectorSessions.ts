import { inspectorTabsReducer, type InspectorHistoryTab, type InspectorResourceTab, type InspectorTabsAction, type InspectorTabsState } from './inspectorTabs';
import { onConversationDeleted, onConversationDraftAdopted } from '../../shared/conversationDraft';

export function localInspectorWorkspace(sessionId: string) { return `local:${JSON.stringify(sessionId)}`; }
export function agentInspectorWorkspace(connectionId: string, sessionId: string) {
  return `agent:${JSON.stringify([connectionId, sessionId])}`;
}

export type InspectorDraftAdoption = { from: string; to: string };
export function onInspectorSessionDeleted(listener: (workspaceId: string, draftId: string) => void) {
  return onConversationDeleted(({ sessionId, connectionId }) => listener(
    connectionId ? agentInspectorWorkspace(connectionId, sessionId) : localInspectorWorkspace(sessionId),
    connectionId ? agentInspectorWorkspace(connectionId, '') : localInspectorWorkspace(''),
  ));
}
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
  | { type: 'delete-workspace'; workspaceId: string; draftId: string }
  | { type: 'tabs'; workspaceId: string; action: InspectorTabsAction }
  | { type: 'navigate-start'; workspaceId: string; tabId: string; pages: (InspectorHistoryTab | InspectorResourceTab)[] }
  | { type: 'start-history'; tabId: string; step: 'back' | 'forward' | 'discard-forward' }
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
  let tabs = own?.tabs ?? [];
  if (state.lockedIds.size) {
    const ownIds = new Set(tabs.map(tab => tab.id));
    const shared = retainedInspectorTabs(state).filter(tab => state.lockedIds.has(tab.id) && !ownIds.has(tab.id));
    if (shared.length) tabs = [...tabs, ...shared];
  }
  const activeId = tabs.some(tab => tab.id === own?.activeId) ? own!.activeId : tabs[0]?.id ?? '';
  return { tabs, activeId, open: own?.open ?? state.lockedIds.size > 0 };
}

// Every remaining lock is visible in every workspace. Determining whether an
// empty pane should collapse doesn't require projecting all tabs for each owner.
function closeWorkspaceTabs(workspace: Workspace, ids: ReadonlySet<string>, hasLocks: boolean): Workspace {
  const next = ids.size ? inspectorTabsReducer(workspace, { type: 'close', ids }) : workspace;
  const open = workspace.open && (next.tabs.length > 0 || hasLocks);
  return next === workspace && open === workspace.open ? workspace : { ...next, open };
}

/** Resource pages have one owner. A lock shares visibility, never a second guest. */
export function inspectorSessionsReducer(state: InspectorSessionsState, action: InspectorSessionsAction): InspectorSessionsState {
  if (action.type === 'delete-workspace') {
    const removed = state.workspaces[action.workspaceId];
    if (!removed || action.workspaceId === action.draftId) return state;
    const workspaces = { ...state.workspaces };
    delete workspaces[action.workspaceId];
    // Locks survive their owner's deletion and remain reachable from the draft.
    const draft = workspaces[action.draftId];
    const keep = new Map(removed.tabs.filter(tab => state.lockedIds.has(tab.id)).map(tab => [tab.id, tab]));
    for (const other of Object.values(workspaces)) {
      if (!keep.size) break;
      for (const tab of other.tabs) keep.delete(tab.id);
    }
    if (keep.size) {
      const tabs = [...(draft?.tabs ?? []), ...keep.values()];
      workspaces[action.draftId] = { open: draft?.open ?? true, activeId: draft?.activeId || tabs[0].id, tabs };
    }
    return { ...state, workspaces };
  }
  if (action.type === 'start-history') {
    const owner = inspectorTabOwner(state, action.tabId);
    if (!owner) return state;
    const workspace = state.workspaces[owner];
    const current = workspace.tabs.find(tab => tab.id === action.tabId);
    if (current?.kind !== 'resource' && current?.kind !== 'history') return state;
    let page: InspectorResourceTab | InspectorHistoryTab;
    if (action.step === 'back' && current.backToStart) {
      page = { kind: 'resource', id: current.id, detail: current.backToStart, forwardPage: current };
    } else if (action.step !== 'back' && current.kind === 'resource' && current.forwardPage) {
      page = action.step === 'forward' ? current.forwardPage : { ...current, forwardPage: undefined };
    } else return state;
    return { ...state, workspaces: { ...state.workspaces, [owner]: { ...workspace,
      tabs: workspace.tabs.map(tab => tab.id === current.id ? page : tab) } } };
  }
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
    const retained = new Map(retainedInspectorTabs(state).map(tab => [tab.id, tab]));
    const tabs = [...new Set(action.ids)].flatMap(id => {
      const tab = retained.get(id);
      return tab?.kind === 'resource' ? [tab] : [];
    });
    if (!tabs.length) return state;
    const moved = new Set(tabs.filter(tab => !state.lockedIds.has(tab.id)).map(tab => tab.id));
    const own = state.workspaces[action.workspaceId] ?? { tabs: [], activeId: '', open: false };
    const workspaces = Object.fromEntries(Object.entries(state.workspaces).map(([key, workspace]) => [key,
      key === action.workspaceId ? workspace : closeWorkspaceTabs(workspace, moved, state.lockedIds.size > 0)]));
    workspaces[action.workspaceId] = { ...own, open: true, activeId: tabs[0].id,
      tabs: [...own.tabs, ...tabs.filter(tab => moved.has(tab.id) && !own.tabs.some(existing => existing.id === tab.id))] };
    return { ...state, workspaces };
  }
  if (action.type === 'toggle-lock') {
    if (!retainedInspectorTabs(state).some(tab => tab.id === action.id)) return state;
    const lockedIds = new Set(state.lockedIds);
    if (lockedIds.has(action.id)) lockedIds.delete(action.id); else lockedIds.add(action.id);
    return { ...state, lockedIds };
  }
  if (action.type === 'dispose') {
    const lockedIds = new Set([...state.lockedIds].filter(id => !action.ids.has(id)));
    const workspaces = Object.fromEntries(Object.entries(state.workspaces).map(([key, workspace]) =>
      [key, closeWorkspaceTabs(workspace, action.ids, lockedIds.size > 0)]));
    return { workspaces, lockedIds };
  }
  const visible = inspectorSession(state, action.workspaceId);
  const own = state.workspaces[action.workspaceId] ?? { tabs: [], activeId: '', open: visible.open };
  if (action.type === 'navigate-start') {
    const [first, ...others] = action.pages;
    const source = visible.tabs.find(tab => tab.id === action.tabId);
    if (!first || source?.kind !== 'resource' || source.pageId) return state;
    const owner = inspectorTabOwner(state, source.id)!;
    const original = state.workspaces[owner];
    // The guest may have reached about:blank after opening at a different URL.
    const backToStart = /^about:blank(?:[?#]|$)/i.test(source.detail.target) ? source.detail : { target: 'about:blank' };
    const replacement = { ...first, id: source.id, pageId: first.id, backToStart };
    const workspaces = { ...state.workspaces,
      [owner]: { ...original, tabs: original.tabs.map(tab => tab.id === source.id ? replacement : tab) },
    };
    workspaces[action.workspaceId] = { ...(workspaces[action.workspaceId] ?? own), activeId: source.id };
    let next = { ...state, workspaces };
    for (const tab of others) {
      next = inspectorSessionsReducer(next, {
        type: 'tabs', workspaceId: action.workspaceId, action: { type: 'open', tab, activate: false },
      });
    }
    return next;
  }
  if (action.type === 'open-state') {
    const open = typeof action.update === 'function' ? action.update(visible.open) : action.update;
    if (state.workspaces[action.workspaceId]?.open === open) return state;
    return { ...state, workspaces: { ...state.workspaces, [action.workspaceId]: { ...own, open } } };
  }
  const update = action.action;
  if (update.type === 'close') {
    // Resource closure disposes its guest everywhere. Explicitly opened portals
    // (e.g. the same SSH desktop) may also be referenced by another workspace.
    const closing = retainedInspectorTabs(state).filter(tab => update.ids.has(tab.id));
    const ids = new Set(closing.map(tab => tab.id));
    if (!ids.size) return state;
    const globalIds = new Set(closing.filter(tab => tab.kind === 'resource' || state.lockedIds.has(tab.id)).map(tab => tab.id));
    const lockedIds = new Set([...state.lockedIds].filter(id => !ids.has(id)));
    const workspaces = Object.fromEntries(Object.entries(state.workspaces).map(([key, workspace]) =>
      [key, closeWorkspaceTabs(workspace, key === action.workspaceId ? ids : globalIds, lockedIds.size > 0)]));
    return { workspaces, lockedIds };
  }
  if (update.type === 'activate') {
    if (own.activeId === update.id || !visible.tabs.some(tab => tab.id === update.id)) return state;
    return { ...state, workspaces: { ...state.workspaces, [action.workspaceId]: { ...own, activeId: update.id } } };
  }
  const targetId = visible.tabs.some(tab => tab.id === update.tab.id) ? update.tab.id
    : visible.tabs.find(tab => 'pageId' in tab && tab.pageId === update.tab.id)?.id ?? update.tab.id;
  const owner = inspectorTabOwner(state, targetId);
  if (owner && owner !== action.workspaceId) {
    if (state.lockedIds.has(targetId)) {
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
