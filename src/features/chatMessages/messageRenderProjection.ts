import type { ChatMessage } from '../../types';

/**
 * ChatMessage also carries protocol rows that exist for model/tool history but
 * have no visual representation. Keep those facts in Runtime while preventing
 * them from creating empty React rows or running MessageBubble preparation.
 */
export function isRenderableChatMessage(message: ChatMessage) {
  return message.role === 'user' || message.role === 'assistant';
}

export function projectRenderableChatMessages(messages: ChatMessage[]) {
  let firstHiddenIndex = -1;
  for (let index = 0; index < messages.length; index += 1) {
    if (!isRenderableChatMessage(messages[index])) {
      firstHiddenIndex = index;
      break;
    }
  }
  if (firstHiddenIndex < 0) {
    return messages;
  }
  return [
    ...messages.slice(0, firstHiddenIndex),
    ...messages.slice(firstHiddenIndex + 1).filter(isRenderableChatMessage),
  ];
}
