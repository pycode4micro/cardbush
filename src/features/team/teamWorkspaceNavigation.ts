import { useSyncExternalStore } from 'react';

export type TeamWorkspaceTab = 'teams' | 'agents' | 'runs';
type DocumentRequest = { kind: 'create' } | { kind: 'open' } | { kind: 'select'; id: string };
type OpenDocument = { id: string; name: string; dirty: boolean };
type Navigation = { tab: TeamWorkspaceTab; document: OpenDocument | null; request: DocumentRequest | null; busy: boolean };

const listeners = new Set<() => void>();
let snapshot: Navigation = { tab: 'teams', document: null, request: null, busy: false };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function publish(change: Partial<Navigation>) { snapshot = { ...snapshot, ...change }; listeners.forEach(listener => listener()); }

export function showTeamWorkspaceTab(tab: TeamWorkspaceTab) { if (snapshot.tab !== tab) publish({ tab }); }
// Browsing a document must not change the team used by conversations.
export function requestTeamDocument(request: DocumentRequest) { publish({ tab: 'teams', request }); }
export function consumeTeamDocumentRequest(request: DocumentRequest) {
  if (snapshot.request !== request) return false;
  publish({ request: null }); return true;
}
export function setTeamOpenDocument(document: OpenDocument | null, busy: boolean) {
  const previous = snapshot.document;
  if (snapshot.busy === busy && previous?.id === document?.id && previous?.name === document?.name && previous?.dirty === document?.dirty) return;
  publish({ document, busy });
}
export function useTeamWorkspaceNavigation() { return useSyncExternalStore(subscribe, () => snapshot); }
