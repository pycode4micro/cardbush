import { localConversationBackend, type ConversationBackend } from '../../backend/conversationBackend';
import { conversationRuntime } from '../../backend/conversationRuntime';
import { runtimeConversation } from '../../backend/api';

/** A document conversation must not load unrelated conversations or their journals. */
export function creationConversationBackend(sessionId: string): ConversationBackend {
  return {
    ...localConversationBackend,
    scope: 'creation',
    keepRunningOnUnmount: true,
    async fetchConversations() {
      const runtime = conversationRuntime();
      try {
        const snapshot = await runtime.client.getSession(sessionId);
        if (!snapshot) throw Error('创作会话不存在，请重新创建对话。 / Writing conversation no longer exists.');
        return [runtimeConversation(snapshot)];
      } finally { runtime.dispose(); }
    },
  };
}
