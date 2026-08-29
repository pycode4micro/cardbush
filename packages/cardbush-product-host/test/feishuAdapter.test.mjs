import assert from "node:assert/strict";
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
