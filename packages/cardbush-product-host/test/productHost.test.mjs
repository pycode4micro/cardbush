import assert from "node:assert/strict";
import test from "node:test";

import {
  PRODUCT_HOST_IPC_PROTOCOL,
  ProductHost,
} from "../dist/index.js";

test("rejects protocol mismatch and unavailable optional capability as facts", async () => {
  const host = new ProductHost();
  const mismatch = await host.execute({ protocol: "old", kind: "models.get" });
  assert.deepEqual(mismatch, {
    protocol: PRODUCT_HOST_IPC_PROTOCOL,
    ok: false,
    error: {
      code: "product_host_protocol_mismatch",
      message: `Expected ${PRODUCT_HOST_IPC_PROTOCOL}`,
    },
  });
  const models = await host.execute({
    protocol: PRODUCT_HOST_IPC_PROTOCOL,
    kind: "models.get",
  });
  assert.equal(models.ok, false);
  assert.equal(models.error.code, "product_model_host_unavailable");
});

test("reads and updates model configuration through a typed host", async () => {
  const snapshots = [];
  const host = new ProductHost(
    {
      async get() { return { defaultModelId: "", models: [] }; },
      async update(value) { snapshots.push(value); return { defaultModelId: "vision", models: [] }; },
      async resolve(modelId) { return { modelId, binding: { bindingId: modelId, revision: "1" } }; },
    },
  );
  const initial = await host.execute({
    protocol: PRODUCT_HOST_IPC_PROTOCOL,
    kind: "models.get",
  });
  assert.equal(initial.ok, true);
  const result = await host.execute({
    protocol: PRODUCT_HOST_IPC_PROTOCOL,
    kind: "models.update",
    config: { defaultModelId: "vision", models: [{ id: "vision", apiKey: "secret" }] },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(snapshots, [{
    defaultModelId: "vision",
    models: [{ id: "vision", apiKey: "secret" }],
  }]);
  const resolved = await host.execute({
    protocol: PRODUCT_HOST_IPC_PROTOCOL,
    kind: "model.resolve",
    modelId: "vision",
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.value.modelId, "vision");
});

test("reads and updates CardBush Apps through the independent apps host", async () => {
  const updates = [];
  const host = new ProductHost(undefined, undefined, {
    async get() { return { serviceEnabled: true, plugins: [] }; },
    async update(value) { updates.push(value); return { ...value, revision: 2 }; },
  });
  const initial = await host.execute({
    protocol: PRODUCT_HOST_IPC_PROTOCOL,
    kind: "apps.get",
  });
  assert.equal(initial.ok, true);
  assert.equal(initial.value.serviceEnabled, true);
  const updated = await host.execute({
    protocol: PRODUCT_HOST_IPC_PROTOCOL,
    kind: "apps.update",
    config: { serviceEnabled: false, plugins: [] },
  });
  assert.equal(updated.ok, true);
  assert.deepEqual(updates, [{ serviceEnabled: false, plugins: [] }]);
});

test("accepts Teams and Agent Profiles as reset categories", async () => {
  const resetCalls = [];
  const host = new ProductHost(undefined, {
    async clearConversations() { return {}; },
    async clearLogsCache() { return {}; },
    async runtimeAssetPlan() { return {}; },
    async resetRuntimeAssets(categories) { resetCalls.push(categories); return { categories }; },
    async diagnostics() { return {}; },
  });
  const result = await host.execute({
    protocol: PRODUCT_HOST_IPC_PROTOCOL,
    kind: "maintenance.runtime_assets.reset",
    categories: ["agent_profiles", "teams"],
    confirm: true,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(resetCalls, [["agent_profiles", "teams"]]);
});

test("reads the shared Subagent and Team-child baseline through the Product Host", async () => {
  const host = new ProductHost(undefined, undefined, undefined, undefined, {
    async get() {
      return {
        protocol: "cardbush.subagent_configuration.v1",
        permissionRouting: "user",
        childPermissionMode: "task_free",
        model: { mode: "inherit" },
        disabledTools: ["subagent"],
      };
    },
  });
  const result = await host.execute({
    protocol: PRODUCT_HOST_IPC_PROTOCOL,
    kind: "subagents.get",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.disabledTools, ["subagent"]);
});
