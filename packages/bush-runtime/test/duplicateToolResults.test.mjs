import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  LogicMemoryStore,
  ToolRegistry,
  registerExtendedBuiltins,
} from "../dist/index.js";

test("consult_logic omits request fields already present in the Tool call", async (t) => {
  const root = await temporaryRoot(t);
  const memory = new LogicMemoryStore(join(root, "logic.json"));
  await memory.learn({
    scenario: "A code change is ready for completion",
    bias: "Completion was claimed without verification",
    correction: "Run proportionate verification before completion",
    conditions: ["before_final"],
  });
  const registry = new ToolRegistry();
  registerExtendedBuiltins(registry, { dataRoot: root, logicMemory: memory });
  const tool = registry.resolve("consult_logic");
  const input = tool.decodeInput({
    query: "How should a code change be verified before completion?",
    scenario_conditions: ["before_final"],
    cognitive_patterns: ["premature_completion"],
  });
  const result = await tool.execute(context(input, "consult_logic"));

  assert.equal("query" in result, false);
  assert.equal("scenario_conditions" in result, false);
  assert.equal("cognitive_patterns" in result, false);
  assert.equal(result.matched_count, 1);
  assert.equal(result.matched_logic.length, 1);
});

test("parallel_tools omits reasons already present in its Tool arguments", async (t) => {
  const root = await temporaryRoot(t);
  const registry = new ToolRegistry();
  registry.register(childRegistration("first_child"));
  registry.register(childRegistration("second_child"));
  registerExtendedBuiltins(registry, { dataRoot: root });
  const tool = registry.resolve("parallel_tools");
  const input = tool.decodeInput({
    tool_calls: [{
      name: "first_child",
      arguments: { value: "first" },
      reason: "reason-only-in-request-one",
    }, {
      name: "second_child",
      arguments: { value: "second" },
      reason: "reason-only-in-request-two",
    }],
  });
  const result = await tool.execute({
    ...context(input, "parallel_tools"),
    invokeTool: async (name, args) => {
      const child = registry.resolve(name);
      return child.execute(context(child.decodeInput(args), name));
    },
  });

  assert.equal(result.returned_count, 2);
  assert.deepEqual(result.results.map((item) => item.name), ["first_child", "second_child"]);
  assert.equal(result.results.some((item) => "reason" in item), false);
});

test("inject_image_input keeps duplicate call metadata out of its receipt", async (t) => {
  const root = await temporaryRoot(t);
  const registry = new ToolRegistry();
  registerExtendedBuiltins(registry, { dataRoot: root });
  const tool = registry.resolve("inject_image_input");
  const input = tool.decodeInput({
    url: "data:image/png;base64,AAAA",
    label: "already in arguments",
    caption: "already in arguments too",
    detail: "low",
  });
  const result = await tool.execute(context(input, "inject_image_input"));

  assert.equal(result.queued, true);
  assert.equal("url" in result, false);
  assert.equal("label" in result, false);
  assert.equal("caption" in result, false);
  assert.equal(result.artifacts[0].uri, input.url);
});

function childRegistration(name) {
  return {
    definition: {
      name,
      description: "fixture",
      inputSchema: { type: "object", additionalProperties: false },
    },
    manifest: manifest(`fixture.${name}`),
    parallelSafe: true,
    decodeInput: (input) => input,
    execute: (childContext) => ({ observed: childContext.input.value }),
  };
}

function context(input, name) {
  return {
    requestId: "request",
    sessionId: "session",
    turnId: "turn",
    toolCall: {
      protocol: "bush.tool_call.v1",
      id: `call_${name}`,
      name,
      argumentsText: JSON.stringify(input),
    },
    input,
    actionManifest: manifest(`fixture.${name}`),
    capabilityIds: [],
    recordWorkspaceChange() {},
  };
}

function manifest(operation) {
  return {
    protocol: "bush.tool.action_manifest.v1",
    manifest_id: `manifest_${operation}`,
    effect_kind: "observation",
    operation,
    risk: "low",
    owner: "test",
    dispatch_scope: "runtime",
    mutating: false,
  };
}

async function temporaryRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "cardbush-duplicate-tool-results-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
