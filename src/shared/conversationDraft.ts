type ConversationIdentity = { sessionId: string; connectionId?: string };
export type ConversationDraftAdoption = ConversationIdentity;
const adopted = 'cardbush:conversation-draft-adopted';
const removed = 'cardbush:conversation-deleted';

export function notifyConversationDeleted(sessionId: string, connectionId?: string) {
  window.dispatchEvent(new CustomEvent<ConversationIdentity>(removed, { detail: { sessionId, connectionId } }));
}

function subscribe(eventName: string, listener: (conversation: ConversationIdentity) => void) {
  const handle = (event: Event) => {
    const detail = (event as CustomEvent<ConversationIdentity>).detail;
    if (detail?.sessionId) listener(detail);
  };
  window.addEventListener(eventName, handle);
  return () => window.removeEventListener(eventName, handle);
}
export function onConversationDeleted(listener: (conversation: ConversationIdentity) => void) {
  return subscribe(removed, listener);
}

/** Emitted before selecting a newly prepared session, never for ordinary navigation. */
export function adoptConversationDraft(sessionId: string, connectionId?: string) {
  window.dispatchEvent(new CustomEvent<ConversationDraftAdoption>(adopted, { detail: { sessionId, connectionId } }));
}

export function onConversationDraftAdopted(listener: (adoption: ConversationDraftAdoption) => void) {
  return subscribe(adopted, listener);
}
