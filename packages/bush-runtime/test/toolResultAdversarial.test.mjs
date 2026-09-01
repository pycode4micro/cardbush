import assert from "node:assert/strict";
import test from "node:test";

import { toolExecutionRecordSchema } from "@cardbush/bush-protocol";
import {
  ToolExecutionCoordinator,
  ToolExecutionStore,
  ToolRegistry,
} from "../dist/index.js";

const call = {
  protocol: "bush.tool_call.v1",
  id: "call_adversarial",
  name: "adversarial_tool",
  argumentsText: "{}",
};

const identity = {
  requestId: "request_adversarial",
  sessionId: "session_adversarial",
  turnId: "turn_adversarial",
  round: 1,
  ordinal: 0,
};

const manifest = {
  effect_kind: "observation",
  operation: "adversarial.return",
  risk: "low",
  owner: "adversarial_fixture",
  dispatch_scope: "turn",
  mutating: false,
};

test("preserves every JSON-native shape without interpreting hostile semantic fields", async () => {
  const legacyShaped = JSON.parse(JSON.stringify({
    protocol: "bush.tool_result.v1",
    success: false,
    isError: true,
    execution_success: false,
    semantic_success: true,
    verification_state: "verified",
    receipt_id: "duplicate_receipt",
    facts: [{ receipt_id: "duplicate_receipt" }],
    content: [{ type: "text", text: "原生 MCP 结果 😀" }],
    nested: [null, false, 0, 42.5, { value: "kept" }],
  }));
  const values = [
    null,
    false,
    0,
    42.5,
    "原生字符串 😀",
    [],
    {},
    legacyShaped,
    JSON.parse('{"__proto__":{"polluted":true},"constructor":"native"}'),
  ];

  for (const [index, value] of values.entries()) {
    const outcome = await executeValue(() => value, index);
    assert.equal(outcome.kind, "returned");
    assert.equal(JSON.stringify(outcome.result), JSON.stringify(value));
  }
  assert.equal({}.polluted, undefined);
});

test("rejects non-JSON and lossy JavaScript values instead of silently rewriting them", async (t) => {
  const cycle = { label: "cycle" };
  cycle.self = cycle;
  const sparse = new Array(2);
  sparse[1] = "present";
  const customArray = ["value"];
  customArray.extra = "would be dropped by JSON.stringify";
  const symbolProperty = { value: "visible" };
  symbolProperty[Symbol("hidden")] = "would be dropped";
  const hiddenProperty = { value: "visible" };
  Object.defineProperty(hiddenProperty, "hidden", { value: "dropped", enumerable: false });
  const accessorProperty = {};
  Object.defineProperty(accessorProperty, "value", {
    enumerable: true,
    get() {
      throw new Error("getter must not execute");
    },
  });
  const customSerializer = { value: "visible" };
  Object.defineProperty(customSerializer, "toJSON", {
    value: () => ({ spoofed: true }),
    enumerable: false,
  });

  const cases = [
    ["undefined", undefined],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["negative zero", -0],
    ["bigint", 1n],
    ["symbol", Symbol("value")],
    ["function", () => "value"],
    ["Date", new Date("2026-09-01T00:00:00.000Z")],
    ["Map", new Map([["key", "value"]])],
    ["nested undefined", { value: undefined }],
    ["cycle", cycle],
    ["sparse array", sparse],
    ["custom array property", customArray],
    ["symbol property", symbolProperty],
    ["non-enumerable property", hiddenProperty],
    ["accessor property", accessorProperty],
    ["custom toJSON", customSerializer],
  ];

  for (const [index, [name, value]] of cases.entries()) {
    await t.test(name, async () => {
      const outcome = await executeValue(() => value, index);
      assert.equal(outcome.kind, "failed");
      assert.equal(outcome.error.kind, "protocol");
      assert.equal(outcome.error.code, "tool_native_result_not_json_serializable");
    });
  }
});

test("snapshots returned data before a Tool can mutate it after completion", async () => {
  const source = {
    nested: { value: "before" },
    list: [1, 2, 3],
  };
  const outcome = await executeValue(() => source);
  assert.equal(outcome.kind, "returned");

  source.nested.value = "after";
  source.list.push(4);

  assert.deepEqual(outcome.result, {
    nested: { value: "before" },
    list: [1, 2, 3],
  });
});

test("sanitizes hostile thrown details without losing the stable Runtime failure", async () => {
  const cyclicDetails = { operation: "fixture" };
  cyclicDetails.self = cyclicDetails;
  const outcome = await executeValue(() => {
    throw Object.assign(new Error("fixture exploded"), {
      code: "fixture_exploded",
      details: cyclicDetails,
    });
  });

  assert.equal(outcome.kind, "failed");
  assert.equal(outcome.error.kind, "tool");
  assert.equal(outcome.error.code, "fixture_exploded");
  assert.equal(outcome.error.message, "fixture exploded");
  assert.match(outcome.error.details.detailsSerializationError, /cycles/);
  assert.equal(outcome.error.details.name, "Error");
  assert.doesNotThrow(() => JSON.stringify(outcome.error));
});

test("ToolExecutionStore owns an immutable snapshot of the coordinator outcome", async () => {
  const outcome = await executeValue(() => ({ nested: { value: "recorded" } }));
  assert.equal(outcome.kind, "returned");
  const store = new ToolExecutionStore({ now: () => "2026-09-01T00:00:00.000Z" });
  store.record(call, identity, outcome);

  outcome.result.nested.value = "mutated by caller";
  assert.equal(
    store.get(identity.sessionId, identity.turnId, call.id).result.nested.value,
    "recorded",
  );
});

test("execution record protocol requires exactly one native-result or Runtime-error branch", () => {
  const base = {
    protocol: "bush.tool.execution_record.v2",
    ...identity,
    recordedAt: "2026-09-01T00:00:00.000Z",
    toolCall: call,
    actionManifest: {
      protocol: "bush.tool.action_manifest.v1",
      manifest_id: "attempt:turn_adversarial:1:call_adversarial",
      ...manifest,
    },
    workspaceChanges: [],
  };

  assert.throws(() => toolExecutionRecordSchema.parse({ ...base, outcome: "returned" }));
  assert.throws(() => toolExecutionRecordSchema.parse({
    ...base,
    outcome: "returned",
    result: undefined,
  }));
  assert.doesNotThrow(() => toolExecutionRecordSchema.parse({
    ...base,
    outcome: "returned",
    result: null,
  }));
  assert.throws(() => toolExecutionRecordSchema.parse({
    ...base,
    outcome: "failed",
    result: { spoofed: true },
    error: runtimeError(),
  }));
  assert.throws(() => toolExecutionRecordSchema.parse({ ...base, outcome: "failed" }));
});

async function executeValue(factory, ordinal = 0) {
  const registry = new ToolRegistry();
  registry.register({
    definition: {
      name: call.name,
      description: "Adversarial native Tool result fixture.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    manifest,
    decodeInput: (input) => input,
    execute: factory,
  });
  const coordinator = new ToolExecutionCoordinator({
    registry,
    permissions: {
      request: async () => {
        throw new Error("permission was not expected");
      },
    },
  });
  return coordinator.execute(call, { ...identity, ordinal });
}

function runtimeError() {
  return {
    kind: "tool",
    code: "fixture_failure",
    message: "fixture failed",
    details: {},
  };
}
