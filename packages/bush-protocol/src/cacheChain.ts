import { z } from "zod";

export const BUSH_CACHE_CHAIN_STATE_PROTOCOL =
  "bush.cache_chain_state.v1" as const;

const cacheRoutingSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('provider_default') }),
  z.object({ mode: z.literal('session'), keyDigest: z.string().min(1) }),
]);

export const providerInputProjectionSchema = z.object({
  format: z.string().min(1),
  inputDigests: z.array(z.string().min(1)),
  parameterDigests: z.record(z.string(), z.string().min(1)),
  transport: z.enum(["full", "continuation"]),
  // Diagnostic only: no image bytes, URLs, session keys or prompt content.
  images: z.object({ digests: z.array(z.string().min(1)), remoteCount: z.number().int().nonnegative() }).optional(),
  cacheRouting: cacheRoutingSchema.optional(),
  // Local estimate of this full projection, never a provider usage fact.
  tokenEstimate: z.object({
    method: z.string().min(1),
    tokens: z.number().int().nonnegative(),
    // Provider-declared input shape; execution-only parameters can change
    // without invalidating an otherwise identical token-count basis.
    inputParametersDigest: z.string().min(1).optional(),
  }).optional(),
});
export type ProviderInputProjection = z.infer<typeof providerInputProjectionSchema>;

export const cacheChainStateSchema = z.object({
  protocol: z.literal(BUSH_CACHE_CHAIN_STATE_PROTOCOL),
  requestOrdinal: z.number().int().nonnegative(),
  stableInputDigest: z.string().min(1).optional(),
  messageDigests: z.array(z.string().min(1)),
  providerInput: providerInputProjectionSchema.optional(),
});

export type CacheChainState = z.infer<typeof cacheChainStateSchema>;

export const cacheChainObservationPayloadSchema = z.object({
  requestOrdinal: z.number().int().positive(),
  messageCount: z.number().int().nonnegative(),
  previousMessageCount: z.number().int().nonnegative(),
  sharedPrefixMessages: z.number().int().nonnegative(),
  appendedMessages: z.number().int().nonnegative(),
  frozenPrefixBreak: z.boolean(),
  breakIndex: z.number().int().nonnegative().optional(),
  // Independent message boundary, even when a parameter change also breaks at 0.
  messageBreakIndex: z.number().int().nonnegative().optional(),
  stableInputDigest: z.string().min(1),
  sharedPrefixDigest: z.string().min(1),
});

export type CacheChainObservationPayload = z.infer<
  typeof cacheChainObservationPayloadSchema
>;

export const providerInputObservationSchema = cacheChainObservationPayloadSchema.extend({
  format: z.string().min(1),
  transport: z.enum(["full", "continuation"]),
  previousProjectionAvailable: z.boolean(),
  changedParameters: z.array(z.string()),
  cacheRouting: cacheRoutingSchema.optional(),
  images: z.object({
    count: z.number().int().nonnegative(),
    remoteCount: z.number().int().nonnegative(),
    comparisonAvailable: z.boolean(),
    previousCount: z.number().int().nonnegative().optional(),
    addedCount: z.number().int().nonnegative().optional(),
    removedCount: z.number().int().nonnegative().optional(),
  }).optional(),
});
export type ProviderInputObservation = z.infer<typeof providerInputObservationSchema>;
