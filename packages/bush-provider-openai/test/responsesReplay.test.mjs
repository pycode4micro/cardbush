import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { modelMessageSchema, modelRequestSchema } from "@cardbush/bush-protocol";
import {
  executeModelRound, FileRuntimeCheckpointStore, FileSessionEventPersistence,
  InMemoryRuntimeHost, InMemoryRuntimeEventLog, RuntimeRecoveryCoordinator,
  CacheChainTracker, SessionStore, projectContextCompactionMaintenanceMessages,
} from "@cardbush/bush-runtime";
import { normalizeResponseStreamEvent, toResponsesCreateParams } from "../dist/index.js";

const binding = { bindingId: "test-provider", revision: "revision-1" };
const baseRequest = {
  protocol: "bush.model_request.v1", requestId: "replay-request", sessionId: "replay-session",
  turnId: "replay-turn", model: "test-model", providerBinding: binding,
  messages: [{ role: "user", content: "Inspect and report." }], tools: [],
};
const outputMessage = (id, phase, text) => ({
  type: "message", id, role: "assistant", status: "completed", phase,
  content: [{ type: "output_text", text, annotations: [] }],
});
const outputs = [
  { type: "reasoning", id: "rs_original", summary: [{ type: "summary_text", text: "Inspect facts" }], encrypted_content: "opaque-provider-reasoning" },
  outputMessage("msg_progress", "commentary", "Checking. "),
  { type: "function_call", id: "fc_original", call_id: "call_original", name: "read_file", arguments: '{"path":"file.ts"}', status: "completed" },
  outputMessage("msg_final", "final_answer", "Result."),
];

function providerFor(items) {
  return { async *stream(request) {
    const state = { requestId: request.requestId, sequence: 0, started: false };
    const response = { id: "resp_replay", created_at: 1, store: false, output: items, usage: null };
    yield* normalizeResponseStreamEvent({ type: "response.created", response }, state);
    for (const [output_index, item] of items.entries()) {
      yield* normalizeResponseStreamEvent({ type: "response.output_item.added", output_index, item }, state);
      if (item.type === "message") for (const part of item.content) {
        yield* normalizeResponseStreamEvent({ type: "response.output_text.delta", delta: part.text }, state);
      }
      if (item.type === "reasoning") for (const part of item.summary) {
        yield* normalizeResponseStreamEvent({ type: "response.reasoning_summary_text.delta", delta: part.text }, state);
      }
      if (item.type === "function_call") {
        yield* normalizeResponseStreamEvent({ type: "response.function_call_arguments.delta", output_index, delta: item.arguments }, state);
      }
    }
    yield* normalizeResponseStreamEvent({ type: "response.completed", response: {
      ...response, transportHeaders: { authorization: "must-not-be-recorded" },
    } }, state);
  } };
}

async function assistantFrom(items = outputs) {
  const round = await executeModelRound(providerFor(items), baseRequest);
  assert.equal(round.status, "completed");
  return modelMessageSchema.parse(JSON.parse(JSON.stringify({
    role: "assistant", content: round.text, reasoningContent: round.reasoning,
    toolCalls: round.toolCalls, providerReplay: round.providerReplay,
  })));
}

test("replays original item order, per-message phases, ids and encrypted reasoning", async () => {
  const assistant = await assistantFrom();
  const request = modelRequestSchema.parse({ ...baseRequest, messages: [assistant] });
  assert.deepEqual(toResponsesCreateParams(request).input, outputs);
  assert.equal(JSON.stringify(assistant).includes("must-not-be-recorded"), false);
  const chain = toResponsesCreateParams({
    ...request, messages: [assistant, { role: "tool", content: "file", toolCallId: "call_original" }],
    providerState: { strategy: "response_chain", previousResponseId: "resp_stored", inputMessageOffset: 1 },
  });
  assert.deepEqual(chain.input, [{ type: "function_call_output", call_id: "call_original", output: "file" }]);
});

