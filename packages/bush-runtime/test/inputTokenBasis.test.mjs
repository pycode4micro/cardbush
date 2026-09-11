import assert from 'node:assert/strict';
import test from 'node:test';
import { modelRequestSchema } from '@cardbush/bush-protocol';
import { inputTokenBasis, reusableInputTokenFloor, calibrateInputTokens, runtimeInputTokenProjection } from '../dist/inputTokenBasis.js';
import { estimateContextPressure, requiresContextCompactionBeforeRound } from '../dist/contextCompaction.js';

test('token calibration follows the measured prefix rather than the last turn number', () => {
  const original = modelRequestSchema.parse({ protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 's', turnId: 'one',
    model: 'fixture', tools: [], messages: [{ role: 'system', content: 'Stable' }, { role: 'user', content: 'Large original input' }] });
  const usage = { lastRequestInputTokens: 100000, lastRequestInputBasis: inputTokenBasis(original) };
  assert.equal(reusableInputTokenFloor(usage, { ...original, turnId: 'two', requestId: 'next',
    messages: [...original.messages, { role: 'user', content: 'Appended input' }] }), 100000);
  for (const change of [
    { messages: [original.messages[0], { role: 'user', content: 'Edited input' }] },
    { messages: [original.messages[0]] },
    { model: 'another-model' },
    { providerBinding: { bindingId: 'other', revision: 'new' } },
    { reasoningEffort: 'high' },
    { tools: [{ name: 'read', description: 'Read facts', inputSchema: { type: 'object' } }] },
  ]) assert.equal(reusableInputTokenFloor(usage, { ...original, ...change }), undefined);
  assert.equal(reusableInputTokenFloor({ lastRequestInputTokens: 100000 }, original), undefined,
    'legacy usage with no source basis cannot calibrate a possibly rebuilt context');
});

const request = (content = 'a'.repeat(400000)) => modelRequestSchema.parse({
  protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 's', turnId: 't', model: 'fixture',
  tools: [], maxOutputTokens: 10000, metadata: { contextWindowTokens: 140000 },
  messages: [{ role: 'system', content: 'Stable' }, { role: 'user', content }],
});
const append = (r, content) => ({ ...r, messages: [...r.messages, { role: 'user', content }] });
const measured = (r, tokens, projection = runtimeInputTokenProjection(r)) => ({ lastRequestInputTokens: tokens,
  lastRequestInputBasis: { ...inputTokenBasis(r), projection } });

test('measured prefix replaces an overestimate without discounting the unknown suffix or rewriting input', () => {
  const original = request();
  const usage = measured(original, 50000);
  const next = append(original, 'new'.repeat(45000));
  const unchanged = structuredClone(next);
  const projection = runtimeInputTokenProjection(next);
  const calibration = calibrateInputTokens(usage, next, projection);
  assert.equal(calibration.prefixInputTokens, 50000);
  assert.equal(calibration.suffixScale, 1, 'low-density old text cannot discount newly appended content');
  assert.ok(calibration.inputTokens > 50000 + calibration.suffixEstimateTokens, 'unknown suffix retains headroom');
  const pressure = estimateContextPressure(next, next.messages, undefined, {
    projectedInputTokens: projection.tokenEstimate.tokens, calibration });
  assert.equal(requiresContextCompactionBeforeRound(estimateContextPressure(next, next.messages)), true);
  assert.equal(requiresContextCompactionBeforeRound(pressure), false, 'raw-prefix overcount must not cause premature compaction');
  assert.deepEqual(next, unchanged);
  const exact = estimateContextPressure(next, next.messages, 125000, { calibration });
  assert.equal(exact.estimatedPromptTokens, 125000);
  assert.equal(exact.calibration, undefined, 'server count takes precedence over local calibration');
  assert.equal(requiresContextCompactionBeforeRound(exact), true);
});

test('density correction applies only to the suffix and follows the latest measured basis', () => {
  const first = request('a'.repeat(80000));
  const second = append(first, 'b'.repeat(800000));
  const highDensity = calibrateInputTokens(measured(first, 60000), second, runtimeInputTokenProjection(second));
  assert.ok(highDensity.suffixScale > 2.5);
  const third = append(second, 'c'.repeat(4000));
  const current = calibrateInputTokens(measured(second, 110000), third, runtimeInputTokenProjection(third));
  assert.equal(current.prefixInputTokens, 110000);
  assert.equal(current.suffixScale, 1, 'an earlier high ratio must not ratchet all future input upward');
  assert.ok(current.inputTokens < 112000);
});

