import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import {
  FileSessionEventPersistence, InMemoryRuntimeHost, ModelImageStore, SessionStore, ToolRegistry,
} from "@cardbush/bush-runtime";
import { OpenAIResponsesProvider, resolveLocalImageInputs } from "../dist/index.js";
import { imageFixture, png } from "../../bush-runtime/test/helpers/modelImages.mjs";

const NOW = "2026-09-05T08:00:00.000Z";

for (const mcp of [false, true]) for (const compressed of [false, true]) test(`real ${mcp ? 'MCP' : 'injection'} loop and journal retain ${compressed ? 'compressed' : 'small original'} image bytes across restart`, async (context) => {
  const { root, source } = await imageFixture(context);
  const original = compressed ? await sharp({ create: { width: 1600, height: 1000, channels: 3,
    noise: { type: 'gaussian', mean: 128, sigma: 30 } } }).png().toBuffer() : png;
  await writeFile(source, original);
  const expected = await readFile(await new ModelImageStore(root).snapshot(source));
  if (compressed) assert.ok(expected.length < original.length / 2);
  const journalRoot = join(root, "sessions");
  const firstJournal = new FileSessionEventPersistence({ root: journalRoot });
  const registry = new ToolRegistry();
  registry.register({
    definition: { name: 'mcp_capture', description: 'fixture', inputSchema: { type: 'object' } },
    manifest: { effect_kind: 'observation', operation: 'mcp.call', risk: 'low', owner: 'test', dispatch_scope: 'process', mutating: false },
    decodeInput: input => input,
    execute: async () => ({ content: [{ type: 'image', mimeType: 'image/png', data: (await readFile(source)).toString('base64') }] }),
    renderModelResult: result => JSON.stringify(result),
  });
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
            nameDelta: projected.length === 1 ? mcp ? 'mcp_capture' : "inject_image_input" : "delete_source",
            argumentsDelta: JSON.stringify(projected.length === 1 && !mcp ? { url: source, detail: "high" } : {}),
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
    assert.equal(beforeDelete.images[0].url.split(',')[1], expected.toString("base64"));
    if (mcp) assert.ok(projected[1].messages.every(message => !message.content.includes(original.toString('base64'))));
    const snapshot = await host.sendCommand({ kind: "runtime.get_session", payload: { sessionId: "session_images" } });
    saved = imageMessage(snapshot.turns[0].messages.map((item) => item.message));
    assert.notEqual(saved.images[0].url, source);
    assert.equal(saved.images[0].url.startsWith("data:"), false);
    assert.deepEqual(await readFile(saved.images[0].url), expected);
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

for (const compressed of [true, false]) test(`new user ${compressed ? 'large PNG' : 'JPEG with application trailer'} attachments reach the provider and survive source deletion`, async context => {
  const { root, source } = await imageFixture(context);
  const original = compressed
    ? await sharp({ create: { width: 1600, height: 1000, channels: 3,
      noise: { type: 'gaussian', mean: 128, sigma: 30 } } }).png().toBuffer()
    : Buffer.concat([await sharp(png).jpeg().toBuffer(), Buffer.alloc(24, 0x42)]);
  await writeFile(source, original);
  const inputs = [];
  const host = new InMemoryRuntimeHost({ dataRoot: root, registerDefaultWorkspaceTools: false,
    provider: { async *stream(request) {
      inputs.push(await resolveLocalImageInputs(request));
      yield event(request, 0, 'text_delta', { delta: 'Image inspected.' });
      yield event(request, 1, 'response_completed', { finishReason: 'stop' });
    } } });
  context.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  const first = sessionRequest(root, 1);
  first.inputMessages[0].message.images = [{ url: source, detail: 'high' }];
  assert.equal((await host.runSessionTurn(first)).payload.status, 'completed');
  assert.deepEqual(await readFile(source), original);
  const images = inputs[0].messages.find(message => message.images?.length).images;
  const observed = Buffer.from(images[0].url.split(',')[1], 'base64');
  if (compressed) assert.ok(observed.length < original.length / 2);
  else {
    assert.match(images[0].url, /^data:image\/jpeg;base64,/);
    assert.deepEqual(observed, original);
  }
  assert.equal(images[0].detail, 'high');
  await rm(source);
  assert.equal((await host.runSessionTurn(sessionRequest(root, 2))).payload.status, 'completed');
  assert.deepEqual(inputs[1].messages.find(message => message.images?.length).images, images);
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
    tools: registry ? registry.catalog().filter((entry) => ["inject_image_input", "delete_source", "mcp_capture"].includes(entry.definition.name)).map((entry) => entry.definition) : [],
    requestCapabilities: { vision: true },
    metadata: { workspaceDir: root },
  };
}

function event(request, sequence, kind, payload = {}) {
  return { protocol: "bush.model_event.v1", requestId: request.requestId, createdAt: NOW, sequence, kind, ...payload };
}
