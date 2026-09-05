import assert from "node:assert/strict";
import test from "node:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  InMemoryRuntimeEventLog, ModelImageStore, registerExtendedBuiltins,
  RuntimeToolLoop, ToolRegistry, ToolExecutionStore,
} from "../dist/index.js";
import { imageFixture, png } from "./helpers/modelImages.mjs";

test("pins a native screenshot before the next sequential Tool deletes it, retaining the native result", async (context) => {
  const { root, source } = await imageFixture(context);
  const registry = new ToolRegistry();
  const capture = registration(source);
  registry.register(capture);
  registry.register({
    ...capture,
    definition: { ...capture.definition, name: "delete_source" },
    execute: async () => { await rm(source); return { deleted: true }; },
  });
  const executionStore = new ToolExecutionStore();
  const result = await makeLoop(root, registry, executionStore).execute([
    { protocol: "bush.tool_call.v1", id: "capture", name: "capture", argumentsText: "{}" },
    { protocol: "bush.tool_call.v1", id: "delete", name: "delete_source", argumentsText: "{}" },
  ], { round: 1, assistantMessageId: "assistant" });
  assert.deepEqual(await readFile(result.messages.at(-1).images[0].url), png);
  assert.deepEqual(executionStore.get("session", "turn", "capture").result, capture.execute());
  assert.equal(JSON.parse(result.messages[0].content).artifacts[0].path, source);
});

test("missing native images produce an actionable observation without rewriting a successful Tool outcome", async (context) => {
  const { root } = await imageFixture(context);
  const registry = new ToolRegistry();
  const capture = registration(join(root, "missing.png"));
  registry.register(capture);
  const executionStore = new ToolExecutionStore();
  const { messages } = await makeLoop(root, registry, executionStore).execute([
    { protocol: "bush.tool_call.v1", id: "capture", name: "capture", argumentsText: "{}" },
  ], { round: 1, assistantMessageId: "assistant" });
  assert.equal(messages[1].images, undefined);
  assert.equal(JSON.parse(messages[1].content).imageInputErrors[0].code, "image_input_unavailable");
  assert.equal(executionStore.get("session", "turn", "capture").outcome, "returned");
  assert.deepEqual(JSON.parse(messages[0].content), capture.execute());
});

test("incomplete injection reports the actual Tool error and succeeds when the writer finishes", async (context) => {
  const { root, source } = await imageFixture(context);
  const registry = new ToolRegistry();
  registerExtendedBuiltins(registry, { dataRoot: root });
  const loop = makeLoop(root, registry);
  const run = (id) => loop.execute([{
    id, name: "inject_image_input", argumentsText: JSON.stringify({ url: source, detail: "high" }),
  }], {
    round: 1, assistantMessageId: "assistant_" + id,
    request: {
      protocol: "bush.model_request.v1", requestId: "request", sessionId: "session", turnId: "turn",
      model: "fixture", messages: [], tools: [registry.resolve("inject_image_input").definition],
      metadata: { workspaceDir: root },
    }, contextMessages: [],
  });
  await writeFile(source, png.subarray(0, -12));
  const failed = await run("failed");
  assert.equal(failed.messages.length, 1);
  assert.equal(JSON.parse(failed.messages[0].content).runtimeError.code, "image_input_not_ready");
  await writeFile(source, png);
  const succeeded = await run("succeeded");
  assert.deepEqual(JSON.parse(succeeded.messages[0].content), { queued: true, attached_images: 1 });
  assert.equal(succeeded.messages[0].content.includes(source), false);
  await rm(source);
  assert.deepEqual(await readFile(succeeded.messages[1].images[0].url), png);
  assert.equal(succeeded.messages[1].images[0].detail, "high");
});

function makeLoop(root, registry, executionStore) {
  return new RuntimeToolLoop({
    eventLog: new InMemoryRuntimeEventLog(),
    identity: { requestId: "request", sessionId: "session", turnId: "turn" },
    registry, executionStore, modelImages: new ModelImageStore(root),
  });
}

function registration(path) {
  return {
    definition: {
      name: "capture", description: "fixture",
      inputSchema: { type: "object", additionalProperties: false },
    },
    manifest: {
      effect_kind: "observation", operation: "desktop.capture",
      risk: "low", owner: "test", dispatch_scope: "process", mutating: false,
    },
    executionChannel: "desktop",
    decodeInput: (input) => input,
    execute: () => ({
      path,
      artifacts: [{
        artifact_id: "artifact_capture", type: "image", path,
        media_type: "image/png", display: "inline", metadata: { model_input: true },
      }, {
        artifact_id: "artifact_not_for_model", type: "image", path: "ignored-not-existing.png",
        metadata: { model_input: false },
      }],
    }),
  };
}
