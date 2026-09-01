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
