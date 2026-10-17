export const sessionAttentionIntentTtlMs = 10 * 60 * 1000;
export const sessionAttentionIntentLimit = 20;
export const sessionAttentionDuplicateWindowMs = 2_000;
const activationPrefix = 'cardbush-attention-v1:';

type AttentionIdentity = {
  sessionId: string;
  kind: string;
  turnId?: string;
  interactionId?: string;
};

/** Delivery is independent of unread badges, which disappear when a result is read. */
export class SessionAttentionNotificationGate {
  readonly #seen = new Map<string, number>();

  #key(event: AttentionIdentity) {
    return JSON.stringify([event.sessionId, event.kind, event.turnId ?? '', event.interactionId ?? '']);
  }

  accept(event: AttentionIdentity, now = Date.now()): boolean {
    for (const [key, expires] of this.#seen) if (expires <= now) this.#seen.delete(key);
    const key = this.#key(event);
    if (this.#seen.has(key)) return false;
    this.#seen.set(key, event.turnId || event.interactionId ? Infinity : now + sessionAttentionDuplicateWindowMs);
    if (this.#seen.size > 512) this.#seen.delete(this.#seen.keys().next().value!);
    return true;
  }

  forget(event: AttentionIdentity) {
    this.#seen.delete(this.#key(event));
  }
}

export type SessionAttentionOpenIntent = {
  sessionId: string;
  queuedAt: number;
};

export class SessionAttentionOpenQueue {
  readonly #items: SessionAttentionOpenIntent[] = [];
  readonly #recentlyQueued = new Map<string, number>();

  enqueue(sessionId: string, now = Date.now()): boolean {
    const normalized = sessionId.trim();
    if (!normalized) return false;
    this.#purge(now);
    const lastQueuedAt = this.#recentlyQueued.get(normalized);
    if (
      lastQueuedAt != null &&
      now - lastQueuedAt <= sessionAttentionDuplicateWindowMs
    ) return false;
    this.#recentlyQueued.set(normalized, now);
    const existing = this.#items.findIndex((item) => item.sessionId === normalized);
    if (existing >= 0) this.#items.splice(existing, 1);
    this.#items.push({ sessionId: normalized, queuedAt: now });
    if (this.#items.length > sessionAttentionIntentLimit) {
      this.#items.splice(0, this.#items.length - sessionAttentionIntentLimit);
    }
    return true;
  }

  consume(now = Date.now()): SessionAttentionOpenIntent | null {
    this.#purge(now);
    return this.#items.shift() ?? null;
  }

  get size(): number {
    return this.#items.length;
  }

  #purge(now: number) {
    while (
      this.#items.length > 0 &&
      now - this.#items[0]!.queuedAt > sessionAttentionIntentTtlMs
    ) {
      this.#items.shift();
    }
    for (const [sessionId, queuedAt] of this.#recentlyQueued) {
      if (now - queuedAt > sessionAttentionDuplicateWindowMs) {
        this.#recentlyQueued.delete(sessionId);
      }
    }
  }
}

export function encodeSessionAttentionActivation(sessionId: string): string {
  const normalized = sessionId.trim();
  return normalized ? `${activationPrefix}${encodeURIComponent(normalized)}` : '';
}

export function decodeSessionAttentionActivation(value: string): string {
  const normalized = value.trim();
  if (!normalized.startsWith(activationPrefix)) return '';
  try {
    return decodeURIComponent(normalized.slice(activationPrefix.length)).trim();
  } catch {
    return '';
  }
}
