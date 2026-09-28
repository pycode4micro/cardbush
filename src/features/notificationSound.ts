import type { SessionAttentionKind } from '../types';

export const notificationSoundStorageKey = 'cardbush_notification_sound_v1';
const changedEvent = 'cardbush:notification-sound-changed';
export type NotificationSoundPreferences = { enabled: boolean; volume: number };
const defaults: NotificationSoundPreferences = { enabled: true, volume: 50 };
let fallback: NotificationSoundPreferences | undefined, storageWriteFailed = false;

export function normalizeNotificationSoundPreferences(value: unknown): NotificationSoundPreferences {
  const input = value && typeof value === 'object' ? value as Partial<NotificationSoundPreferences> : {};
  return { enabled: typeof input.enabled === 'boolean' ? input.enabled : defaults.enabled,
    volume: typeof input.volume === 'number' && Number.isFinite(input.volume)
      ? Math.max(0, Math.min(100, Math.round(input.volume))) : defaults.volume };
}

export function readNotificationSoundPreferences(): NotificationSoundPreferences {
  if (storageWriteFailed && fallback) return fallback;
  try {
    const stored = window.localStorage.getItem(notificationSoundStorageKey);
    return stored === null ? { ...defaults } : normalizeNotificationSoundPreferences(JSON.parse(stored));
  } catch { return fallback ?? { ...defaults }; }
}

export function saveNotificationSoundPreferences(value: NotificationSoundPreferences) {
  fallback = normalizeNotificationSoundPreferences(value);
  try {
    window.localStorage.setItem(notificationSoundStorageKey, JSON.stringify(fallback));
    storageWriteFailed = false;
  } catch { storageWriteFailed = true; }
  if (!fallback.enabled || fallback.volume === 0) stopCurrentSound?.();
  window.dispatchEvent(new Event(changedEvent));
}

export function subscribeNotificationSoundPreferences(listener: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== notificationSoundStorageKey) return;
    fallback = undefined; storageWriteFailed = false;
    const prefs = readNotificationSoundPreferences();
    if (!prefs.enabled || prefs.volume === 0) stopCurrentSound?.();
    listener();
  };
  window.addEventListener(changedEvent, listener);
  window.addEventListener('storage', storage);
  return () => { window.removeEventListener(changedEvent, listener); window.removeEventListener('storage', storage); };
}

type AttentionSoundEvent = { sessionId: string; scope?: string; kind: SessionAttentionKind; turnId?: string; notificationId?: string };

/** Viewing a result must not make its replay audible again. Independent of unread badges. */
export class NotificationSoundGate {
  readonly #seen = new Map<string, number>();
  accept(event: AttentionSoundEvent, now = Date.now()) {
    if (!event.sessionId.trim()) return false;
    for (const [key, expires] of this.#seen) if (expires <= now) this.#seen.delete(key);
    const identity = event.notificationId || event.turnId;
    const key = JSON.stringify([event.scope ?? '', event.sessionId, event.kind, identity ?? '']);
    if (this.#seen.has(key)) return false;
    this.#seen.set(key, identity ? Infinity : now + 1500);
    if (this.#seen.size > 512) this.#seen.delete(this.#seen.keys().next().value!);
    return true;
  }
}

/** A short local two-note chime. Smooth envelopes avoid clicks; gain stays bounded. */
export function scheduleNotificationChime(context: BaseAudioContext, volume: number) {
  const nodes: Array<{ oscillator: OscillatorNode; gain: GainNode }> = [];
  const level = Math.max(0, Math.min(100, volume)) / 100;
  if (!level) return () => {};
  const start = context.currentTime + 0.01;
  for (const [offset, frequency] of [[0, 660], [0.14, 880]]) {
    const oscillator = context.createOscillator(), gain = context.createGain();
    oscillator.type = 'sine'; oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0, start + offset);
    gain.gain.linearRampToValueAtTime(0.16 * level, start + offset + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.24);
    gain.gain.linearRampToValueAtTime(0, start + offset + 0.28);
    oscillator.connect(gain); gain.connect(context.destination);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    oscillator.start(start + offset); oscillator.stop(start + offset + 0.29);
    nodes.push({ oscillator, gain });
  }
  return () => { for (const { oscillator, gain } of nodes) {
    gain.disconnect(); try { oscillator.stop(); } catch { /* Already ended. */ }
  } };
}

let context: AudioContext | undefined;
let stopCurrentSound: (() => void) | undefined;
let lastSoundAt = -Infinity;
const gate = new NotificationSoundGate();

export async function playNotificationSound(preview = false): Promise<boolean> {
  const before = readNotificationSoundPreferences();
  if ((!preview && !before.enabled) || before.volume === 0) return false;
  if (!preview && Date.now() - lastSoundAt < 900) return false;
  try {
    context ??= new AudioContext();
    if (context.state === 'closed') context = new AudioContext();
    if (context.state !== 'running') {
      // Never queue an old sound until the user returns or grants audio access.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const ready = await Promise.race([context.resume().then(() => context?.state === 'running'),
          new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 1500); })]);
        if (!ready) return false;
      } finally { clearTimeout(timer); }
    }
    const current = readNotificationSoundPreferences();
    if ((!preview && !current.enabled) || current.volume === 0) return false;
    if (!preview && Date.now() - lastSoundAt < 900) return false;
    stopCurrentSound?.();
    stopCurrentSound = scheduleNotificationChime(context, current.volume);
    lastSoundAt = Date.now();
    return true;
  } catch { return false; } // Audio device failures must never interrupt a conversation.
}

export function notifyAttentionSound(event: AttentionSoundEvent) {
  if (gate.accept(event)) void playNotificationSound();
}
