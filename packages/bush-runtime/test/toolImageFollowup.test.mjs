import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryRuntimeEventLog,
  RuntimeToolLoop,
  ToolRegistry,
} from "../dist/index.js";

test("projects only explicitly opted-in image artifacts into the next model step", async () => {
  const registry = new ToolRegistry();
  registry.register(registration());
  const loop = new RuntimeToolLoop({
    eventLog: new InMemoryRuntimeEventLog(),
    identity: { requestId: "request", sessionId: "session", turnId: "turn" },
    registry,
  });
  const result = await loop.execute([{
    id: "call_capture",
    name: "capture",
    argumentsText: "{}",
  }], {
    round: 0,
    assistantMessageId: "assistant",
  });
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0].role, "tool");
  assert.deepEqual(result.messages[1], {
    role: "user",
    name: "tool_image_observation",
    visibility: "internal",
    content: JSON.stringify({ source: "tool_output", attachedImages: 1 }),
    images: [{ url: "C:\\captures\\screen.png" }],
  });
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
});

test("keeps injected image locators out of the model-facing Tool receipt", async () => {
  const imageUrl = `data:image/png;base64,${"A".repeat(20_000)}`;
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
  assert.equal(result.messages[1].images[0].url, imageUrl);
});

function registration() {
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
      path: "C:\\captures\\screen.png",
      artifacts: [{
        artifact_id: "artifact_capture",
        type: "image",
        path: "C:\\captures\\screen.png",
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
