import {
  normalizeConversationStyle,
  type ConversationStyleSettings,
} from '@cardbush/bush-product-agent';

const conversationStyleStorageKey = 'cardbush_conversation_style';

export function readConversationStyle(): ConversationStyleSettings {
  try {
    return normalizeConversationStyle(JSON.parse(window.localStorage.getItem(conversationStyleStorageKey) ?? 'null'));
  } catch {
    return normalizeConversationStyle(undefined);
  }
}

export function saveConversationStyle(settings: ConversationStyleSettings): void {
  window.localStorage.setItem(conversationStyleStorageKey, JSON.stringify(normalizeConversationStyle(settings)));
}