test("does not replay stale provider output after message edits or model/binding changes", async () => {
  const assistant = await assistantFrom();
  const variants = [
    { ...baseRequest, model: "another-model", messages: [assistant] },
    { ...baseRequest, providerBinding: { ...binding, revision: "revision-2" }, messages: [assistant] },
    { ...baseRequest, messages: [{ ...assistant, content: "Edited answer." }] },
    { ...baseRequest, messages: [{ ...assistant, toolCalls: [] }] },
  ];
  for (const request of variants) {
    const items = toResponsesCreateParams(request).input;
    assert.equal(items.some((item) => item.id === "rs_original" || item.id === "msg_progress"), false);
  }
  const changed = toResponsesCreateParams(variants[2]).input;
  assert.equal(changed.find((item) => item.role === "assistant").content, "Edited answer.");
});

test("maintenance projection drops opaque replay with hidden reasoning without mutating history", async () => {
  const assistant = await assistantFrom();
  const projected = projectContextCompactionMaintenanceMessages({
    messages: [assistant], sessionId: "s", turnId: "t",
    pressure: { estimatedPromptTokens: 1000, usableInputTokens: 900, fallbackScale: 1 },
  });
  assert.equal(projected.messages[0].providerReplay, undefined);
  assert.equal(projected.messages[0].reasoningContent, undefined);
  assert.deepEqual(assistant.providerReplay.data.items, outputs);
  assert.equal(JSON.stringify(toResponsesCreateParams({ ...baseRequest, messages: projected.messages }).input)
    .includes("opaque-provider-reasoning"), false);
});

test("durable Session replay survives a Runtime restart and remains usable in the next Turn", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cardbush-replay-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const items = [outputMessage("msg_p", "commentary", "Checking. "), outputMessage("msg_f", "final_answer", "Done.")];
  const persistence = new FileSessionEventPersistence({ root });
  const store = new SessionStore({ persistence });
  const first = new InMemoryRuntimeHost({ provider: providerFor(items), sessionStore: store });
  const turn = (id) => ({
    protocol: "bush.session_turn_request.v1", requestId: `request-${id}`, sessionId: "durable-replay",
    turnId: id, model: baseRequest.model, providerBinding: binding, prefixMessages: [],
    inputMessages: [{ messageId: `user-${id}`, message: { role: "user", content: id } }], tools: [],
  });
  assert.equal((await first.runSessionTurn(turn("one"))).payload.status, "completed");
  persistence.close();
  const nextPersistence = new FileSessionEventPersistence({ root });
  t.after(() => nextPersistence.close());
  let replayed;
  const second = new InMemoryRuntimeHost({
    sessionStore: new SessionStore({ persistence: nextPersistence }),
    provider: { async *stream(request) {
      replayed = toResponsesCreateParams(request).input;
      yield* providerFor([outputMessage("msg_next", "final_answer", "Continued.")]).stream(request);
    } },
  });
  assert.equal((await second.runSessionTurn(turn("two"))).payload.status, "completed");
  assert.deepEqual(replayed.filter((item) => item.role === "assistant"), items);
});

test("file checkpoints preserve replay data while excluding ephemeral response-chain ids", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cardbush-replay-checkpoint-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assistant = await assistantFrom();
  const checkpoints = new FileRuntimeCheckpointStore(root);
  const eventLog = new InMemoryRuntimeEventLog();
  const identity = { requestId: baseRequest.requestId, sessionId: baseRequest.sessionId, turnId: baseRequest.turnId };
  eventLog.append(identity, { kind: "turn_accepted", payload: { status: "accepted" } });
  eventLog.append(identity, { kind: "turn_started", payload: { status: "running" } });
  const request = modelRequestSchema.parse({
      ...baseRequest, messages: [baseRequest.messages[0], assistant, { role: "tool", content: "file", toolCallId: "call_original" }],
      providerState: { strategy: "response_chain", previousResponseId: "resp_ephemeral", inputMessageOffset: 2 },
  });
  new RuntimeRecoveryCoordinator({ checkpoints, eventLog }).save({
    request, messages: request.messages, nextRound: 2, cacheChainState: new CacheChainTracker().snapshot(),
  });
  const restored = new FileRuntimeCheckpointStore(root).load(baseRequest.sessionId, baseRequest.turnId);
  assert.equal(restored.request.providerState, undefined);
  assert.deepEqual(toResponsesCreateParams(restored.request).input.slice(1, -1), outputs);
});
