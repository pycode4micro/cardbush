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
  LinkedConversationBackend,
  SessionLinkStore,
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

test("reads and updates model configuration through a typed host", async () => {
  const root = await mkdtemp(join(tmpdir(), "cardbush-product-host-"));
  const config = new BotConfigStore(join(root, "bots.json"));
  const snapshots = [];
  const host = new ProductHost(
    config,
    new BotSupervisor({ configStore: config, dataDir: root }),
    undefined,
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

test("issues and consumes a durable Bot session link without an HTTP service", async () => {
  const root = await mkdtemp(join(tmpdir(), "cardbush-product-host-"));
  const links = new SessionLinkStore(join(root, "session-links.json"));
  const calls = [];
  const backend = new LinkedConversationBackend({
    async respond(envelope) {
      calls.push(envelope);
      return { text: envelope.sessionId };
    },
  }, links);
  const issued = await links.issue({
    sessionId: "local-session",
    platform: "telegram",
    expiresSeconds: 900,
  });
  const envelope = {
    platform: "telegram",
    sessionId: "telegram:channel:user",
    userId: "user",
    channelId: "channel",
    text: issued.code.toLowerCase(),
    rawEvent: {},
  };
  const linked = await backend.respond(envelope);
  assert.equal(linked.metadata.linked, true);
  assert.equal(calls.length, 0);
  const continued = await backend.respond({ ...envelope, text: "continue" });
  assert.equal(continued.text, "local-session");
  assert.equal(calls[0].sessionId, "local-session");
});

test("serializes concurrent session-link updates without losing issued codes", async () => {
  const root = await mkdtemp(join(tmpdir(), "cardbush-product-host-"));
  const path = join(root, "session-links.json");
  const issuer = new SessionLinkStore(path);
  const issued = await Promise.all(Array.from({ length: 24 }, (_, index) =>
    issuer.issue({
      sessionId: `local-${index}`,
      platform: "discord",
      expiresSeconds: 900,
    })));
  assert.equal(new Set(issued.map((item) => item.code)).size, issued.length);

  const resolver = new SessionLinkStore(path);
  const resolved = await Promise.all(issued.map((item, index) => resolver.resolve({
    platform: "discord",
    sessionId: `discord:channel:${index}`,
    userId: `user-${index}`,
    channelId: "channel",
    text: item.code,
    rawEvent: {},
  })));
  assert.deepEqual(resolved.map((item) => item.sessionId),
    issued.map((_, index) => `local-${index}`));
  assert.ok(resolved.every((item) => item.linked));
});

test("validates the typed session-link Product Host command", async () => {
  const root = await mkdtemp(join(tmpdir(), "cardbush-product-host-"));
  const config = new BotConfigStore(join(root, "bots.json"));
  const requests = [];
  const host = new ProductHost(
    config,
    new BotSupervisor({ configStore: config, dataDir: root }),
    undefined,
    undefined,
    { async issue(input) { requests.push(input); return { code: "ABC12345" }; } },
  );
  const result = await host.execute({
    protocol: PRODUCT_HOST_IPC_PROTOCOL,
    kind: "session_link.create",
    sessionId: "local-session",
    platform: "TELEGRAM",
    expiresSeconds: 900,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(requests, [{
    sessionId: "local-session",
    platform: "telegram",
    expiresSeconds: 900,
  }]);
  const invalid = await host.execute({
    protocol: PRODUCT_HOST_IPC_PROTOCOL,
    kind: "session_link.create",
    sessionId: "local-session",
    expiresSeconds: 1,
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, "invalid_product_host_command");
});
