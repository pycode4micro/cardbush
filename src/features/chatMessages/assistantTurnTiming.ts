import type { ChatMessage } from '../../types';

const assistantTurnTimingStorageKey = 'cardbush.assistant_turn_timing.v1';
const assistantTurnTimingLimit = 1000;

type AssistantTurnTiming = {
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  updatedAt: number;
};

type AssistantTurnTimingCache = Record<string, AssistantTurnTiming>;

export function hydrateAssistantTurnTiming(messages: ChatMessage[]) {
  if (messages.length === 0) return messages;
  const cache = readAssistantTurnTimingCache();
  const groupKeys = transcriptGroupKeys(messages);
  const groups = new Map<string, ChatMessage[]>();
  messages.forEach((message, index) => {
    const key = groupKeys[index];
    groups.set(key, [...(groups.get(key) ?? []), message]);
  });

  return messages.map((message, index) => {
    if (message.role !== 'assistant') return message;
    const metadata = message.metadata ?? {};
    const group = groups.get(groupKeys[index]) ?? [message];
    const cached = cachedTimingForMessage(cache, message);
    const explicitStartedAt = firstTimestampString([
      metadata.cardbush_turn_started_at,
      metadata.cardbushTurnStartedAt,
      metadata.turn_started_at,
      metadata.turnStartedAt,
      metadata.started_at,
      metadata.startedAt,
    ]);
    const explicitCompletedAt = firstTimestampString([
      metadata.cardbush_turn_completed_at,
      metadata.cardbushTurnCompletedAt,
      metadata.turn_completed_at,
      metadata.turnCompletedAt,
      metadata.completed_at,
      metadata.completedAt,
      metadata.done_at,
      metadata.doneAt,
      metadata.finished_at,
      metadata.finishedAt,
    ]);
    const derivedStartedAt = earliestMessageTimestamp(group);
    const derivedCompletedAt = latestAssistantTimestamp(group);
    const startedAt = explicitStartedAt ?? cached?.startedAt ?? derivedStartedAt;
    const completedAt = explicitCompletedAt ?? cached?.completedAt ?? derivedCompletedAt;
    const explicitDurationMs = timingDurationMs(metadata);
    const durationMs =
      explicitDurationMs ??
      cached?.durationMs ??
      durationBetween(startedAt, completedAt) ??
      summedToolDuration(message);
    if (startedAt == null && completedAt == null && durationMs == null) {
      return message;
    }
    return {
      ...message,
      metadata: {
        ...metadata,
        ...(startedAt ? { cardbush_turn_started_at: startedAt } : {}),
        ...(completedAt ? { cardbush_turn_completed_at: completedAt } : {}),
        ...(durationMs != null ? { cardbush_turn_duration_ms: durationMs } : {}),
        ...(!explicitStartedAt && !explicitCompletedAt && !cached
          ? { cardbush_turn_timing_source: 'derived_from_transcript' }
          : {}),
      },
    };
  });
}

export function persistAssistantTurnTiming(
  messagesByConversation: Record<string, ChatMessage[]>,
) {
  const cache = readAssistantTurnTimingCache();
  let changed = false;
  for (const [conversationId, messages] of Object.entries(messagesByConversation)) {
    for (const message of messages) {
      if (message.role !== 'assistant' || !message.turnId?.trim()) continue;
      const metadata = message.metadata ?? {};
      const startedAt = firstTimestampString([
        metadata.cardbush_turn_started_at,
        metadata.cardbushTurnStartedAt,
        metadata.turn_started_at,
        metadata.turnStartedAt,
        metadata.started_at,
        metadata.startedAt,
      ]);
      const completedAt = firstTimestampString([
        metadata.cardbush_turn_completed_at,
        metadata.cardbushTurnCompletedAt,
        metadata.turn_completed_at,
        metadata.turnCompletedAt,
        metadata.completed_at,
        metadata.completedAt,
        metadata.done_at,
        metadata.doneAt,
        metadata.finished_at,
        metadata.finishedAt,
      ]);
      const durationMs = timingDurationMs(metadata) ?? durationBetween(startedAt, completedAt);
      if (!startedAt && !completedAt && durationMs == null) continue;
      const entry: AssistantTurnTiming = {
        ...(startedAt ? { startedAt } : {}),
        ...(completedAt ? { completedAt } : {}),
        ...(durationMs != null ? { durationMs } : {}),
        updatedAt: Date.now(),
      };
      cache[timingKey(conversationId || message.conversationId, message.turnId)] = entry;
      cache[timingKey('', message.turnId)] = entry;
      changed = true;
    }
  }
  if (!changed) return;
  writeAssistantTurnTimingCache(trimTimingCache(cache));
}

