export type ConversationNavigation = { entries: string[]; index: number; recent: string[] };
export const emptyConversationNavigation: ConversationNavigation = { entries: [], index: -1, recent: [] };

export function visitConversation(state: ConversationNavigation, id: string): ConversationNavigation {
  if (!id) return state;
  const recent = state.recent[0] === id ? state.recent : [id, ...state.recent.filter(value => value !== id)].slice(0, 50);
  if (state.entries[state.index] === id) return recent === state.recent ? state : { ...state, recent };
  const entries = [...state.entries.slice(0, state.index + 1), id].slice(-50);
  return { entries, index: entries.length - 1, recent };
}

export function pruneConversationNavigation(state: ConversationNavigation, available: Set<string>): ConversationNavigation {
  const entries = state.entries.filter(id => available.has(id));
  const recent = state.recent.filter(id => available.has(id));
  if (entries.length === state.entries.length && recent.length === state.recent.length) return state;
  const index = state.entries.slice(0, state.index + 1).filter(id => available.has(id)).length - 1;
  return { entries, index, recent };
}
