import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BotConfigStore,
  BotSupervisor,
  PRODUCT_HOST_IPC_PROTOCOL,
  ProductHost,
} from "../dist/index.js";

test("exposes typed Product Host commands without an HTTP route parser", async () => {
  const root = await mkdtemp(join(tmpdir(), "cardbush-product-host-"));
  const config = new BotConfigStore(join(root, "bots.json"));
  const bots = new BotSupervisor({ configStore: config, dataDir: root });
  const host = new ProductHost(config, bots);
  const update = await host.execute({
    protocol: PRODUCT_HOST_IPC_PROTOCOL,
    kind: "bot.config.update",
    platform: "discord",
    config: { application_id: "app", bot_token: "secret" },
  });
  assert.equal(update.ok, true);
  assert.equal(update.value.config.bot_token, "••••cret");

  const list = await host.execute({ protocol: PRODUCT_HOST_IPC_PROTOCOL, kind: "bots.list" });
  assert.equal(list.ok, true);
  assert.equal(list.value.bots.length, 4);
});

test("rejects protocol mismatch and unavailable optional capability as facts", async () => {
  const root = await mkdtemp(join(tmpdir(), "cardbush-product-host-"));
  const config = new BotConfigStore(join(root, "bots.json"));
  const host = new ProductHost(config, new BotSupervisor({ configStore: config, dataDir: root }));
  const mismatch = await host.execute({ protocol: "old", kind: "bots.list" });
  assert.deepEqual(mismatch, {
    protocol: PRODUCT_HOST_IPC_PROTOCOL,
    ok: false,
    error: {
      code: "product_host_protocol_mismatch",
      message: `Expected ${PRODUCT_HOST_IPC_PROTOCOL}`,
    },
  });
  const login = await host.execute({
    protocol: PRODUCT_HOST_IPC_PROTOCOL,
    kind: "weixin.login.start",
  });
  assert.equal(login.ok, false);
  assert.equal(login.error.code, "weixin_account_host_unavailable");
});
