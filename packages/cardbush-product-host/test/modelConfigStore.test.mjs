import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ProductModelConfigStore } from "../dist/index.js";

test("persists model secrets in the Product Host and only exposes masked facts", async () => {
  const root = await mkdtemp(join(tmpdir(), "cardbush-model-config-"));
  const path = join(root, "models.json");
  const store = new ProductModelConfigStore(path);
  const created = await store.write({
    defaultModelId: "vision",
    models: [{
      id: "vision",
      provider: "volcengine",
      modelName: "deepseek-v4-vision-exp",
      apiKey: "secret-provider-key",
      baseUrl: "https://example.test/v1",
    }],
  });
  assert.equal(created.models[0].apiKey, "secret-provider-key");
  const publicPayload = store.publicPayload(created);
  assert.equal(publicPayload.models[0].apiKey, "");
  assert.equal(publicPayload.models[0].hasApiKey, true);
  assert.equal(JSON.stringify(publicPayload).includes("secret-provider-key"), false);
  assert.equal((await readFile(path, "utf8")).includes("secret-provider-key"), true);

  const preserved = await store.write({
    defaultModelId: "vision",
    models: [{
      id: "vision",
      provider: "volcengine",
      modelName: "deepseek-v4-vision-exp",
      apiKey: "",
      baseUrl: "https://example.test/v1",
    }],
  });
  assert.equal(preserved.models[0].apiKey, "secret-provider-key");
});

test("imports only missing credentials from an identity-matched legacy snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "cardbush-model-migration-"));
  const path = join(root, "models.json");
  const store = new ProductModelConfigStore(path);
  await store.write({
    defaultModelId: "vision",
    models: [{
      id: "vision",
      provider: "deepseek",
      modelName: "deepseek-v4-flash-vision-exp",
      apiKey: "",
      baseUrl: "https://api.deepseek.com",
    }, {
      id: "existing",
      provider: "volcengine",
      modelName: "glm-5.3",
      apiKey: "current-secret",
      baseUrl: "https://ark.example.test/v1",
    }, {
      id: "different-endpoint",
      provider: "deepseek",
      modelName: "deepseek-v4-flash-vision-exp",
      apiKey: "",
      baseUrl: "https://untrusted.example.test/v1",
    }],
  });

  const imported = await store.migrateMissingCredentials({
    version: 1,
    default_model_id: "vision",
    models: [{
      id: "vision",
      provider: "deepseek",
      model: "deepseek-v4-flash-vision-exp",
      api_key: "legacy-vision-secret",
      base_url: "https://api.deepseek.com/",
    }, {
      id: "existing",
      provider: "volcengine",
      model: "glm-5.3",
      api_key: "stale-secret",
      base_url: "https://ark.example.test/v1",
    }],
  });

  assert.equal(imported, 1);
  const snapshot = await store.read();
  assert.equal(snapshot.models[0].apiKey, "legacy-vision-secret");
  assert.equal(snapshot.models[1].apiKey, "current-secret");
  assert.equal(snapshot.models[2].apiKey, "");
  assert.equal(JSON.stringify(store.publicPayload(snapshot)).includes("legacy-vision-secret"), false);
});

test("rejects impossible token limits in updates and stored snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "cardbush-model-token-limits-"));
  const path = join(root, "models.json");
  const store = new ProductModelConfigStore(path);
  await assert.rejects(() => store.write({
    defaultModelId: "invalid",
    models: [{
      id: "invalid",
      provider: "deepseek",
      modelName: "deepseek-v4-flash-vision-exp",
      apiKey: "secret",
      maxContextTokens: 256000,
      maxCompletionTokens: 384000,
    }],
  }), /Model invalid: maxOutputTokens \(384000\) must be less than maxContextTokens \(256000\)/);

  await writeFile(path, JSON.stringify({
    version: 1,
    defaultModelId: "legacy",
    models: [{
      id: "legacy",
      provider: "deepseek",
      model: "deepseek-v4-flash-vision-exp",
      apiKey: "secret",
      maxContextTokens: 256000,
      maxOutputTokens: 384000,
    }],
  }));
  await assert.rejects(
    () => store.read(),
    /Model legacy: maxOutputTokens \(384000\) must be less than maxContextTokens \(256000\)/,
  );
});
