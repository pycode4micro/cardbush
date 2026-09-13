import { randomUUID } from 'node:crypto';
import { modelEventSchema, type ModelRequest } from '@cardbush/bush-protocol';
import type { ModelProvider, ModelStreamOptions } from '@cardbush/bush-runtime';
import type { UsageRecord } from './usageLedger.js';

/** Observe actual usage for main, child, maintenance and retried calls. */
export function usageRecordingProvider(provider: ModelProvider, record: (usage: UsageRecord) => void): ModelProvider {
  return {
    ...(provider.estimateInputTokens ? { estimateInputTokens: (request: ModelRequest, options?: ModelStreamOptions) => provider.estimateInputTokens!(request, options) } : {}),
    ...(provider.countInputTokens ? { countInputTokens: (request: ModelRequest, options?: ModelStreamOptions) => provider.countInputTokens!(request, options) } : {}),
    async *stream(request, options) {
      const id = randomUUID();
      let recordedAt: string | undefined;
      let lastSequence = -1;
      for await (const candidate of provider.stream(request, options)) {
        const parsed = modelEventSchema.safeParse(candidate);
        if (parsed.success && parsed.data.requestId === request.requestId && parsed.data.sequence > lastSequence) {
          const event = parsed.data;
          lastSequence = event.sequence;
          if (event.kind === 'usage') {
            recordedAt ??= new Date().toISOString();
            // Commit before yielding so later cancellation cannot lose reported usage.
            record({ id, sessionId: request.sessionId, model: request.model, recordedAt,
              inputTokens: event.inputTokens, outputTokens: event.outputTokens, cachedInputTokens: event.cachedInputTokens });
          }
        }
        yield candidate;
      }
    },
  };
}
