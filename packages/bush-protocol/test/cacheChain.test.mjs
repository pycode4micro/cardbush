import assert from 'node:assert/strict';
import test from 'node:test';
import { cacheChainChanges, cacheChainObservationPayloadSchema, providerInputObservationSchema, cacheChainStateSchema } from '../dist/index.js';

const legacy = {
  requestOrdinal: 2, messageCount: 3, previousMessageCount: 2, sharedPrefixMessages: 2,
  appendedMessages: 1, frozenPrefixBreak: true, breakIndex: 0,
  stableInputDigest: 'parameters', sharedPrefixDigest: 'messages',
};

test('legacy combined flags are separated using their independent prefix counts', () => {
  const parameterOnly = cacheChainObservationPayloadSchema.parse(legacy);
  assert.equal(parameterOnly.prefixComparisonAvailable, undefined, 'do not invent new semantics for persisted events');
  assert.deepEqual(cacheChainChanges(parameterOnly), { prefixBreak: false, parametersChanged: true, projectionFormatChanged: false });
  const both = providerInputObservationSchema.parse({ ...legacy, sharedPrefixMessages: 1,
    format: 'fixture', transport: 'full', previousProjectionAvailable: true, changedParameters: ['tools'] });
  assert.deepEqual(cacheChainChanges(both), { prefixBreak: true, parametersChanged: true, projectionFormatChanged: false });
  assert.equal(both.breakIndex, 0, 'decoding preserves the original journal');
  const missingParameters = cacheChainObservationPayloadSchema.parse({ ...legacy, sharedPrefixMessages: 1 });
  assert.deepEqual(cacheChainChanges(missingParameters), { prefixBreak: true, parametersChanged: undefined, projectionFormatChanged: false });
});

test('old and new protocol switches remain incomparable rather than false message breaks', () => {
  for (const switched of [
    { ...legacy, changedParameters: ['projection_format'] },
    { ...legacy, frozenPrefixBreak: false, prefixComparisonAvailable: false, parametersChanged: false,
      projectionFormatChanged: true, changedParameters: [] },
  ]) {
    const parsed = providerInputObservationSchema.parse({ ...switched,
      format: 'new-format', transport: 'full', previousProjectionAvailable: true });
    assert.deepEqual(cacheChainChanges(parsed), { prefixBreak: undefined, parametersChanged: false, projectionFormatChanged: true });
  }
});

test('new diagnostics survive protocol decoding with both changes and the real boundary', () => {
  const parsed = cacheChainObservationPayloadSchema.parse({ ...legacy, prefixComparisonAvailable: true,
    parametersChanged: true, changedParameters: ['temperature'], sharedPrefixMessages: 1, breakIndex: 1, messageBreakIndex: 1 });
  assert.equal(parsed.breakIndex, 1);
  assert.deepEqual(parsed.changedParameters, ['temperature']);
  assert.deepEqual(cacheChainChanges(parsed), { prefixBreak: true, parametersChanged: true, projectionFormatChanged: false });
  const parameterOnly = { ...parsed, frozenPrefixBreak: false, breakIndex: undefined, messageBreakIndex: undefined, sharedPrefixMessages: 2 };
  assert.deepEqual(cacheChainChanges(parameterOnly), { prefixBreak: false, parametersChanged: true, projectionFormatChanged: false });
});

test('old checkpoints remain readable and new checkpoints persist only parameter hashes', () => {
  const old = { protocol: 'bush.cache_chain_state.v1', requestOrdinal: 2, stableInputDigest: 'aggregate', messageDigests: ['message'] };
  assert.deepEqual(cacheChainStateSchema.parse(old), old);
  const current = { ...old, parameterDigests: { temperature: 'value-hash', tools: 'schema-hash' } };
  assert.deepEqual(cacheChainStateSchema.parse(JSON.parse(JSON.stringify(current))), current);
});
