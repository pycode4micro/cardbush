import { useSyncExternalStore } from 'react';
import { validFriendAppearance, type FriendAppearance } from './friendDesign';

export const friendsStorageKey = 'cardbush_your_friends_v1';
export const friendsDraftKey = 'cardbush_your_friends_draft_v1';
export const introductionSteps = ['address', 'context', 'judgment', 'communication', 'boundaries', 'appearance'] as const;
export type IntroductionStep = typeof introductionSteps[number];
export type FriendEvent = {
  id: string; text: string; createdAt: string; kind: 'introduction' | 'message';
  step?: IntroductionStep; relatesTo?: string; archived: boolean;
};
export type FriendsState = {
  version: 2;
  id: 'primary-friend';
  name: string;
  startup: boolean;
  motion: boolean;
  tone: 'lilac' | 'peach' | 'sage';
  appearance?: FriendAppearance;
  introduction: { step: number; answers: Partial<Record<IntroductionStep, string>>; confirmedAt?: string };
  // These are interview drafts, never runtime permission grants.
  delegation: { beforeExecution: 'ask' | 'within-scope'; report: 'always' | 'important'; confirmedAt?: string };
  events: FriendEvent[];
};

const defaults = (): FriendsState => ({ version: 2, id: 'primary-friend', name: '', startup: false, motion: true,
  tone: 'lilac', introduction: { step: 0, answers: {} }, delegation: { beforeExecution: 'ask', report: 'always' }, events: [] });
let cachedRaw: string | null | undefined;
let cached = defaults();
let unreadable = false;
const listeners = new Set<() => void>();

function validState(value: unknown): value is FriendsState {
  if (!value || typeof value !== 'object') return false;
  const state = value as FriendsState;
  return state.version === 2 && state.id === 'primary-friend' && typeof state.name === 'string' && state.name.length <= 60 &&
    typeof state.startup === 'boolean' && typeof state.motion === 'boolean' && ['lilac', 'peach', 'sage'].includes(state.tone) &&
    validFriendAppearance(state.appearance) &&
    Boolean(state.introduction && Number.isInteger(state.introduction.step) && state.introduction.step >= 0 && state.introduction.step <= introductionSteps.length &&
      state.introduction.answers && typeof state.introduction.answers === 'object' &&
      Object.entries(state.introduction.answers).every(([key, answer]) => introductionSteps.includes(key as IntroductionStep) && typeof answer === 'string' && answer.length <= 8000) &&
      (!state.introduction.confirmedAt || typeof state.introduction.confirmedAt === 'string')) &&
    Boolean(state.delegation && ['ask', 'within-scope'].includes(state.delegation.beforeExecution) && ['always', 'important'].includes(state.delegation.report) &&
      (!state.delegation.confirmedAt || typeof state.delegation.confirmedAt === 'string')) &&
    Array.isArray(state.events) && state.events.every(event => event && typeof event.id === 'string' && typeof event.text === 'string' && event.text.length <= 8000 &&
      typeof event.createdAt === 'string' && Number.isFinite(Date.parse(event.createdAt)) && ['introduction', 'message'].includes(event.kind) &&
      typeof event.archived === 'boolean' && (!event.step || introductionSteps.includes(event.step)) && (!event.relatesTo || typeof event.relatesTo === 'string'));
}

function migrateState(value: unknown): unknown {
  if (!value || typeof value !== 'object' || (value as { version?: unknown }).version !== 1) return value;
  // Read-only migration: persist only on the next successful user edit.
  return { ...value, version: 2 };
}

export function readFriendsState(): FriendsState {
  try {
    const raw = localStorage.getItem(friendsStorageKey);
    if (cachedRaw !== raw || unreadable) {
      const parsed: unknown = raw ? migrateState(JSON.parse(raw)) : defaults();
      unreadable = !validState(parsed);
      if (!unreadable) { cachedRaw = raw; cached = parsed as FriendsState; }
    }
  } catch { unreadable = true; }
  return cached;
}

export function updateFriendsState(update: (current: FriendsState) => FriendsState) {
  const current = readFriendsState();
  if (unreadable) throw Error('FRIENDS_STORAGE_UNREADABLE');
  const next = update(current);
  if (!validState(next)) throw Error('FRIENDS_STATE_INVALID');
  const raw = JSON.stringify(next);
  // Publish only after the synchronous write succeeds; failed saves retain the input.
  localStorage.setItem(friendsStorageKey, raw);
  cachedRaw = raw; cached = next;
  listeners.forEach(listener => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const storage = (event: StorageEvent) => { if (!event.key || event.key === friendsStorageKey) { readFriendsState(); listener(); } };
  window.addEventListener('storage', storage);
  return () => { listeners.delete(listener); window.removeEventListener('storage', storage); };
}
export const useFriendsState = () => useSyncExternalStore(subscribe, readFriendsState);
export function friendsStartupEnabled() { return readFriendsState().startup; }
type DraftScope = IntroductionStep | 'event' | 'review';
const draftKey = (scope: DraftScope) => scope === 'event' ? friendsDraftKey : `${friendsDraftKey}:${scope}`;
export function readFriendsDraft(scope: DraftScope = 'event') { try { return localStorage.getItem(draftKey(scope)); } catch { return null; } }
export function saveFriendsDraft(value: string | null, scope: DraftScope = 'event') {
  if (value === null) localStorage.removeItem(draftKey(scope)); else localStorage.setItem(draftKey(scope), value);
}

export function recordFriendEvent(text: string, step?: IntroductionStep, relatesTo?: string): FriendEvent {
  const event: FriendEvent = { id: crypto.randomUUID(), text, createdAt: new Date().toISOString(), kind: step ? 'introduction' : 'message', archived: false,
    ...(step ? { step } : {}), ...(relatesTo ? { relatesTo } : {}) };
  if (!event.text.trim() || event.text.length > 8000) throw Error('FRIENDS_INPUT_INVALID');
  updateFriendsState(current => {
    if (relatesTo && !current.events.some(item => item.id === relatesTo)) throw Error('FRIENDS_EVENT_NOT_FOUND');
    return { ...current, events: [...current.events, event], ...(step ? {
      introduction: { step: Math.min(introductionSteps.length, introductionSteps.indexOf(step) + 1), answers: { ...current.introduction.answers, [step]: event.text } },
    } : {}) };
  });
  return event;
}

export function confirmFriendIntroduction() {
  updateFriendsState(current => {
    if (!current.introduction.answers.context?.trim()) throw Error('FRIENDS_CONTEXT_REQUIRED');
    if (!current.appearance) throw Error('FRIENDS_APPEARANCE_REQUIRED');
    const confirmedAt = new Date().toISOString();
    return { ...current, introduction: { ...current.introduction, confirmedAt }, delegation: { ...current.delegation, confirmedAt } };
  });
}

export function circleGeometry(bounds: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>, origin: { x: number; y: number }) {
  const x = origin.x - bounds.left, y = origin.y - bounds.top;
  return { x, y, radius: Math.hypot(Math.max(Math.abs(x), Math.abs(bounds.width - x)), Math.max(Math.abs(y), Math.abs(bounds.height - y))) };
}
