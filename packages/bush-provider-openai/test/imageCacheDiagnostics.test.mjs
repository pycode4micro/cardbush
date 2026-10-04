import assert from 'node:assert/strict';
import test from 'node:test';
import { providerInputProjectionSchema } from '@cardbush/bush-protocol';
import { OpenAIResponsesProvider, OpenAIChatCompletionsProvider, AnthropicMessagesProvider } from '../dist/index.js';
import { imageInputFingerprint } from '../dist/imageInputFingerprint.js';

const inline = 'data:image/png;base64,private-pixel-fixture';
const remote = 'https://fixture.invalid/private-image?token=secret';
const request = { protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 's', turnId: 't', model: 'fixture', tools: [], metadata: {},
  messages: [{ role: 'user', content: 'Inspect', images: [{ url: inline, detail: 'high' }] },
    { role: 'assistant', content: '', toolCalls: [{ id: 'capture', name: 'capture', argumentsText: '{}' }] },
    { role: 'tool', toolCallId: 'capture', content: 'Captured', images: [{ url: remote }] }] };

for (const Provider of [OpenAIResponsesProvider, OpenAIChatCompletionsProvider, AnthropicMessagesProvider]) {
  test(`${Provider.name}: reports user and tool image inputs without content or URL leakage`, async () => {
    const projections = [], original = structuredClone(request);
    const provider = new Provider({ apiKey: 'fixture', baseURL: 'https://fixture.invalid/v1', fetch: () => { throw Error('No network expected'); } });
    const options = { onInputProjection: value => projections.push(providerInputProjectionSchema.parse(value)) };
    await provider.estimateInputTokens(request, options);
    await provider.estimateInputTokens(request, options);
    assert.deepEqual(projections[0], projections[1]);
    assert.equal(projections[0].images.digests.length, 2);
    assert.equal(projections[0].images.remoteCount, 1);
    assert.ok(projections[0].images.digests.every(value => /^[a-f0-9]{64}$/.test(value)));
    assert.doesNotMatch(JSON.stringify(projections), /private-image|secret|private-pixel-fixture/);
    assert.deepEqual(request, original);
  });
}

test('image metadata counts occurrences, detects pixel/detail changes and ignores image-shaped text', () => {
  const image = { type: 'input_image', image_url: inline, detail: 'high' };
  const first = imageInputFingerprint([{ type: 'function_call_output', output: [image, image] },
    { role: 'user', content: JSON.stringify({ type: 'input_image', image_url: remote }) },
    { type: 'function_call', arguments: JSON.stringify(image) }]);
  assert.equal(first.digests.length, 2);
  assert.equal(first.digests[0], first.digests[1]);
  assert.equal(first.remoteCount, 0);
  const changeDetail = imageInputFingerprint([{ content: [{ ...image, detail: 'low' }] }]);
  const changePixels = imageInputFingerprint([{ content: [{ ...image, image_url: inline + 'changed' }] }]);
  assert.notEqual(first.digests[0], changeDetail.digests[0]);
  assert.notEqual(first.digests[0], changePixels.digests[0]);
  assert.deepEqual(imageInputFingerprint([{ content: 'No images' }]), { digests: [], remoteCount: 0 });
});
