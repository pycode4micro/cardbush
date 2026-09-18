import assert from "node:assert/strict";
import test from "node:test";
import { ModelImageStore, readLocalModelImage } from "../dist/index.js";
import { imageFixture, png } from "./helpers/modelImages.mjs";

import {
  InMemoryRuntimeEventLog,
  RuntimeToolLoop,
  ToolRegistry,
} from "../dist/index.js";

test("projects only explicitly opted-in image artifacts into the next model step", async (context) => {
  const { root, source } = await imageFixture(context);
  const registry = new ToolRegistry();
  registry.register(registration(source));
  const loop = new RuntimeToolLoop({
    eventLog: new InMemoryRuntimeEventLog(),
    identity: { requestId: "request", sessionId: "session", turnId: "turn" },
    registry,
    modelImages: new ModelImageStore(root),
  });
  const result = await loop.execute([{
    id: "call_capture",
    name: "capture",
    argumentsText: "{}",
  }], {
    round: 0,
    assistantMessageId: "assistant",
  });
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].role, "tool");
  assert.equal(result.messages[0].toolCallId, "call_capture");
  assert.deepEqual(result.messages[0].images, [{ url: await new ModelImageStore(root).snapshot(source) }]);
  assert.deepEqual(JSON.parse(result.messages[0].content), registration(source).execute());
});

test("does not append an image when the Tool round has no remaining image budget", async () => {
  const registry = new ToolRegistry();
  registry.register(registration());
  const loop = new RuntimeToolLoop({
    eventLog: new InMemoryRuntimeEventLog(),
    identity: { requestId: "request_budget", sessionId: "session", turnId: "turn" },
    registry,
  });
  const result = await loop.execute([{
    id: "call_capture_budget",
    name: "capture",
    argumentsText: "{}",
  }], {
    round: 0,
    assistantMessageId: "assistant_budget",
    modelContextIngressBudgetTokens: 200,
  });

  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].role, "tool");
  assert.equal(result.messages.some((message) => message.images?.length), false);
  const receipt = JSON.parse(result.messages[0].content.split('\n\n').at(-1));
  assert.equal(receipt.omittedImages, 1);
  assert.equal(receipt.reason, 'attachment_budget');
});

test("images stay with their calls and share one round budget, even when calls return identical images", async (context) => {
  const { root, source } = await imageFixture(context);
  const registry = new ToolRegistry();
  registry.register(registration(source));
  registry.register({ ...registration(source),
    definition: { ...registration(source).definition, name: 'text_only' },
    execute: () => ({ observed: 'text' }),
  });
  const loop = new RuntimeToolLoop({ eventLog: new InMemoryRuntimeEventLog(),
    identity: { requestId: 'mixed', sessionId: 'session', turnId: 'turn' }, registry,
    modelImages: new ModelImageStore(root) });
  const calls = Array.from({ length: 6 }, (_, index) => ({ id: `call_${index}`,
    name: index === 1 ? 'text_only' : 'capture', argumentsText: '{}' }));
  const { messages } = await loop.execute(calls, { round: 0, assistantMessageId: 'assistant' });
  assert.deepEqual(messages.map(message => [message.role, message.toolCallId]),
    calls.map(call => ['tool', call.id]));
  assert.deepEqual(messages.map(message => message.images?.length ?? 0), [1, 0, 1, 1, 1, 0]);
  assert.deepEqual(JSON.parse(messages[1].content), { observed: 'text' });
  assert.equal(JSON.parse(messages.at(-1).content.split('\n\n').at(-1)).reason, 'attachment_budget');
});

test("keeps injected image locators out of the model-facing Tool receipt", async (context) => {
  const { root } = await imageFixture(context);
  const imageUrl = `data:image/png;base64,${png.toString('base64')}`;
  const registry = new ToolRegistry();
  registry.register({
    ...registration(),
    definition: {
      name: "inject_image_input",
      description: "fixture",
      inputSchema: { type: "object", additionalProperties: false },
    },
    execute: () => ({
      queued: true,
      url: imageUrl,
      label: "already present in Tool arguments",
      artifacts: [{
        artifact_id: "artifact_injected",
        type: "image",
        uri: imageUrl,
        metadata: { model_input: true },
      }],
    }),
  });
  const loop = new RuntimeToolLoop({
    eventLog: new InMemoryRuntimeEventLog(),
    identity: { requestId: "request_inject", sessionId: "session", turnId: "turn" },
    registry,
    modelImages: new ModelImageStore(root),
  });
  const result = await loop.execute([{
    id: "call_inject",
    name: "inject_image_input",
    argumentsText: JSON.stringify({ url: imageUrl, label: "already present in Tool arguments" }),
  }], {
    round: 0,
    assistantMessageId: "assistant_inject",
  });

  assert.deepEqual(JSON.parse(result.messages[0].content), {
    queued: true,
    attached_images: 1,
  });
  assert.equal(result.messages[0].content.includes(imageUrl), false);
  assert.deepEqual((await readLocalModelImage(result.messages[0].images[0].url)).content, png);
});

function registration(source = "https://example.test/screen.png") {
  return {
    definition: {
      name: "capture",
      description: "fixture",
      inputSchema: { type: "object", additionalProperties: false },
    },
    manifest: {
      effect_kind: "observation",
      operation: "desktop.capture",
      risk: "low",
      owner: "test",
      dispatch_scope: "process",
      mutating: false,
    },
    decodeInput: (input) => input,
    execute: () => ({
      path: source,
      artifacts: [{
        artifact_id: "artifact_capture",
        type: "image",
        path: source,
        media_type: "image/png",
        display: "inline",
        metadata: { model_input: true },
      }, {
        artifact_id: "artifact_not_for_model",
        type: "image",
        path: "C:\\captures\\other.png",
        metadata: { model_input: false },
      }],
    }),
  };
}
