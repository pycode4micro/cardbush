import { useSyncExternalStore } from 'react';
import type { ManagedModelConfig } from '../../types';
import { defaultModelConfigId } from './modelPreferences';

const changed = 'cardbush:conversation-model-changed';
const key = (sessionId: string, hostId = '') => `cardbush.conversation_model:${JSON.stringify([hostId, sessionId])}`;
const unavailableStorage = new Map<string, string>();

export function readConversationModel(sessionId: string, hostId = ''): string {
  const storageKey = key(sessionId, hostId);
  try { return localStorage.getItem(storageKey)?.trim() ?? ''; }
  catch { return unavailableStorage.get(storageKey) ?? ''; }
}

export function selectConversationModel(modelId: string, sessionId: string, hostId = '') {
  const storageKey = key(sessionId, hostId), value = modelId.trim();
  try {
    if (value) localStorage.setItem(storageKey, value);
    else localStorage.removeItem(storageKey);
  } catch {
    if (value) unavailableStorage.set(storageKey, value);
    else unavailableStorage.delete(storageKey);
  }
  window.dispatchEvent(new Event(changed));
}

export function adoptDraftConversationModel(sessionId: string, fallback: string, hostId = '') {
  if (!readConversationModel(sessionId, hostId)) {
    selectConversationModel(readConversationModel('', hostId) || fallback, sessionId, hostId);
  }
  selectConversationModel('', '', hostId);
}

export function resolveConversationModelId(models: ManagedModelConfig[], sessionId: string, hostId = '', defaultModelId = '') {
  const stored = readConversationModel(sessionId, hostId).toLowerCase();
  return models.find(model => model.id.trim().toLowerCase() === stored)?.id
    ?? defaultModelConfigId(models, defaultModelId);
}

function subscribe(listener: () => void) {
  window.addEventListener(changed, listener);
  window.addEventListener('storage', listener);
  return () => { window.removeEventListener(changed, listener); window.removeEventListener('storage', listener); };
}

export function useConversationModel(sessionId: string, hostId = '') {
  return useSyncExternalStore(subscribe, () => readConversationModel(sessionId, hostId), () => '');
}
