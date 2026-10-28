import { uiText } from '../../i18n';
import { localConversationBackend, type ConversationBackend } from '../../backend/conversationBackend';
import { conversationRuntime } from '../../backend/conversationRuntime';
import { runtimeConversation } from '../../backend/api';
import type { ConversationSummary } from '../../types';

export type CreationConversationPreparation = {
  title: string; projectDir?: string; metadata: Record<string, unknown>;
  onCreated?: (conversation: ConversationSummary) => void;
};

/** A document conversation must not load unrelated conversations or their journals. */
export function creationConversationBackend(sessionId: string, scope = 'creation', preparation?: CreationConversationPreparation): ConversationBackend {
  let persisted = !preparation;
  const read = async () => {
    const runtime = conversationRuntime();
    try { const snapshot = await runtime.client.getSession(sessionId); return snapshot ? runtimeConversation(snapshot) : undefined; }
    finally { runtime.dispose(); }
  };
  return {
    ...localConversationBackend,
    scope,
    keepRunningOnUnmount: true,
    async createConversation(input) {
      let conversation: ConversationSummary;
      try { conversation = await localConversationBackend.createConversation({ ...input, metadata: { ...input?.metadata, ...preparation?.metadata, conversation_started: true } }); }
      catch (error) {
        // A response may be lost after creation. Reuse this exact ID on retry.
        const existing = await read().catch(() => undefined);
        if (!existing) throw error;
        conversation = existing;
      }
      persisted = true;
      preparation?.onCreated?.(conversation);
      return conversation;
    },
    async fetchConversations() {
      if (!persisted) return [];
      const conversation = await read();
      if (!conversation) throw Error(uiText()('creationConversationBackend.conversation_no_longer_exists'));
      return [conversation];
    },
  };
}
