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
  // Optional for checkpoints written before per-parameter diagnostics existed.
  parameterDigests: z.record(z.string(), z.string().min(1)).optional(),
  messageDigests: z.array(z.string().min(1)),
  providerInput: providerInputProjectionSchema.optional(),
});

export type CacheChainState = z.infer<typeof cacheChainStateSchema>;

// Diagnostics for the definitions actually sent to the model. Character counts
// are exact for Runtime JSON; estimates are not provider/billing token counts.
const toolDefinitionUsageSchema = z.object({
  count: z.number().int().nonnegative(),
  chars: z.number().int().nonnegative(),
  descriptionChars: z.number().int().nonnegative(),
  schemaChars: z.number().int().nonnegative(),
  estimatedTokens: z.number().int().nonnegative(),
  estimateMethod: z.literal('runtime-tool-json-chars-v1'),
  builtinCount: z.number().int().nonnegative(),
  builtinChars: z.number().int().nonnegative(),
  largest: z.array(z.object({
    name: z.string().min(1),
    chars: z.number().int().nonnegative(),
    descriptionChars: z.number().int().nonnegative(),
    schemaChars: z.number().int().nonnegative(),
  })).max(5),
});

export const cacheChainObservationPayloadSchema = z.object({
  requestOrdinal: z.number().int().positive(),
  messageCount: z.number().int().nonnegative(),
  previousMessageCount: z.number().int().nonnegative(),
  sharedPrefixMessages: z.number().int().nonnegative(),
  appendedMessages: z.number().int().nonnegative(),
  // New observations compare only the historical message/input-item prefix.
  // Absence of prefixComparisonAvailable identifies legacy combined diagnostics.
  prefixComparisonAvailable: z.boolean().optional(),
  parametersChanged: z.boolean().optional(),
  // Names can be unavailable on the first request restored from a legacy state.
  changedParameters: z.array(z.string()).optional(),
  frozenPrefixBreak: z.boolean(),
  breakIndex: z.number().int().nonnegative().optional(),
  // Compatibility alias for the message boundary, independent of parameters.
  messageBreakIndex: z.number().int().nonnegative().optional(),
  stableInputDigest: z.string().min(1),
  sharedPrefixDigest: z.string().min(1),
  toolDefinitions: toolDefinitionUsageSchema.optional(),
});

export type CacheChainObservationPayload = z.infer<
  typeof cacheChainObservationPayloadSchema
>;

export const providerInputObservationSchema = cacheChainObservationPayloadSchema.extend({
  format: z.string().min(1),
  transport: z.enum(["full", "continuation"]),
  previousProjectionAvailable: z.boolean(),
  projectionFormatChanged: z.boolean().optional(),
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

/** Read both old and new diagnostics without treating the legacy combined flag
 * as a proven message rewrite. Undefined means the comparison is unavailable.
 * None of these fields proves a provider cache hit or miss.
 */
export function cacheChainChanges(observation: CacheChainObservationPayload & { projectionFormatChanged?: boolean }) {
  const projectionFormatChanged = observation.projectionFormatChanged ??
    observation.changedParameters?.includes('projection_format') ?? false;
  let prefixBreak: boolean | undefined;
  if (observation.prefixComparisonAvailable !== undefined) {
    if (observation.prefixComparisonAvailable) prefixBreak = observation.frozenPrefixBreak;
  } else if (!projectionFormatChanged) {
    // Old events already retain independent prefix counts, even if breakIndex
    // was forced to zero by a simultaneous parameter change.
    prefixBreak = observation.sharedPrefixMessages < observation.previousMessageCount;
  }
  const parametersChanged = observation.parametersChanged ?? (observation.changedParameters
    ? observation.changedParameters.some(key => key !== 'projection_format')
    : observation.frozenPrefixBreak ? prefixBreak === false ? true : undefined : false);
  return { prefixBreak, parametersChanged, projectionFormatChanged };
}
