import { fetchMessages, fetchSessionTokenUsage } from '../../backend/api';
import type { ChatMessage, ConversationSummary, SessionTokenUsage } from '../../types';

export interface UsageActivityDay {
  date: string;
  interactions: number;
}

export interface CumulativeUsageStatistics {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
  conversationCount: number;
  activeDays: number;
  longestStreak: number;
  activity: UsageActivityDay[];
  failedSessionCount: number;
}

interface SessionUsageSnapshot {
  conversation: ConversationSummary;
  usage?: SessionTokenUsage;
  messages: ChatMessage[];
  failed: boolean;
}

const requestConcurrency = 4;

export async function loadCumulativeUsageStatistics(
  conversations: ConversationSummary[],
): Promise<CumulativeUsageStatistics> {
  const uniqueConversations = [...new Map(
    conversations
      .filter((conversation) => conversation.id.trim())
      .map((conversation) => [conversation.id, conversation]),
  ).values()];
  const snapshots = await mapWithConcurrency(
    uniqueConversations,
    requestConcurrency,
    async (conversation): Promise<SessionUsageSnapshot> => {
      const [usageResult, messagesResult] = await Promise.allSettled([
        fetchSessionTokenUsage(conversation.id),
        fetchMessages(conversation.id, { includeSuperseded: false }),
      ]);
      return {
        conversation,
        usage: usageResult.status === 'fulfilled' ? usageResult.value : undefined,
        messages: messagesResult.status === 'fulfilled' ? messagesResult.value : [],
        failed: usageResult.status === 'rejected' || messagesResult.status === 'rejected',
      };
    },
  );
  return aggregateCumulativeUsageStatistics(snapshots);
}

export function aggregateCumulativeUsageStatistics(
  snapshots: SessionUsageSnapshot[],
): CumulativeUsageStatistics {
  const activityByDate = new Map<string, number>();
  let promptTokens = 0;
  let completionTokens = 0;
  let promptCacheHitTokens = 0;
  let promptCacheMissTokens = 0;
  let failedSessionCount = 0;

  for (const snapshot of snapshots) {
    if (snapshot.failed) failedSessionCount += 1;
    if (snapshot.usage) {
      promptTokens += snapshot.usage.promptTokens;
      completionTokens += snapshot.usage.completionTokens;
      promptCacheHitTokens += snapshot.usage.promptCacheHitTokens;
      promptCacheMissTokens += snapshot.usage.promptCacheMissTokens;
    }

    const interactionDates = snapshot.messages
      .filter((message) => message.role === 'user')
      .map((message) => localDateKey(message.createdAt))
      .filter((date): date is string => Boolean(date));
    if (interactionDates.length === 0) {
      const fallbackDate = localDateKey(snapshot.conversation.updatedAt);
      if (fallbackDate) interactionDates.push(fallbackDate);
    }
    for (const date of interactionDates) {
      activityByDate.set(date, (activityByDate.get(date) ?? 0) + 1);
    }
  }

  const activity = [...activityByDate]
    .map(([date, interactions]) => ({ date, interactions }))
    .sort((left, right) => left.date.localeCompare(right.date));
  const activeDateKeys = activity.map((day) => day.date);
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    promptCacheHitTokens,
    promptCacheMissTokens,
    conversationCount: snapshots.length,
    activeDays: activeDateKeys.length,
    longestStreak: longestDateStreak(activeDateKeys),
    activity,
    failedSessionCount,
  };
}

function localDateKey(value: string | undefined) {
  const parsed = new Date(value ?? '');
  if (!Number.isFinite(parsed.getTime())) return '';
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, '0');
  const day = String(parsed.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function longestDateStreak(dateKeys: string[]) {
  let longest = 0;
  let current = 0;
  let previousDay = Number.NaN;
  for (const dateKey of dateKeys) {
    const currentDay = Date.parse(`${dateKey}T00:00:00Z`);
    if (!Number.isFinite(currentDay)) continue;
    current = currentDay - previousDay === 86_400_000 ? current + 1 : 1;
    longest = Math.max(longest, current);
    previousDay = currentDay;
  }
  return longest;
}

async function mapWithConcurrency<Input, Output>(
  items: Input[],
  concurrency: number,
  mapper: (item: Input) => Promise<Output>,
) {
  const results = new Array<Output>(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await mapper(items[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}
