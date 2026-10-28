import { languagePacks, type MessageKey } from './generatedMessages.js';
import { createMessageCatalog, type MessageVariables } from './catalog.js';

const catalog = createMessageCatalog([...languagePacks]);
export type { MessageKey } from './generatedMessages.js';
export const uiLanguages = catalog.languages;
export const formatMessageList = catalog.list;
export const resolveUiLanguage = catalog.resolve;
/** Localized content supplied by plugins/servers is data, not application copy. */
export function localizedContent<T>(values: Partial<Record<string, T>> | undefined, language: string): T | undefined {
  if (!values) return;
  for (const key of [language, resolveUiLanguage(language), 'en']) {
    if (Object.hasOwn(values, key) && values[key] !== undefined) return values[key];
  }
}
const translators = new Map<string, (key: MessageKey, variables?: MessageVariables) => string>();

export function uiText(language = typeof document === 'undefined' ? 'en' : document.documentElement.lang || 'en') {
  let translate = translators.get(language);
  if (!translate) {
    translate = (key: MessageKey, variables?: MessageVariables) => catalog.text(language, key, variables);
    translators.set(language, translate);
  }
  return translate;
}

export { createMessageCatalog } from './catalog.js';
export type { LanguagePack, Message, MessageVariables } from './catalog.js';
