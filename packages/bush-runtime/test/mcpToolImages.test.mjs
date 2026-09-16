import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { InMemoryRuntimeEventLog, ModelImageStore, RuntimeToolLoop, ToolExecutionStore, ToolRegistry,
  registerExtendedBuiltins, omitToolImageDataFromText } from '../dist/index.js';
import { imageFixture, incompletePng, png } from './helpers/modelImages.mjs';

const block = (data = png) => ({ type: 'image', mimeType: 'image/png', data: data.toString('base64') });
const call = { protocol: 'bush.tool_call.v1', id: 'capture', name: 'capture', argumentsText: '{}' };

async function fixture(t, native, settings = {}) {
  const { root } = await imageFixture(t);
  const registry = new ToolRegistry();
  registry.register({
    definition: { name: settings.name ?? 'capture', description: 'fixture', inputSchema: { type: 'object' } },
    manifest: { effect_kind: 'observation', operation: 'mcp.call', risk: 'low', owner: 'test', dispatch_scope: 'process', mutating: false },
    decodeInput: value => value, execute: () => native,
    ...(settings.renderModelResult ? { renderModelResult: settings.renderModelResult } : {}),
  });
  const executionStore = new ToolExecutionStore();
  const loop = new RuntimeToolLoop({ eventLog: new InMemoryRuntimeEventLog(),
    identity: { requestId: 'request', sessionId: 'session', turnId: 'turn' },
    registry, executionStore, modelImages: new ModelImageStore(root) });
  const run = options => loop.execute([{ ...call, name: settings.name ?? call.name }], {
    round: 1, assistantMessageId: 'assistant', ...options,
  });
  return { root, run, executionStore };
}

for (const indirect of [false, true]) test(`MCP ${indirect ? 'mcp_call' : 'direct'} delivers an image once and preserves the native journal`, async t => {
  const image = block();
  const result = { isError: false, content: [{ type: 'text', text: 'Captured.' }, image, { ...image }], structuredContent: { bytes: png.length } };
  const native = indirect ? { mcp: { serverName: 'chrome' }, result } : result;
  const original = structuredClone(native);
  const { run, executionStore } = await fixture(t, native, {
    name: indirect ? 'mcp_call' : 'capture', renderModelResult: value => JSON.stringify(value),
  });
  const { messages } = await run();
  const observation = messages.at(-1);
  assert.equal(messages.length, 2);
  assert.equal(observation.visibility, 'internal');
  assert.equal(observation.images.length, 1);
  assert.deepEqual(await readFile(observation.images[0].url), png);
  const receipt = JSON.parse(observation.content);
  assert.deepEqual(receipt.imageReceipts.map(item => item.status), ['attached', 'attached']);
  assert.ok(receipt.imageReceipts.every(item => item.path === observation.images[0].url));
  assert.doesNotMatch(messages[0].content, new RegExp(image.data.slice(0, 32)));
  assert.match(messages[0].content, /runtime_image_files/);
  assert.ok(messages[0].content.length < 2000);
  assert.deepEqual(executionStore.get('session', 'turn', call.id).result, original);
  assert.deepEqual(native, original);
});

test('vision-disabled models and insufficient ingress budgets receive usable paths without image bytes', async t => {
  const native = { content: [block()] };
  for (const [options, status] of [
    [{ request: { requestCapabilities: { vision: false } } }, 'vision_disabled'],
    [{ modelContextIngressBudgetTokens: 0 }, 'attachment_budget'],
  ]) {
    const { run } = await fixture(t, native);
    const { messages } = await run(options);
    assert.ok(messages.every(message => !message.images?.length));
    const receipt = JSON.parse(messages.at(-1).content).imageReceipts[0];
    assert.equal(receipt.status, status);
    assert.deepEqual(await readFile(receipt.path), png);
    assert.ok(messages.every(message => !message.content.includes(native.content[0].data)));
  }
});

test('invalid images fail visibly while valid images and native isError status survive', async t => {
  const native = { isError: true, content: [block(incompletePng), block()] };
  const { run, executionStore } = await fixture(t, native);
  const { messages } = await run();
  const observation = messages.at(-1);
  assert.equal(observation.images.length, 1);
  assert.deepEqual(JSON.parse(observation.content).imageReceipts.map(item => item.status), ['failed', 'attached']);
  assert.match(JSON.parse(observation.content).imageInputErrors[0].code, /^image_input_/);
  assert.deepEqual(executionStore.get('session', 'turn', call.id).result, native);
  assert.equal(executionStore.get('session', 'turn', call.id).outcome, 'returned');
});

test('embedded image resources work and user-only MCP images stay out of model input', async t => {
  const native = { content: [
    { ...block(), annotations: { audience: ['user'] } },
    { type: 'resource', resource: { uri: 'test://image', mimeType: 'image/png', blob: png.toString('base64') }, _meta: { 'codex/imageDetail': 'high' } },
  ] };
  const { run } = await fixture(t, native);
  const { messages } = await run();
  assert.equal(messages.at(-1).images.length, 1);
  assert.equal(messages.at(-1).images[0].detail, 'high');
  assert.equal(JSON.parse(messages.at(-1).content).imageReceipts.length, 1);
  assert.ok(!messages[0].content.includes(png.toString('base64')));
});

test('MCP images use the existing resize budget and report excess attachments', async t => {
  const images = await Promise.all(Array.from({ length: 5 }, (_, index) => sharp({ create: {
    width: index ? 4 : 3200, height: index ? 4 : 2000, channels: 3, background: { r: 20 + index * 40, g: 100, b: 150 },
  } }).png().toBuffer()));
  const { run } = await fixture(t, { content: images.map(block) });
  const { messages } = await run();
  const observation = messages.at(-1);
  assert.equal(observation.images.length, 4);
  assert.equal(JSON.parse(observation.content).imageReceipts.at(-1).status, 'attachment_budget');
  const dimensions = await sharp(observation.images[0].url).metadata();
  assert.ok(dimensions.width * dimensions.height <= 4_000_000);
});

test('archived MCP results expose durable image paths and never replay Base64 text', async t => {
  const { root } = await imageFixture(t);
  const native = { content: [block()], _meta: { preserved: true } };
  const registry = new ToolRegistry();
  registerExtendedBuiltins(registry, { dataRoot: root, readToolResult: () => native });
  const reader = registry.resolve('read_archived_tool_result');
  const archived = await reader.execute({ input: reader.decodeInput({ locator: 'tool-result://session/turn/capture' }), toolCall: call });
  assert.ok(!archived.text.includes(native.content[0].data));
  const receipts = JSON.parse(archived.text.split('\n\n').at(-1)).runtime_image_files;
  assert.deepEqual(await readFile(receipts[0].path), png);
  assert.equal(native.content[0].data, png.toString('base64'));

  const projectedOnly = new ToolRegistry();
  registerExtendedBuiltins(projectedOnly, { dataRoot: root, readToolResultText: async () => JSON.stringify(native) });
  const textReader = projectedOnly.resolve('read_archived_tool_result');
  const older = await textReader.execute({ input: textReader.decodeInput({ locator: 'tool-result://session/turn/capture' }), toolCall: call });
  assert.ok(!older.text.includes(native.content[0].data));
  assert.equal(omitToolImageDataFromText('literal source text'), 'literal source text');
});
