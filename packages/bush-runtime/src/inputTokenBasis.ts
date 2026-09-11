import { createHash } from 'node:crypto';
import { modelRequestSchema, type ModelRequest, type ProviderInputProjection, type SessionUsage } from '@cardbush/bush-protocol';

type InputBasis = NonNullable<SessionUsage['lastRequestInputBasis']>;
export type InputTokenUsage = Pick<SessionUsage, 'lastRequestInputTokens' | 'lastRequestInputBasis'>;

export interface InputTokenCalibration {
  inputTokens: number;
  prefixInputTokens: number;
  suffixEstimateTokens: number;
  suffixScale: number;
  safetyTokens: number;
}

/** Usage is valid as an input floor only for extensions of the measured
 * context. A compaction, edit, provider switch or prefix update ends that basis.
 */
export function inputTokenBasis(candidate: ModelRequest, messageCount?: number): InputBasis {
  const request = modelRequestSchema.parse(candidate);
  const count = messageCount ?? request.messages.length;
  const inputShape = { model: request.model, providerBinding: request.providerBinding,
    tools: request.tools, reasoningEffort: request.reasoningEffort,
    requestCapabilities: request.requestCapabilities, temperature: request.temperature, topP: request.topP };
  return {
    requestShapeDigest: hash({ model: request.model, providerBinding: request.providerBinding,
      tools: request.tools, reasoningEffort: request.reasoningEffort,
      requestCapabilities: request.requestCapabilities, maxOutputTokens: request.maxOutputTokens,
      temperature: request.temperature, topP: request.topP }),
    inputShapeDigest: hash(inputShape),
    messageCount: count,
    messagePrefixDigest: hash(request.messages.slice(0, count)),
  };
}

export function reusableInputTokenFloor(usage: InputTokenUsage | undefined,
  request: ModelRequest, projection?: ProviderInputProjection): number | undefined {
  const basis = usage?.lastRequestInputBasis;
  if (!basis || !Number.isInteger(usage.lastRequestInputTokens) || Number(usage.lastRequestInputTokens) < 0 ||
    basis.messageCount > request.messages.length) return undefined;
  if (basis.projection && (!projection || !extendsCountedInputProjection(basis.projection, projection))) return undefined;
  const current = inputTokenBasis(request, basis.messageCount);
  const sameShape = basis.inputShapeDigest
    ? current.inputShapeDigest === basis.inputShapeDigest : current.requestShapeDigest === basis.requestShapeDigest;
  return sameShape && current.messagePrefixDigest === basis.messagePrefixDigest
    ? usage.lastRequestInputTokens : undefined;
}

function extendsCountedInputProjection(previous: ProviderInputProjection, current: ProviderInputProjection): boolean {
  const before = previous.tokenEstimate?.inputParametersDigest;
  const after = current.tokenEstimate?.inputParametersDigest;
  if (!before || !after) return extendsInputProjection(previous, current);
  return previous.format === current.format && before === after &&
    Object.keys(previous.parameterDigests).length === Object.keys(current.parameterDigests).length &&
    Object.keys(previous.parameterDigests).every(key => key in current.parameterDigests) &&
    previous.inputDigests.length <= current.inputDigests.length &&
    previous.inputDigests.every((digest, index) => current.inputDigests[index] === digest);
}

/** Both wire parameters and the entire measured prefix must still match.
 * Transport IDs do not change the full context, but tool-schema rewrites do.
 */
export function extendsInputProjection(previous: ProviderInputProjection, current: ProviderInputProjection): boolean {
  return previous.format === current.format &&
    Object.keys(previous.parameterDigests).length === Object.keys(current.parameterDigests).length &&
    Object.entries(previous.parameterDigests).every(([key, value]) => current.parameterDigests[key] === value) &&
    previous.inputDigests.length <= current.inputDigests.length &&
    previous.inputDigests.every((digest, index) => current.inputDigests[index] === digest);
}

/** Replace the known prefix estimate with its measured usage. Only the new
 * suffix is estimated, with an upward density correction and 10% + 32 tokens
 * of headroom. A low-density prefix must never discount an unknown suffix.
 * No global multiplier survives a rewrite or a newer usage observation.
 */
export function calibrateInputTokens(usage: InputTokenUsage | undefined, request: ModelRequest,
  projection: ProviderInputProjection): InputTokenCalibration | undefined {
  const prefixInputTokens = reusableInputTokenFloor(usage, request, projection);
  const previous = usage?.lastRequestInputBasis?.projection;
  const before = previous?.tokenEstimate;
  const after = projection.tokenEstimate;
  if (prefixInputTokens === undefined || !previous || !before || !after || before.method !== after.method ||
    before.tokens <= 0 || !Number.isInteger(after.tokens) || after.tokens < before.tokens) return undefined;
  const suffixEstimateTokens = after.tokens - before.tokens;
  const suffixScale = Math.max(1, prefixInputTokens / before.tokens);
  const scaledSuffix = Math.ceil(suffixEstimateTokens * suffixScale);
  const extended = projection.inputDigests.length > previous.inputDigests.length;
  // An unchanged projection has no unknown input to reserve for. Reject a
  // drifting estimator instead of treating its drift as appended content.
  if (!extended && suffixEstimateTokens !== 0) return undefined;
  const safetyTokens = extended ? Math.ceil(scaledSuffix * 0.1) + 32 : 0;
  return { inputTokens: prefixInputTokens + scaledSuffix + safetyTokens,
    prefixInputTokens, suffixEstimateTokens, suffixScale, safetyTokens };
}

/** Fallback for adapters without a wire estimator. This is explicitly a
 * Runtime representation, so it cannot calibrate a later native projection.
 */
export function runtimeInputTokenProjection(candidate: ModelRequest): ProviderInputProjection {
  const request = modelRequestSchema.parse(candidate);
  const messages = request.messages.map(message => {
    if (message.role === 'assistant') {
      const { providerReplay: _replay, ...canonical } = message;
      return canonical;
    }
    if (message.role === 'user' && message.images) {
      return { ...message, images: message.images.map(image => ({ detail: image.detail })) };
    }
    return message;
  });
  const shape = { model: request.model, messages, tools: request.tools,
    reasoningEffort: request.reasoningEffort, requestCapabilities: request.requestCapabilities };
  const images = request.messages.reduce((total, message) =>
    total + (message.role === 'user' ? message.images?.length ?? 0 : 0), 0);
  return { format: 'bush.runtime.input.v1', transport: 'full',
    parameterDigests: { request: inputTokenBasis(request).requestShapeDigest },
    inputDigests: request.messages.map(hash),
    tokenEstimate: { method: 'runtime-input-chars-v1', tokens: Math.ceil(JSON.stringify(shape).length / 4) + images * 1024,
      inputParametersDigest: inputTokenBasis(request).inputShapeDigest } };
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
