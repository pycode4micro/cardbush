import { inheritedPreferences } from './events/eventPreferences';
import { useSyncExternalStore } from 'react';
import { assistantProfileSchema, type AssistantProfile } from '@cardbush/bush-protocol';

const key = 'cardbush_personal_assistant_v1';
const listeners = new Set<() => void>();
let working = false;
export function setAssistantWorking(value: boolean) { if (working === value) return; working = value; listeners.forEach(listener => listener()); }
export const useAssistantWorking = () => useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => working);
let profile: AssistantProfile;
export function readAssistantProfile(): AssistantProfile {
  if (!profile) {
    try {
      const saved = JSON.parse(localStorage.getItem(key) ?? '{}');
      const inherited = !saved.proactive ? inheritedPreferences() : undefined;
      profile = assistantProfileSchema.parse({ ...saved, ...(inherited ? { proactive: inherited } : {}), targetAgent: '' });
      if (inherited) { try { localStorage.setItem(key, JSON.stringify(profile)); } catch { /* Retry migration on the next launch. */ } }
    }
    catch { profile = assistantProfileSchema.parse({}); }
  }
  return profile;
}
export function saveAssistantProfile(input: AssistantProfile) {
  const next = assistantProfileSchema.parse({ ...input, targetAgent: '' });
  localStorage.setItem(key, JSON.stringify(next)); profile = next;
  listeners.forEach(listener => listener());
}
export const useAssistantProfile = () => useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, readAssistantProfile);
