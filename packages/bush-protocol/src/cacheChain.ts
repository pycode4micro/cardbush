import { z } from "zod";

export const BUSH_CACHE_CHAIN_STATE_PROTOCOL =
  "bush.cache_chain_state.v1" as const;

export const cacheChainStateSchema = z.object({
  protocol: z.literal(BUSH_CACHE_CHAIN_STATE_PROTOCOL),
  requestOrdinal: z.number().int().nonnegative(),
  stableInputDigest: z.string().min(1).optional(),
  messageDigests: z.array(z.string().min(1)),
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
  stableInputDigest: z.string().min(1),
  sharedPrefixDigest: z.string().min(1),
});

export type CacheChainObservationPayload = z.infer<
  typeof cacheChainObservationPayloadSchema
>;
