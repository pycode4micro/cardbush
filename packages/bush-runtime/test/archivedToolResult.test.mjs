import assert from "node:assert/strict";
import test from "node:test";

import {
  ToolRegistry,
  registerExtendedBuiltins,
} from "../dist/index.js";

test("publishes one strict archived-result reader", async () => {
  const registry = new ToolRegistry();
  const archived = {
    protocol: "bush.tool_result.v1",
    output: { text: "x".repeat(2_000) },
  };
  registerExtendedBuiltins(registry, {
    readToolResult(locator) {
      assert.equal(locator, "tool-result://session/turn/call");
      return archived;
    },
  });

  const reader = registry.resolve("read_archived_tool_result");
  assert.ok(reader);
  assert.deepEqual(reader.definition.inputSchema.required, ["locator"]);
  assert.equal(reader.definition.inputSchema.additionalProperties, false);

  assert.throws(
    () => reader.decodeInput({ locator: "C:\\Users\\fixture\\SKILL.md" }),
    /exact tool-result:\/\//,
  );
  assert.throws(
    () => reader.decodeInput({ locator: "file:///tmp/not-an-archive" }),
    /exact tool-result:\/\//,
  );

  const input = reader.decodeInput({
    locator: "tool-result://session/turn/call",
    offset: 500,
    max_chars: 500,
  });
  const result = await reader.execute(context(input));
  assert.equal(result.locator, "tool-result://session/turn/call");
  assert.equal(result.offset, 500);
  assert.equal(result.text.length, 500);
  assert.equal(result.complete, false);
});

function context(input) {
  return {
    requestId: "request_archive",
    sessionId: "session",
    turnId: "turn",
    toolCall: {
      protocol: "bush.tool_call.v1",
      id: "call_reader",
      name: "read_archived_tool_result",
      argumentsText: JSON.stringify(input),
    },
    input,
    actionManifest: {
      protocol: "bush.tool.action_manifest.v1",
      manifest_id: "manifest_archive",
      effect_kind: "observation",
      operation: "tool_result_archive.read",
      risk: "low",
      owner: "runtime",
      dispatch_scope: "session",
      mutating: false,
    },
    capabilityIds: [],
    recordWorkspaceChange() {},
  };
}
