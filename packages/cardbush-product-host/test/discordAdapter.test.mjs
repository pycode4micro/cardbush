import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DiscordGatewayAdapter } from "../dist/index.js";

test("Discord adapter connects, enforces identity facts, downloads media, deduplicates, and delivers Agent output", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "cardbush-discord-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const envelopes = [];
  let socket;
  const controller = new AbortController();
  const adapter = new DiscordGatewayAdapter({
    platform: "discord",
    config: {
      api_base: "https://discord.test/api/v10",
      bot_token: "secret",
      gateway_intents: 37377,
      allowed_user_ids: ["user-1"],
      allowed_channel_ids: ["channel-1"],
    },
    dataDir: root,
    signal: controller.signal,
    async log() {},
  }, {
    backend: {
      async respond(envelope) {
        envelopes.push(envelope);
        return { text: "done" };
      },
    },
    async fetch(url, init = {}) {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/gateway/bot")) {
        return response(200, { url: "wss://gateway.test" });
      }
      if (String(url) === "https://media.test/screen.png") {
        return new Response(Buffer.from([137, 80, 78, 71]), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      return response(200, { id: "response" });
    },
    createWebSocket(url) {
      socket = new FakeSocket(url);
      queueMicrotask(() => socket.message({ op: 10, d: { heartbeat_interval: 60_000 } }));
      return socket;
    },
    retryDelayMs: 1,
    connectTimeoutMs: 100,
  });

  await adapter.start();
  socket.message({ op: 0, t: "READY", d: { user: { id: "bot-1" } } });
  socket.message({
    op: 0,
    t: "MESSAGE_CREATE",
    d: {
      id: "message-1",
      channel_id: "channel-1",
      channel_type: 0,
      content: "<@bot-1> inspect this",
      mentions: [{ id: "bot-1" }],
      attachments: [{ url: "https://media.test/screen.png", filename: "screen.png", content_type: "image/png" }],
      author: { id: "user-1", bot: false },
    },
  });
  socket.message({
    op: 0,
    t: "MESSAGE_CREATE",
    d: {
      id: "message-1",
      channel_id: "channel-1",
      channel_type: 0,
      content: "<@bot-1> duplicate",
      mentions: [{ id: "bot-1" }],
      author: { id: "user-1", bot: false },
    },
  });
  await eventually(() => calls.some((call) => call.url.includes("/channels/channel-1/messages")));
  assert.equal(envelopes.length, 1);
  assert.equal(envelopes[0].text, "inspect this");
  assert.equal(envelopes[0].images.length, 1);
  assert.equal(envelopes[0].images[0].startsWith(root), true);
  const delivery = calls.find((call) => call.url.includes("/channels/channel-1/messages"));
  assert.equal(JSON.parse(delivery.init.body).content, "done");
  assert.equal(adapter.status().healthStatus, "healthy");
  controller.abort();
  await adapter.stop();
});

class FakeSocket {
  static OPEN = 1;
  readyState = FakeSocket.OPEN;
  #listeners = new Map();
  sent = [];

  constructor(url) { this.url = url; }

  addEventListener(kind, listener) {
    const listeners = this.#listeners.get(kind) ?? [];
    listeners.push(listener);
    this.#listeners.set(kind, listeners);
  }

  send(value) { this.sent.push(value); }

  close(code = 1000) {
    this.readyState = 3;
    this.#emit("close", { code });
  }

  message(value) { this.#emit("message", { data: JSON.stringify(value) }); }

  #emit(kind, event) {
    for (const listener of this.#listeners.get(kind) ?? []) listener(event);
  }
}

function response(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function eventually(predicate) {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition was not reached");
}
