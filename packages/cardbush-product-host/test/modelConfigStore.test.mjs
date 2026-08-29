import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
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