export function assistantTurnTimingFingerprint(
  messagesByConversation: Record<string, ChatMessage[]>,
) {
  const parts: string[] = [];
  for (const [conversationId, messages] of Object.entries(messagesByConversation)) {
    for (const message of messages) {
      if (message.role !== 'assistant' || !message.turnId?.trim()) continue;
      const metadata = message.metadata ?? {};
      const startedAt = firstTimestampString([
        metadata.cardbush_turn_started_at,
        metadata.turn_started_at,
        metadata.started_at,
      ]);
      const completedAt = firstTimestampString([
        metadata.cardbush_turn_completed_at,
        metadata.turn_completed_at,
        metadata.completed_at,
        metadata.done_at,
        metadata.finished_at,
      ]);
      const durationMs = timingDurationMs(metadata);
      if (startedAt || completedAt || durationMs != null) {
        parts.push(
          `${conversationId}:${message.turnId}:${startedAt ?? ''}:${completedAt ?? ''}:${durationMs ?? ''}`,
        );
      }
    }
  }
  return parts.sort().join('|');
}

function transcriptGroupKeys(messages: ChatMessage[]) {
  let fallbackGroup = 'conversation:0';
  let fallbackIndex = 0;
  return messages.map((message) => {
    if (message.turnId?.trim()) {
      return `turn:${message.turnId.trim()}`;
    }
    if (message.role === 'user') {
      fallbackIndex += 1;
      fallbackGroup = `conversation:${fallbackIndex}`;
    }
    return fallbackGroup;
  });
}

function earliestMessageTimestamp(messages: ChatMessage[]) {
  const timestamps = messages
    .map((message) => timestampValue(message.createdAt))
    .filter((value): value is number => value != null);
  if (timestamps.length < 2 && !messages.some((message) => message.role === 'user')) {
    return undefined;
  }
  return timestamps.length > 0 ? new Date(Math.min(...timestamps)).toISOString() : undefined;
}

function latestAssistantTimestamp(messages: ChatMessage[]) {
  const timestamps = messages
    .filter((message) => message.role === 'assistant')
    .flatMap((message) => [
      timestampValue(message.createdAt),
      ...(message.toolExecutions ?? []).map((execution) => {
        const startedAt = timestampValue(execution.createdAt);
        return startedAt == null ? undefined : startedAt + Math.max(0, execution.durationMs);
      }),
    ])
    .filter((value): value is number => value != null);
  return timestamps.length > 0 ? new Date(Math.max(...timestamps)).toISOString() : undefined;
}

function summedToolDuration(message: ChatMessage) {
  const total = (message.toolExecutions ?? []).reduce(
    (sum, execution) => sum + Math.max(0, execution.durationMs),
    0,
  );
  return total > 0 ? total : undefined;
}

function timingDurationMs(metadata: Record<string, unknown>) {
  for (const value of [
    metadata.cardbush_turn_duration_ms,
    metadata.cardbushTurnDurationMs,
    metadata.turn_duration_ms,
    metadata.turnDurationMs,
    metadata.duration_ms,
    metadata.durationMs,
    metadata.elapsed_ms,
    metadata.elapsedMs,
  ]) {
    const duration = Number(value);
    if (Number.isFinite(duration) && duration >= 0) return duration;
  }
  return undefined;
}

function durationBetween(startedAt?: string, completedAt?: string) {
  const started = timestampValue(startedAt);
  const completed = timestampValue(completedAt);
  return started != null && completed != null && completed >= started
    ? completed - started
    : undefined;
}

function firstTimestampString(values: unknown[]) {
  for (const value of values) {
    if (timestampValue(value) != null) return String(value);
  }
  return undefined;
}

function timestampValue(value: unknown) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function cachedTimingForMessage(cache: AssistantTurnTimingCache, message: ChatMessage) {
  const turnId = message.turnId?.trim();
  if (!turnId) return undefined;
  return (
    cache[timingKey(message.conversationId, turnId)] ??
    cache[timingKey('', turnId)]
  );
}

function timingKey(conversationId: string | undefined, turnId: string) {
  return `${conversationId?.trim() || '*'}::${turnId.trim()}`;
}

function readAssistantTurnTimingCache(): AssistantTurnTimingCache {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return {};
    const decoded = JSON.parse(storage.getItem(assistantTurnTimingStorageKey) ?? '{}');
    return decoded && typeof decoded === 'object' && !Array.isArray(decoded)
      ? decoded as AssistantTurnTimingCache
      : {};
  } catch {
    return {};
  }
}

function writeAssistantTurnTimingCache(cache: AssistantTurnTimingCache) {
  try {
    globalThis.localStorage?.setItem(
      assistantTurnTimingStorageKey,
      JSON.stringify(cache),
    );
  } catch {
    // Timing persistence is a visual fallback; history rendering must continue.
  }
}

function trimTimingCache(cache: AssistantTurnTimingCache) {
  return Object.fromEntries(
    Object.entries(cache)
      .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
      .slice(0, assistantTurnTimingLimit),
  );
}

