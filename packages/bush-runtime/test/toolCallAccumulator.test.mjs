import assert from "node:assert/strict";
import test from "node:test";

import { BUSH_MODEL_EVENT_PROTOCOL } from "@cardbush/bush-protocol";
import { ToolCallAccumulator } from "../dist/index.js";

const base = {
  protocol: BUSH_MODEL_EVENT_PROTOCOL,
  requestId: "req_1",
  createdAt: "2026-08-29T00:00:00.000Z",
};

test("accumulates interleaved parallel tool deltas by provider index", () => {
  const accumulator = new ToolCallAccumulator();
  accumulator.accept({ ...base, sequence: 0, kind: "tool_call_delta", index: 0, toolCallId: "a", nameDelta: "read_" });
  accumulator.accept({ ...base, sequence: 1, kind: "tool_call_delta", index: 1, toolCallId: "b", nameDelta: "search_" });
  accumulator.accept({ ...base, sequence: 2, kind: "tool_call_delta", index: 0, nameDelta: "file", argumentsDelta: '{"path":' });
  accumulator.accept({ ...base, sequence: 3, kind: "tool_call_delta", index: 1, nameDelta: "file_content", argumentsDelta: '{"query":"x"}' });
  accumulator.accept({ ...base, sequence: 4, kind: "tool_call_delta", index: 0, argumentsDelta: '"README.md"}' });

  assert.deepEqual(accumulator.completed(), [
    { protocol: "bush.tool_call.v1", id: "a", name: "read_file", argumentsText: '{"path":"README.md"}' },
    { protocol: "bush.tool_call.v1", id: "b", name: "search_file_content", argumentsText: '{"query":"x"}' },
  ]);
});

test("does not invent missing tool identities", () => {
  const accumulator = new ToolCallAccumulator();
  accumulator.accept({ ...base, sequence: 0, kind: "tool_call_delta", index: 0, argumentsDelta: "{}" });
  assert.throws(() => accumulator.completed(), /incomplete tool call/);
});
