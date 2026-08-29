import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  WeixinAccountManager,
  WeixinAccountStore,
  WeixinPollingAdapter,
} from "../dist/index.js";

test("Weixin account store preserves concurrent state and rejects path traversal", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "cardbush-weixin-store-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new WeixinAccountStore(root);
  await store.save({ accountId: "account-1", token: "token", baseUrl: "https://weixin.test" });
  await Promise.all([
    store.setContextToken("account-1", "user-1", "context-1"),
    store.setContextToken("account-1", "user-2", "context-2"),
    store.saveSync("account-1", "sync-1"),
    store.saveHandledIds("account-1", { "message-1": 1 }),
  ]);
  assert.equal(await store.contextToken("account-1", "user-1"), "context-1");
  assert.equal(await store.contextToken("account-1", "user-2"), "context-2");
  assert.equal(await store.loadSync("account-1"), "sync-1");
  assert.deepEqual(await store.handledIds("account-1"), { "message-1": 1 });
  await assert.rejects(() => store.load("../outside"), /Invalid Weixin account id/);
  await assert.rejects(() => store.remove("..\\outside"), /Invalid Weixin account id/);
  JSON.parse(await readFile(join(root, "accounts", "account-1.json"), "utf8"));
});

test("Weixin QR login persists confirmed credentials without exposing the token", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "cardbush-weixin-login-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new WeixinAccountStore(root);
  const manager = new WeixinAccountManager({
    store,
    async config() { return { login_timeout_seconds: 5 }; },
    createClient() {
      return {
        async startQrLogin() { return { qrcode: "qr-token", qrcodeUrl: "https://qr.test/code" }; },
        async qrStatus() {
          return {
            status: "confirmed",
            ilink_bot_id: "account-1",
            ilink_user_id: "owner-1",
            bot_token: "secret",
            baseurl: "https://weixin.test",
          };
        },
      };
    },
  });
  const started = await manager.startLogin();
  assert.equal(started.status, "waiting");
  assert.equal(started.qrcode_url, "https://qr.test/code");
  await eventually(async () => (await manager.loginStatus(started.login_id)).status === "confirmed");
  const status = await manager.loginStatus(started.login_id);
  assert.equal(status.account.account_id, "account-1");
  assert.equal("token" in status.account, false);
  assert.equal((await store.load("account-1")).token, "secret");
});

test("Weixin polling accepts authorized text once and persists its cursor", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "cardbush-weixin-poll-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new WeixinAccountStore(root);
  await store.save({ accountId: "account-1", token: "token", baseUrl: "https://weixin.test" });
  const controller = new AbortController();
  const envelopes = [];
  const sent = [];
  let updateCalls = 0;
  const client = {
    async updates(_account, _sync, signal) {
      updateCalls += 1;
      if (updateCalls === 1) {
        return {
          ret: 0,
          get_updates_buf: "sync-2",
          msgs: [message("message-1", "user-1", "hello", "context-1")],
        };
      }
      return untilAbort(signal);
    },
    async sendText(input) { sent.push(input); },
  };
  const adapter = new WeixinPollingAdapter(botContext(controller, {
    allowed_user_ids: ["user-1"],
    allowed_channel_ids: ["account-1"],
  }), {
    store,
    createClient: () => client,
    backend: {
      async respond(envelope) {
        envelopes.push(envelope);
        return { text: "done" };
      },
    },
  });
  await adapter.start();
  await eventually(async () => sent.length === 1 && await store.loadSync("account-1") === "sync-2");
  assert.equal(envelopes.length, 1);
  assert.equal(envelopes[0].text, "hello");
  assert.equal(sent[0].text, "done");
  assert.equal(await store.loadSync("account-1"), "sync-2");
  assert.ok((await store.handledIds("account-1"))["message-1"]);
  controller.abort();
  await adapter.stop();
});

test("Weixin polling ignores unauthorized and already handled messages", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "cardbush-weixin-deny-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new WeixinAccountStore(root);
  await store.save({ accountId: "account-1", token: "token", baseUrl: "https://weixin.test" });
  await store.saveHandledIds("account-1", { duplicate: Date.now() });
  const controller = new AbortController();
  let backendCalls = 0;
  let updateCalls = 0;
  const adapter = new WeixinPollingAdapter(botContext(controller, {
    allowed_user_ids: ["allowed"],
  }), {
    store,
    createClient: () => ({
      async updates(_account, _sync, signal) {
        updateCalls += 1;
        if (updateCalls === 1) {
          return {
            ret: 0,
            get_updates_buf: "sync-3",
            msgs: [
              message("denied", "other", "no"),
              message("duplicate", "allowed", "again"),
            ],
          };
        }
        return untilAbort(signal);
      },
      async sendText() { assert.fail("unauthorized or duplicate message was delivered"); },
    }),
    backend: { async respond() { backendCalls += 1; return { text: "never" }; } },
  });
  await adapter.start();
  await eventually(async () => await store.loadSync("account-1") === "sync-3");
  assert.equal(backendCalls, 0);
  controller.abort();
  await adapter.stop();
});

test("Weixin polling exposes session expiration as a factual runtime state", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "cardbush-weixin-expired-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new WeixinAccountStore(root);
  await store.save({ accountId: "account-1", token: "token", baseUrl: "https://weixin.test" });
  const controller = new AbortController();
  const adapter = new WeixinPollingAdapter(botContext(controller), {
    store,
    createClient: () => ({
      async updates() { return { ret: -14 }; },
      async sendText() {},
    }),
    backend: { async respond() { return { text: "never" }; } },
  });
  await adapter.start();
  await eventually(() => adapter.status().healthStatus === "authentication_expired");
  assert.equal(adapter.status().errorCode, "weixin_session_expired");
  assert.equal(adapter.status().requiresReauthentication, true);
  controller.abort();
  await adapter.stop();
});

function botContext(controller, config = {}) {
  return {
    platform: "weixin",
    config,
    dataDir: "unused",
    signal: controller.signal,
    async log() {},
  };
}

function message(messageId, userId, text, contextToken = "") {
  return {
    message_id: messageId,
    from_user_id: userId,
    context_token: contextToken,
    item_list: [{ type: 1, text_item: { text } }],
  };
}

function untilAbort(signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

async function eventually(predicate) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition was not reached");
}
