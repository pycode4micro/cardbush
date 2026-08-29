import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BotConfigStore } from "../dist/index.js";

test("persists product-owned bot configuration and never exposes secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "cardbush-product-host-"));
  const path = join(root, "bots.json");
  const store = new BotConfigStore(path);
  await store.write("feishu", {
    enabled: true,
    app_id: "app",
    app_secret: "secret-value",
    allowed_user_ids: ["a", "a", " b "],
  });
  const payload = await store.publicPayload("feishu");
  assert.equal(payload.config.app_secret, "••••alue");
  assert.deepEqual(payload.config.allowed_user_ids, ["a", "b"]);
  assert.equal(payload.secrets.app_secret.configured, true);
  assert.match(await readFile(path, "utf8"), /secret-value/);

  await store.write("feishu", { app_secret: "••••alue" });
  assert.equal((await store.read("feishu")).app_secret, "secret-value");
});

test("rejects fields and permission values outside the explicit product contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "cardbush-product-host-"));
  const store = new BotConfigStore(join(root, "bots.json"));
  await assert.rejects(() => store.write("weixin", { unknown: true }), /Unsupported/);
  await assert.rejects(
    () => store.write("weixin", { permission_mode: "magic" }),
    /task_free, user_free, or all_free/,
  );
});

test("serializes concurrent writes and exposes corrupt persisted state", async () => {
  const root = await mkdtemp(join(tmpdir(), "cardbush-product-host-"));
  const path = join(root, "bots.json");
  const store = new BotConfigStore(path);
  await Promise.all([
    store.write("feishu", { app_id: "feishu-app" }),
    store.write("discord", { application_id: "discord-app" }),
  ]);
  assert.equal((await store.read("feishu")).app_id, "feishu-app");
  assert.equal((await store.read("discord")).application_id, "discord-app");

  await import("node:fs/promises").then(({ writeFile }) => writeFile(path, "{broken", "utf8"));
  await assert.rejects(() => store.read("weixin"), /not valid JSON/);
});
