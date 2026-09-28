import { normalizeConversationStyle, type ConversationStyleSettings } from '@cardbush/bush-product-agent';

export interface NamedConversationStyle { id: string; name: string; instructions: string }
export interface ConversationStylePreferences extends ConversationStyleSettings {
  defaultId: string;
  styles: NamedConversationStyle[];
}
export const conversationStyleStorageKey = 'cardbush_conversation_style';
export const conversationStyleChanged = 'cardbush-conversation-style-changed';
const presetIds = ['natural', 'professional', 'concise'];
const legacyId = 'custom-legacy';
const draftKey = 'cardbush_conversation_style_draft';
export const conversationStylePresets = [
  { id: 'natural', zh: '自然', en: 'Natural' },
  { id: 'professional', zh: '专业', en: 'Professional' },
  { id: 'concise', zh: '直率', en: 'Direct' },
];

/** Keep the transport small: the model receives only the selected tone. */
function selectedStyle(styles: NamedConversationStyle[], id: string): ConversationStyleSettings {
  const custom = styles.find(style => style.id === id);
  return custom ? { mode: 'custom', customTone: custom.instructions } : normalizeConversationStyle({ mode: id });
}

export function normalizeConversationStylePreferences(value: unknown): ConversationStylePreferences {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const old = normalizeConversationStyle(value);
  const seen = new Set(presetIds);
  const styles: NamedConversationStyle[] = [];
  if (Array.isArray(input.styles)) {
    for (const entry of input.styles) {
      if (!entry || typeof entry !== 'object') continue;
      const { id, name, instructions } = entry as Record<string, unknown>;
      if (typeof id !== 'string' || !id.trim() || seen.has(id) || typeof name !== 'string' || (!name.trim() && id !== legacyId) || typeof instructions !== 'string') continue;
      seen.add(id);
      styles.push({ id, name: name.trim(), instructions });
    }
  } else if (old.customTone || old.mode === 'custom') {
    // A stable id makes migration repeatable before the first settings save.
    styles.push({ id: legacyId, name: '', instructions: old.customTone });
  }
  const requested = typeof input.defaultId === 'string' ? input.defaultId : old.mode === 'custom' ? legacyId : old.mode;
  const defaultId = presetIds.includes(requested) || styles.some(style => style.id === requested) ? requested : 'natural';
  return { ...selectedStyle(styles, defaultId), defaultId, styles };
}

export function conversationStyleName(id: string, preferences: ConversationStylePreferences, language: 'zh' | 'en'): string {
  return conversationStylePresets.find(style => style.id === id)?.[language]
    ?? (preferences.styles.find(style => style.id === id)?.name || (language === 'zh' ? '自定义' : 'Custom'));
}

export function readConversationStyle(): ConversationStylePreferences {
  try { return normalizeConversationStylePreferences(JSON.parse(window.localStorage.getItem(conversationStyleStorageKey) ?? 'null')); }
  catch { return normalizeConversationStylePreferences(undefined); }
}

export function saveConversationStyle(settings: ConversationStyleSettings): void {
  window.localStorage.setItem(conversationStyleStorageKey, JSON.stringify(normalizeConversationStylePreferences(settings)));
  window.dispatchEvent(new Event(conversationStyleChanged));
}

function overrideKey(sessionId: string, hostId = '') {
  return 'cardbush_conversation_style_session:' + JSON.stringify([hostId, sessionId]);
}

export function readConversationStyleOverride(sessionId: string, hostId = ''): string | null {
  try { return sessionId ? localStorage.getItem(overrideKey(sessionId, hostId)) : sessionStorage.getItem(draftKey + ':' + hostId); }
  catch { return null; }
}

export function selectConversationStyle(sessionId: string, id: string | null, hostId = ''): void {
  const storage = sessionId ? localStorage : sessionStorage;
  const key = sessionId ? overrideKey(sessionId, hostId) : draftKey + ':' + hostId;
  if (id) storage.setItem(key, id); else storage.removeItem(key);
  window.dispatchEvent(new Event(conversationStyleChanged));
}

export function adoptDraftConversationStyle(sessionId: string): void {
  const id = readConversationStyleOverride('');
  if (id) { selectConversationStyle(sessionId, id); selectConversationStyle('', null); }
}

export function resolveConversationStyleId(preferences: ConversationStylePreferences, override: string | null): string {
  return override && (presetIds.includes(override) || preferences.styles.some(style => style.id === override)) ? override : preferences.defaultId;
}

export function resolveConversationStyle(sessionId: string, hostId = ''): ConversationStyleSettings {
  const preferences = readConversationStyle();
  return selectedStyle(preferences.styles, resolveConversationStyleId(preferences, readConversationStyleOverride(sessionId, hostId)));
}
