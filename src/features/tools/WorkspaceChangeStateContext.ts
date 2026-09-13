import { createContext } from 'react';
import type { ConversationChangeReport } from './toolChangeReports';

type ChangeIdentity = Pick<ConversationChangeReport, 'turnId' | 'messageId' | 'reverted'>;

export function workspaceChangeKey(sessionId: string, report: ChangeIdentity): string {
  return JSON.stringify([sessionId, report.turnId?.trim() || `message:${report.messageId}`]);
}

export function workspaceChangeReverted(states: ReadonlyMap<string, boolean>, sessionId: string, report: ChangeIdentity): boolean {
  return states.get(workspaceChangeKey(sessionId, report)) ?? report.reverted ?? false;
}

export const WorkspaceChangeStateContext = createContext<{
  states: ReadonlyMap<string, boolean>;
  busy: boolean;
}>({ states: new Map(), busy: false });

// Old diff-only histories have no runtime checkpoint in which to retain this state.
const storageKey = 'cardbush.reverted_legacy_change_keys';
export function readLegacyRevertKeys(): Set<string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
    return new Set(Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string') : []);
  } catch { return new Set(); }
}
export function saveLegacyRevertKeys(keys: ReadonlySet<string>): void {
  try { localStorage.setItem(storageKey, JSON.stringify([...keys])); } catch { /* Current-session undo remains available. */ }
}
