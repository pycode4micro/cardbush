import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  FileSessionEventPersistence, InMemoryRuntimeHost, SessionStore, ToolRegistry,
} from "@cardbush/bush-runtime";
import { OpenAIResponsesProvider, resolveLocalImageInputs } from "../dist/index.js";
import { imageFixture, png } from "../../bush-runtime/test/helpers/modelImages.mjs";

const NOW = "2026-09-05T08:00:00.000Z";

test("real Tool loop, session journal and provider projection retain deleted-image bytes across restart", async (context) => {
  const { root, source } = await imageFixture(context);
  const journalRoot = join(root, "sessions");
  const firstJournal = new FileSessionEventPersistence({ root: journalRoot });
  const registry = new ToolRegistry();
  registry.register({
    definition: { name: "delete_source", description: "fixture", inputSchema: { type: "object" } },
    manifest: { effect_kind: "local_state", operation: "file.delete", risk: "low", owner: "test", dispatch_scope: "process", mutating: true },
    decodeInput: (input) => input,
    execute: async () => { await rm(source); return { deleted: true }; },
  });
  const projected = [];
  const host = new InMemoryRuntimeHost({
    dataRoot: root,
    toolRegistry: registry,
    registerDefaultWorkspaceTools: false,
    sessionStore: new SessionStore({ persistence: firstJournal }),
    provider: {
      async *stream(request) {
        projected.push(await resolveLocalImageInputs(request));
        yield event(request, 0, "response_started");
        if (projected.length <= 2) {
          yield event(request, 1, "tool_call_delta", {
            index: 0, toolCallId: "call_" + projected.length,
            nameDelta: projected.length === 1 ? "inject_image_input" : "delete_source",
            argumentsDelta: JSON.stringify(projected.length === 1 ? { url: source, detail: "high" } : {}),
          });
          yield event(request, 2, "response_completed", { finishReason: "tool_calls" });
        } else {
          yield event(request, 1, "text_delta", { delta: "continued after source deletion" });
          yield event(request, 2, "response_completed", { finishReason: "stop" });
        }
      },
    },
  });
  let saved;
  try {
    const result = await host.runSessionTurn(sessionRequest(root, 1, registry));
    assert.equal(result.payload.status, "completed");
    assert.equal(projected.length, 3);
    const beforeDelete = imageMessage(projected[1].messages);
    const afterDelete = imageMessage(projected[2].messages);
    assert.deepEqual(beforeDelete, afterDelete);
    assert.equal(beforeDelete.images[0].url, "data:image/png;base64," + png.toString("base64"));
    const snapshot = await host.sendCommand({ kind: "runtime.get_session", payload: { sessionId: "session_images" } });
    saved = imageMessage(snapshot.turns[0].messages.map((item) => item.message));
    assert.notEqual(saved.images[0].url, source);
    assert.equal(saved.images[0].url.startsWith("data:"), false);
    assert.deepEqual(await readFile(saved.images[0].url), png);
    const cacheChecks = host.events("session_images", "turn_1")
      .filter((item) => item.kind === "cache_chain_observed");
    assert.equal(cacheChecks.length, 3);
    assert.ok(cacheChecks.every((item) => item.payload.frozenPrefixBreak === false));
  } finally {
    firstJournal.close();
  }
  const secondJournal = new FileSessionEventPersistence({ root: journalRoot });
  const replayed = [];
  try {
    const reopened = new InMemoryRuntimeHost({
      dataRoot: root, registerDefaultWorkspaceTools: false,
      sessionStore: new SessionStore({ persistence: secondJournal }),
      provider: {
        async *stream(request) {
          replayed.push(await resolveLocalImageInputs(request));
          yield event(request, 0, "response_started");
          yield event(request, 1, "text_delta", { delta: "replay succeeded" });
          yield event(request, 2, "response_completed", { finishReason: "stop" });
        },
      },
    });
    const result = await reopened.runSessionTurn(sessionRequest(root, 2));
    assert.equal(result.payload.status, "completed");
    assert.deepEqual(imageMessage(replayed[0].messages), imageMessage(projected[2].messages));
    const state = await reopened.sendCommand({ kind: "runtime.get_session", payload: { sessionId: "session_images" } });
    assert.deepEqual(imageMessage(state.turns[0].messages.map((item) => item.message)), saved);
  } finally {
    secondJournal.close();
  }
});

test("an unavailable legacy image is an explicit local input failure, not a retryable provider outage", async (context) => {
  const { root } = await imageFixture(context);
  let networkCalls = 0;
  context.mock.method(globalThis, "fetch", async () => {
    networkCalls += 1;
    throw new Error("No network expected in this test.");
  });
  const provider = new OpenAIResponsesProvider({ apiKey: "offline-fixture", baseURL: "http://127.0.0.1:1/v1" });
  const events = [];
  for await (const item of provider.stream({
    protocol: "bush.model_request.v1", requestId: "request", sessionId: "session", turnId: "turn", model: "fixture",
    tools: [], messages: [{ role: "user", content: "legacy observation", images: [{ url: join(root, "missing.png") }] }],
  })) events.push(item);
  assert.equal(networkCalls, 0);
  assert.equal(events.at(-1).kind, "response_failed");
  assert.equal(events.at(-1).code, "image_input_unavailable");
  assert.equal(events.at(-1).retryable, false);
  assert.match(events.at(-1).message, /Ensure the file exists/);
});

function imageMessage(messages) {
  const found = messages.find((item) => item.name === "tool_image_observation");
  assert.ok(found?.images?.length);
  return found;
}

function sessionRequest(root, index, registry) {
  return {
    protocol: "bush.session_turn_request.v1", requestId: "request_" + index,
    sessionId: "session_images", turnId: "turn_" + index, model: "fixture",
    prefixMessages: [{ role: "system", content: "fixed prefix" }],
    inputMessages: [{ messageId: "user_" + index, createdAt: NOW, message: { role: "user", content: "continue" } }],
    tools: registry ? registry.catalog().filter((entry) => ["inject_image_input", "delete_source"].includes(entry.definition.name)).map((entry) => entry.definition) : [],
    metadata: { workspaceDir: root },
  };
}

function event(request, sequence, kind, payload = {}) {
  return { protocol: "bush.model_event.v1", requestId: request.requestId, createdAt: NOW, sequence, kind, ...payload };
}