test('edits, compaction, model capabilities and actual wire rewrites invalidate the measured basis', () => {
  const original = request('original context');
  const usage = measured(original, 20);
  for (const change of [
    { messages: [original.messages[0]] },
    { messages: [original.messages[0], { role: 'user', content: 'rewritten summary' }] },
    { requestCapabilities: { vision: true, interactiveRequests: false } },
    { reasoningEffort: 'high' },
    { providerBinding: { bindingId: 'new', revision: 'new' } },
  ]) {
    const changed = { ...original, ...change };
    assert.equal(calibrateInputTokens(usage, changed, runtimeInputTokenProjection(changed)), undefined);
  }
  const next = append(original, 'new message');
  const wire = runtimeInputTokenProjection(next);
  for (const change of [
    { inputDigests: ['rewritten-tool-schema', ...wire.inputDigests.slice(1)] },
    { parameterDigests: { ...wire.parameterDigests, tools: 'fallback-to-function-tools' } },
    { format: 'another-protocol' },
    { tokenEstimate: { ...wire.tokenEstimate, method: 'new-estimator-version' } },
  ]) assert.equal(calibrateInputTokens(usage, next, { ...wire, ...change }), undefined);
});

test('output-only changes reuse input counts while complete wire diagnostics still retain the parameter change', () => {
  const original = request('Measured input');
  const usage = measured(original, 20);
  const maintenance = { ...original, maxOutputTokens: 2000 };
  const projection = runtimeInputTokenProjection(maintenance);
  assert.equal(calibrateInputTokens(usage, maintenance, projection).inputTokens, 20);
  assert.notDeepEqual(usage.lastRequestInputBasis.projection.parameterDigests, projection.parameterDigests,
    'generation parameters remain observable even when the counted input is identical');
  const legacy = structuredClone(usage);
  delete legacy.lastRequestInputBasis.inputShapeDigest;
  delete legacy.lastRequestInputBasis.projection.tokenEstimate.inputParametersDigest;
  assert.equal(calibrateInputTokens(legacy, maintenance, projection), undefined,
    'old persisted count bases cannot silently acquire new capabilities');
});

test('serialized usage can calibrate a continued full context but never a transport delta alone', () => {
  const original = request('original input');
  const usage = JSON.parse(JSON.stringify(measured(original, 10)));
  const next = append(original, 'next input');
  const projection = runtimeInputTokenProjection(next);
  assert.deepEqual(calibrateInputTokens(usage, next, { ...projection, transport: 'continuation' }),
    calibrateInputTokens(usage, next, projection));
  assert.equal(calibrateInputTokens(usage, next, { ...projection, inputDigests: projection.inputDigests.slice(2) }), undefined);
  assert.equal(calibrateInputTokens(usage, original, usage.lastRequestInputBasis.projection).inputTokens, 10);
});

test('missing usage, legacy estimates and estimator drift never acquire measured-prefix status', () => {
  const original = request('original input');
  const usage = measured(original, 10);
  const projection = runtimeInputTokenProjection(original);
  assert.equal(calibrateInputTokens({ lastRequestInputBasis: usage.lastRequestInputBasis }, original, projection), undefined);
  assert.equal(calibrateInputTokens({ lastRequestInputTokens: 10, lastRequestInputBasis: inputTokenBasis(original) }, original, projection), undefined);
  assert.equal(calibrateInputTokens(usage, original, { ...projection,
    tokenEstimate: { ...projection.tokenEstimate, tokens: projection.tokenEstimate.tokens + 100 } }), undefined);
  const changedMetadata = { ...original, metadata: { ...original.metadata, tracingId: 'new-turn' } };
  assert.equal(calibrateInputTokens(usage, changedMetadata, runtimeInputTokenProjection(changedMetadata)).inputTokens, 10,
    'Runtime-only tracing data must not change a canonical fallback context');
});
