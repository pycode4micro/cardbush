import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FeishuLongConnectionAdapter } from "../dist/index.js";

test("Feishu adapter consumes official long-connection facts and sends Runtime output", async () => {
  const replies = [];
  const reactions = [];
  const envelopes = [];
  let handler;
  const connector = {
    async start(next) { handler = next; },
    async stop() {},
    status() { return { state: "connected" }; },
    async replyText(messageId, text) { replies.push({ messageId, text }); },
    async addReaction(messageId, emoji) { reactions.push({ messageId, emoji }); },
  };
  const adapter = new FeishuLongConnectionAdapter({
    platform: "feishu",
    config: {
      app_id: "app",
      app_secret: "secret",
      ack_mode: "reaction",
      ack_reaction_emoji: "OK",
      allowed_user_ids: ["user-1"],
      allowed_channel_ids: ["chat-1"],
    },
    dataDir: "C:\\tmp\\feishu",
    signal: new AbortController().signal,
    async log() {},
  }, {
    backend: {
      async respond(envelope) {
        envelopes.push(envelope);
        return { text: "done" };
      },
    },
    createConnector: () => connector,
  });
  await adapter.start();
  await handler({
    event_id: "event-1",
    sender: { sender_type: "user", sender_id: { open_id: "user-1" } },
    message: {
      message_id: "message-1",
      chat_id: "chat-1",
      chat_type: "group",
      message_type: "text",
      content: JSON.stringify({ text: "@_user_1 inspect" }),
      mentions: [{ key: "@_user_1" }],
    },
  });
  await handler({
    event_id: "event-1",
    sender: { sender_type: "user", sender_id: { open_id: "user-1" } },
    message: {
      message_id: "message-1",
      chat_id: "chat-1",
      chat_type: "group",
      message_type: "text",
      content: JSON.stringify({ text: "duplicate" }),
      mentions: [{ key: "@_user_1" }],
    },
  });
  assert.equal(envelopes.length, 1);
  assert.equal(envelopes[0].text, "inspect");
  assert.deepEqual(reactions, [{ messageId: "message-1", emoji: "OK" }]);
  assert.deepEqual(replies, [{ messageId: "message-1", text: "done" }]);
  assert.equal(adapter.status().healthStatus, "healthy");
  await adapter.stop();
});

test("Feishu adapter ignores unauthorized and unmentioned group messages", async () => {
  let handler;
  let backendCalls = 0;
  const adapter = new FeishuLongConnectionAdapter({
    platform: "feishu",
    config: {
      allowed_user_ids: ["allowed"],
      allowed_channel_ids: [],
      ack_mode: "none",
    },
    dataDir: "C:\\tmp\\feishu",
    signal: new AbortController().signal,
    async log() {},
  }, {
    backend: { async respond() { backendCalls += 1; return { text: "never" }; } },
    createConnector: () => ({
      async start(next) { handler = next; },
      async stop() {},
      status() { return { state: "connected" }; },
      async replyText() {},
      async addReaction() {},
    }),
  });
  await adapter.start();
  await handler(event("denied", "p2p", []));
  await handler(event("allowed", "group", []));
  assert.equal(backendCalls, 0);
  await adapter.stop();
});

test("Feishu adapter materializes explicit image resources for the Runtime", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "cardbush-feishu-media-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  let handler;
  const envelopes = [];
  const adapter = new FeishuLongConnectionAdapter({
    platform: "feishu",
    config: { ack_mode: "none" },
    dataDir: root,
    signal: new AbortController().signal,
    async log() {},
  }, {
    backend: { async respond(envelope) { envelopes.push(envelope); return { text: "done" }; } },
    createConnector: () => ({
      async start(next) { handler = next; },
      async stop() {},
      status() { return { state: "connected" }; },
      async replyText() {},
      async addReaction() {},
      async downloadResource(_messageId, _key, _type, path) { await writeFile(path, "image"); },
    }),
  });
  await adapter.start();
  await handler({
    sender: { sender_type: "user", sender_id: { open_id: "user" } },
    message: {
      message_id: "message-image",
      chat_id: "chat",
      chat_type: "p2p",
      message_type: "image",
      content: JSON.stringify({ image_key: "image-key" }),
    },
  });
  assert.equal(envelopes.length, 1);
  assert.equal(envelopes[0].text, "The user sent the attached resources.");
  assert.equal(envelopes[0].images.length, 1);
  assert.equal(envelopes[0].images[0].startsWith(root), true);
  await adapter.stop();
});

function event(userId, chatType, mentions) {
  return {
    sender: { sender_type: "user", sender_id: { open_id: userId } },
    message: {
      message_id: `message-${userId}-${chatType}`,
      chat_id: "chat-1",
      chat_type: chatType,
      message_type: "text",
      content: JSON.stringify({ text: "hello" }),
      mentions,
    },
  };
}
