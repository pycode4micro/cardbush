import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TelegramPollingAdapter } from "../dist/index.js";

test("Telegram adapter polls, applies identity facts, and advances its durable offset", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "cardbush-telegram-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const controller = new AbortController();
  const sent = [];
  const envelopes = [];
  let polls = 0;
  const adapter = new TelegramPollingAdapter({
    platform: "telegram",
    config: {
      bot_token: "token",
      api_base: "https://telegram.test",
      allowed_user_ids: ["10"],
      allowed_channel_ids: ["20"],
      poll_timeout_seconds: 1,
    },
    dataDir: root,
    signal: controller.signal,
    async log() {},
  }, {
    backend: {
      async respond(envelope) { envelopes.push(envelope); return { text: "done" }; },
    },
    async fetch(url, init) {
      const method = String(url).split("/").at(-1);
      if (method === "getMe") return response({ ok: true, result: { id: 99, username: "cardbush" } });
      if (method === "sendMessage") {
        sent.push(JSON.parse(init.body));
        return response({ ok: true, result: {} });
      }
      polls += 1;
      if (polls === 1) {
        return response({
          ok: true,
          result: [
            { update_id: 4, message: { message_id: 1, text: "denied", chat: { id: 20, type: "private" }, from: { id: 11 } } },
            { update_id: 5, message: { message_id: 2, text: "hello", chat: { id: 20, type: "private" }, from: { id: 10 } } },
          ],
        });
      }
      return pendingResponse(controller.signal);
    },
  });
  await adapter.start();
  await eventually(() => sent.length === 1);
  assert.equal(envelopes.length, 1);
  assert.equal(envelopes[0].text, "hello");
  assert.deepEqual(sent[0], { chat_id: "20", text: "done" });
  await eventually(async () => JSON.parse(await readFile(join(root, "telegram-state.json"), "utf8")).offset === 6);
  controller.abort();
  await adapter.stop();
});

test("Telegram group messages require a factual Bot mention", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "cardbush-telegram-group-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const controller = new AbortController();
  const envelopes = [];
  let polls = 0;
  const adapter = new TelegramPollingAdapter({
    platform: "telegram",
    config: { bot_token: "token", api_base: "https://telegram.test", poll_timeout_seconds: 1 },
    dataDir: root,
    signal: controller.signal,
    async log() {},
  }, {
    backend: { async respond(envelope) { envelopes.push(envelope); return { text: "done" }; } },
    async fetch(url) {
      const method = String(url).split("/").at(-1);
      if (method === "getMe") return response({ ok: true, result: { id: 99, username: "cardbush" } });
      if (method === "sendMessage") return response({ ok: true, result: {} });
      polls += 1;
      if (polls === 1) return response({ ok: true, result: [
        { update_id: 1, message: { message_id: 1, text: "ignore", chat: { id: -1, type: "group" }, from: { id: 10 } } },
        { update_id: 2, message: { message_id: 2, text: "@cardbush run", chat: { id: -1, type: "group" }, from: { id: 10 } } },
      ] });
      return pendingResponse(controller.signal);
    },
  });
  await adapter.start();
  await eventually(() => envelopes.length === 1);
  assert.equal(envelopes[0].text, "run");
  controller.abort();
  await adapter.stop();
});

test("Telegram adapter downloads explicit photo facts before starting the Runtime Turn", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "cardbush-telegram-media-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const controller = new AbortController();
  const envelopes = [];
  let polls = 0;
  const adapter = new TelegramPollingAdapter({
    platform: "telegram",
    config: { bot_token: "token", api_base: "https://telegram.test", poll_timeout_seconds: 1 },
    dataDir: root,
    signal: controller.signal,
    async log() {},
  }, {
    backend: { async respond(envelope) { envelopes.push(envelope); return { text: "done" }; } },
    async fetch(url) {
      const value = String(url);
      if (value.endsWith("/getMe")) return response({ ok: true, result: { id: 99, username: "cardbush" } });
      if (value.endsWith("/getFile")) return response({ ok: true, result: { file_path: "photos/photo.jpg" } });
      if (value.includes("/file/bottoken/")) {
        return new Response(Buffer.from([0xff, 0xd8, 0xff]), { status: 200, headers: { "content-type": "image/jpeg" } });
      }
      if (value.endsWith("/sendMessage")) return response({ ok: true, result: {} });
      polls += 1;
      if (polls === 1) return response({ ok: true, result: [{
        update_id: 1,
        message: {
          message_id: 1,
          caption: "inspect",
          photo: [{ file_id: "small", file_size: 1 }, { file_id: "large", file_size: 3 }],
          chat: { id: 20, type: "private" },
          from: { id: 10 },
        },
      }] });
      return pendingResponse(controller.signal);
    },
  });
  await adapter.start();
  await eventually(() => envelopes.length === 1);
  assert.equal(envelopes[0].text, "inspect");
  assert.equal(envelopes[0].images.length, 1);
  assert.equal(envelopes[0].images[0].startsWith(root), true);
  controller.abort();
  await adapter.stop();
});

function response(payload) {
  return new Response(JSON.stringify(payload), { status: 200 });
}

function pendingResponse(signal) {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

async function eventually(predicate) {
  const deadline = Date.now() + 2_500;
  while (Date.now() < deadline) {
    try { if (await predicate()) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition was not reached");
}
