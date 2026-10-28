import { uiLanguages, uiText } from './index';

const defaultTitleKeys = ['conversationSearchDialog.newChat', 'composer.newConversation', 'agentsView.newConversation'] as const;

/** A translated default title is still untitled; user-authored titles stay verbatim. */
export function isDefaultConversationTitle(title: string) {
  return uiLanguages.some(locale => defaultTitleKeys.some(key => uiText(locale.locale)(key) === title));
}
