export type ConversationDraftAdoption = { sessionId: string; connectionId?: string };
const adopted = 'cardbush:conversation-draft-adopted';

/** Emitted before selecting a newly prepared session, never for ordinary navigation. */
export function adoptConversationDraft(sessionId: string, connectionId?: string) {
  window.dispatchEvent(new CustomEvent<ConversationDraftAdoption>(adopted, { detail: { sessionId, connectionId } }));
}

export function onConversationDraftAdopted(listener: (adoption: ConversationDraftAdoption) => void) {
  const handle = (event: Event) => {
    const detail = (event as CustomEvent<ConversationDraftAdoption>).detail;
    if (detail?.sessionId) listener(detail);
  };
  window.addEventListener(adopted, handle);
  return () => window.removeEventListener(adopted, handle);
}
