import { nextStepPredictionSchema, type NextStepPrediction } from '@cardbush/bush-protocol';
import type { ChatMessage } from '../../types';

/** Only the latest exchange can suggest the next request; never search global memory. */
export function latestNextStepPrediction(messages: ChatMessage[], sessionId: string, now = Date.now()): NextStepPrediction | undefined {
  if (!sessionId) return;
  let turnId: string | undefined;
  for (let outer = messages.length - 1; outer >= 0; outer--) {
    const segments = [...(messages[outer].loopHistory ?? []), messages[outer]];
    for (let index = segments.length - 1; index >= 0; index--) {
      const message = segments[index];
      if (message.conversationId && message.conversationId !== sessionId || message.metadata?.__bush_superseded || message.metadata?.visibility === 'internal') continue;
      if (message.role === 'user') return;
      if (message.role !== 'assistant') continue;
      if (['failed', 'cancelled', 'stopped'].includes(message.status ?? String(message.metadata?.status ?? ''))) return;
      if (turnId && message.turnId && message.turnId !== turnId) return;
      turnId ??= message.turnId;
      const summary = [...(message.toolExecutions ?? [])].reverse().find(tool => tool.name === 'summary_for_user' && (!turnId || !tool.turnId || tool.turnId === turnId));
      if (!summary) continue;
      if (summary.state !== 'completed' || !summary.success) return;
      const parsed = nextStepPredictionSchema.safeParse(summary.metadata.nextStepPrediction);
      return parsed.success && parsed.data.expiresAt > now ? { ...parsed.data, id: `${turnId ?? message.id}:${parsed.data.id}` } : undefined;
    }
  }
}
