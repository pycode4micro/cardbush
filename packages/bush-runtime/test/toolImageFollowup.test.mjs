import assert from "node:assert/strict";
import test from "node:test";

import {
  BUSH_EXECUTION_FACT_PROTOCOL,
  BUSH_TOOL_RESULT_PROTOCOL,
} from "@cardbush/bush-protocol";
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
    content: "Visual observations produced by the preceding Tool are attached. Inspect their pixels before making visual claims or deciding the next visual action.",
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
      dispatch_phase: "execution",
      dispatch_scope: "process",
      dispatch_side_effect: "none",
      dispatch_mutating: false,
      dispatch_source: "registered_tool",
      stage_modes: ["execute"],
      output_kinds: ["artifact"],
      handoff_exports: ["artifact"],
      evidence_hints: ["screenshot"],
    },
    decodeInput: (input) => input,
    execute: ({ toolCall, actionManifest }) => ({
      protocol: BUSH_TOOL_RESULT_PROTOCOL,
      tool_call_id: toolCall.id,
      success: true,
      output: { path: "C:\\captures\\screen.png" },
      facts: [{
        protocol: BUSH_EXECUTION_FACT_PROTOCOL,
        receipt_id: "receipt_capture",
        action_manifest_id: actionManifest.manifest_id,
        status: "succeeded",
        operation: actionManifest.operation,
        effect_kind: actionManifest.effect_kind,
        owner: actionManifest.owner,
        dispatch_scope: actionManifest.dispatch_scope,
        categories: ["observation"],
        paths: ["C:\\captures\\screen.png"],
        execution_success: true,
        semantic_success: true,
        verification_state: "verified",
        error_code: "",
      }],
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
      workspace_changes: [],
      guidance: [],
    }),
  };
}
