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
    try { profile = assistantProfileSchema.parse(JSON.parse(localStorage.getItem(key) ?? '{}')); }
    catch { profile = assistantProfileSchema.parse({}); }
  }
  return profile;
}
export function saveAssistantProfile(input: AssistantProfile) {
  const next = assistantProfileSchema.parse(input);
  localStorage.setItem(key, JSON.stringify(next)); profile = next;
  listeners.forEach(listener => listener());
}
export const useAssistantProfile = () => useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, readAssistantProfile);
