import type { ModelMessage } from '@cardbush/bush-protocol';

/** Only host-authored internal preferences are eligible; human text is untouched. */
export function isConversationPreference(message: ModelMessage): message is Extract<ModelMessage, { role: 'user' }> {
  return message.role === 'user' && message.visibility === 'internal' &&
    message.name === 'conversation_preferences' && !message.images?.length;
}

export function latestConversationPreference(messages: ModelMessage[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (isConversationPreference(message)) return message;
  }
  return undefined;
}
