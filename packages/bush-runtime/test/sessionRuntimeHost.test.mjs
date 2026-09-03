import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ASSEMBLE_RUNTIME_SESSION_CONTEXT_COMMAND,
  BUSH_MODEL_EVENT_PROTOCOL,
  BUSH_SESSION_TURN_REQUEST_PROTOCOL,
  GET_RUNTIME_SESSION_COMMAND,
  RECORD_RUNTIME_LOGIC_FEEDBACK_COMMAND,
  RUN_RUNTIME_SESSION_TURN_COMMAND,
  SUPERSEDE_RUNTIME_SESSION_MESSAGES_COMMAND,
} from "@cardbush/bush-protocol";
import { InMemoryRuntimeHost, LogicMemoryStore } from "../dist/index.js";

const NOW = "2026-08-29T00:00:00.000Z";

test("runs consecutive Session Turns from durable facts without duplicating the prefix", async () => {
  const observedRequests = [];
  let response = 0;
  const host = new InMemoryRuntimeHost({
    provider: {
      async *stream(request) {
        observedRequests.push(structuredClone(request));
        response += 1;
        yield event(request.requestId, 0, "response_started");
        yield event(request.requestId, 1, "reasoning_delta", { delta: `private-${response}` });
        yield event(request.requestId, 2, "text_delta", { delta: `answer-${response}` });
        yield event(request.requestId, 3, "usage", {
          inputTokens: response * 10,
          outputTokens: response,
          cachedInputTokens: response * 5,
        });
        yield event(request.requestId, 4, "response_completed", { finishReason: "stop" });
      },
    },
    sessionNow: () => NOW,
    eventLogOptions: deterministicEventLogOptions(),
    projectorOptions: {
      createMessageId: counter("assistant"),
      createSegmentId: counter("segment"),
    },
  });

  const firstRequest = sessionRequest("request_1", "turn_1", "user_1", "first");
  firstRequest.inputMessages[0].metadata = {
    attachments: [{
      id: "attachment-1",
      name: "brief.md",
      type: "document",
      path: "C:\\workspace\\brief.md",
    }],
  };
  await host.sendCommand({
    kind: RUN_RUNTIME_SESSION_TURN_COMMAND,
    payload: firstRequest,
  });
  await host.sendCommand({
    kind: RUN_RUNTIME_SESSION_TURN_COMMAND,
    payload: sessionRequest("request_2", "turn_2", "user_2", "second"),
  });

  assert.deepEqual(observedRequests[0].messages.map((message) => message.content), [
    "fixed-prefix",
    "first",
  ]);
  assert.deepEqual(
    observedRequests[0].tools.map((tool) => tool.name),
    ["checkpoint_context"],
  );
  assert.deepEqual(observedRequests[1].messages.map((message) => message.content), [
    "fixed-prefix",
    "first",
    "answer-1",
    "second",
  ]);
  const snapshot = await host.sendCommand({
    kind: GET_RUNTIME_SESSION_COMMAND,
    payload: { sessionId: "session_1" },
  });
  assert.equal(snapshot.turns.length, 2);
  assert.equal(snapshot.turns[0].usage.inputTokens, 10);
  assert.equal(snapshot.turns[0].usage.lastRequestInputTokens, 10);
  assert.equal(snapshot.turns[1].usage.cachedInputTokens, 10);
  assert.equal(snapshot.turns[1].usage.lastRequestCachedInputTokens, 10);
  assert.equal(snapshot.turns[0].cacheChainState.requestOrdinal, 1);
  assert.equal(snapshot.turns[1].cacheChainState.requestOrdinal, 2);
  assert.equal(snapshot.turns.flatMap((turn) => turn.messages).length, 4);
  assert.equal(
    snapshot.turns[0].messages.find((message) => message.message.role === "assistant")
      .message.reasoningContent,
    "private-1",
  );
  assert.deepEqual(snapshot.turns[0].messages[0].metadata.attachments, [{
    id: "attachment-1",
    name: "brief.md",
    type: "document",
    path: "C:\\workspace\\brief.md",
  }]);
  const conversationSnapshot = await host.sendCommand({
    kind: GET_RUNTIME_SESSION_COMMAND,
    payload: { sessionId: "session_1", messageProjection: "conversation" },
  });
  assert.equal(
    conversationSnapshot.turns
      .flatMap((turn) => turn.messages)
      .some((message) => message.message.role === "tool"),
    false,
  );
  assert.equal(
    conversationSnapshot.turns[0].messages
      .find((message) => message.message.role === "assistant")
      .message.reasoningContent,
    undefined,
  );
  assert.equal(
    snapshot.turns[0].messages
      .find((message) => message.message.role === "assistant")
      .message.reasoningContent,
    "private-1",
    "conversation reads must not mutate the canonical append-only snapshot",
  );
  assert.ok(host.capabilities().features.includes("append_only_session_context"));
  assert.ok(host.capabilities().features.includes("cross_turn_cache_chain"));
  assert.ok(host.capabilities().features.includes("stopped_turn_continuation"));
});

test("stops an uncooperative provider, commits partial facts, and continues the Cache Chain", async () => {
  const observedRequests = [];
  let call = 0;
  const host = new InMemoryRuntimeHost({
    provider: {
      async *stream(request) {
        observedRequests.push(structuredClone(request));
        call += 1;
        yield event(request.requestId, 0, "response_started");
        if (call === 1) {
          yield event(request.requestId, 1, "text_delta", { delta: "partial-before-stop" });
          await new Promise(() => {});
          return;
        }
        yield event(request.requestId, 1, "text_delta", { delta: "continued-after-stop" });
        yield event(request.requestId, 2, "response_completed", { finishReason: "stop" });
      },
    },
    sessionNow: () => NOW,
    eventLogOptions: deterministicEventLogOptions(),
    projectorOptions: {
      createMessageId: counter("assistant_stopped"),
      createSegmentId: counter("segment_stopped"),
    },
  });

  const first = host.runSessionTurn(
    sessionRequest("request_stop_1", "turn_stop_1", "user_stop_1", "first"),
  );
  await waitFor(() => host.events("session_1", "turn_stop_1")
    .some((candidate) => candidate.kind === "assistant_segment_delta"));
  const receipt = await host.sendCommand({
    kind: "runtime.stop_turn",
    payload: { sessionId: "session_1", turnId: "turn_stop_1" },
  });
  const stopped = await Promise.race([
    first,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error("Stop remained blocked by an uncooperative Provider.")),
      1_000,
    )),
  ]);

  assert.equal(receipt.accepted, true);
  assert.equal(stopped.payload.status, "stopped");
  const afterStop = await host.sendCommand({
    kind: GET_RUNTIME_SESSION_COMMAND,
    payload: { sessionId: "session_1" },
  });
  assert.deepEqual(afterStop.turns[0].messages.map((item) => item.message.content), [
    "first",
    "partial-before-stop",
  ]);
  assert.equal(afterStop.turns[0].cacheChainState.requestOrdinal, 1);

  await host.runSessionTurn(
    sessionRequest("request_stop_2", "turn_stop_2", "user_stop_2", "continue"),
  );
  assert.deepEqual(observedRequests[1].messages.map((message) => message.content), [
    "fixed-prefix",
    "first",
    "partial-before-stop",
    "continue",
  ]);
  const observation = host.events("session_1", "turn_stop_2")
    .find((candidate) => candidate.kind === "cache_chain_observed");
  assert.equal(observation.payload.previousMessageCount, 2);
  assert.equal(observation.payload.sharedPrefixMessages, 2);
  assert.equal(observation.payload.frozenPrefixBreak, false);
});

test("edit and regenerate inherit the prior Cache Chain and expose the real break", async () => {
  const host = new InMemoryRuntimeHost({
    provider: {
      async *stream(request) {
        yield event(request.requestId, 0, "response_started");
        yield event(request.requestId, 1, "text_delta", { delta: `answer:${request.turnId}` });
        yield event(request.requestId, 2, "response_completed", { finishReason: "stop" });
      },
    },
    sessionNow: () => NOW,
    eventLogOptions: deterministicEventLogOptions(),
  });
  await host.runSessionTurn(
    sessionRequest("request_edit_1", "turn_edit_1", "user_edit_1", "original"),
  );
  const before = await host.sendCommand({
    kind: GET_RUNTIME_SESSION_COMMAND,
    payload: { sessionId: "session_1" },
  });
  await host.sendCommand({
    kind: SUPERSEDE_RUNTIME_SESSION_MESSAGES_COMMAND,
    payload: {
      sessionId: "session_1",
      messageIds: before.turns[0].messages.map((message) => message.messageId),
      reason: "user_edit_regenerate",
    },
  });
  await host.runSessionTurn(
    sessionRequest("request_edit_2", "turn_edit_2", "user_edit_2", "replacement"),
  );

  const observation = host.events("session_1", "turn_edit_2")
    .find((candidate) => candidate.kind === "cache_chain_observed");
  assert.equal(observation.payload.requestOrdinal, 2);
  assert.equal(observation.payload.previousMessageCount, 2);
  assert.equal(observation.payload.sharedPrefixMessages, 1);
  assert.equal(observation.payload.frozenPrefixBreak, true);
  assert.equal(observation.payload.breakIndex, 1);
});

test("exposes exact Session context through the typed command boundary", async () => {
  const host = new InMemoryRuntimeHost({
    provider: { async *stream() {} },
    eventLogOptions: deterministicEventLogOptions(),
  });

  assert.equal(
    await host.sendCommand({
      kind: GET_RUNTIME_SESSION_COMMAND,
      payload: { sessionId: "missing" },
    }),
    null,
  );
  const context = await host.sendCommand({
    kind: ASSEMBLE_RUNTIME_SESSION_CONTEXT_COMMAND,
    payload: {
      sessionId: "session_1",
      prefixMessages: [{ role: "system", content: "prefix" }],
      currentMessages: [{ role: "user", content: "current" }],
    },
  });
  assert.deepEqual(context.messages.map((message) => message.content), ["prefix", "current"]);
  assert.deepEqual(context.sourceMessageIds, []);
});

test("serializes Session Turn commits while allowing the next Turn after completion", async () => {
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let calls = 0;
  const host = new InMemoryRuntimeHost({
    provider: {
      async *stream(request) {
        calls += 1;
        yield event(request.requestId, 0, "response_started");
        if (calls === 1) await firstGate;
        yield event(request.requestId, 1, "text_delta", { delta: `answer-${calls}` });
        yield event(request.requestId, 2, "response_completed", { finishReason: "stop" });
      },
    },
    sessionNow: () => NOW,
    eventLogOptions: deterministicEventLogOptions(),
  });

  const first = host.runSessionTurn(
    sessionRequest("request_serial_1", "turn_serial_1", "user_serial_1", "first"),
  );
  await assert.rejects(
    host.runSessionTurn(
      sessionRequest("request_serial_2", "turn_serial_2", "user_serial_2", "second"),
    ),
    /already has active Turn/,
  );
  releaseFirst();
  await first;
  await host.runSessionTurn(
    sessionRequest("request_serial_2", "turn_serial_2", "user_serial_2", "second"),
  );

  assert.equal((await host.sendCommand({
    kind: GET_RUNTIME_SESSION_COMMAND,
    payload: { sessionId: "session_1" },
  })).turns.length, 2);
});

test("associates assistant thumbs with LEM records used by that Turn", async (context) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "cardbush-runtime-lem-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const memory = new LogicMemoryStore(join(dataRoot, "lem", "logic.json"));
  const learned = await memory.learn({
    scenario: "before final verification",
    bias: "claiming completion without tests",
    correction: "run proportionate verification before final",
    evidence_state: "verified",
  });
  let round = 0;
  const host = new InMemoryRuntimeHost({
    dataRoot,
    provider: {
      async *stream(request) {
        round += 1;
        yield event(request.requestId, 0, "response_started");
        if (round === 1) {
          yield event(request.requestId, 1, "tool_call_delta", {
            index: 0,
            toolCallId: "call_consult_logic",
            nameDelta: "consult_logic",
            argumentsDelta: JSON.stringify({ query: "final verification before completion" }),
          });
          yield event(request.requestId, 2, "response_completed", { finishReason: "tool_calls" });
          return;
        }
        yield event(request.requestId, 1, "text_delta", { delta: "verified answer" });
        yield event(request.requestId, 2, "response_completed", { finishReason: "stop" });
      },
    },
    sessionNow: () => NOW,
    eventLogOptions: deterministicEventLogOptions(),
    projectorOptions: {
      createMessageId: counter("assistant_lem"),
      createSegmentId: counter("segment_lem"),
    },
  });
  const lemRequest = sessionRequest("request_lem", "turn_lem", "user_lem", "finish safely");
  const catalog = await host.sendCommand({ kind: "runtime.get_tool_catalog", payload: {} });
  lemRequest.tools = catalog.filter((definition) => definition.name === "consult_logic");
  await host.runSessionTurn(lemRequest);
  const snapshot = await host.sendCommand({
    kind: GET_RUNTIME_SESSION_COMMAND,
    payload: { sessionId: "session_1" },
  });
  assert.ok(snapshot.turns[0].messages.some((message) =>
    message.message.role === "tool"));
  const conversationSnapshot = await host.sendCommand({
    kind: GET_RUNTIME_SESSION_COMMAND,
    payload: { sessionId: "session_1", messageProjection: "conversation" },
  });
  assert.equal(conversationSnapshot.turns[0].messages.some((message) =>
    message.message.role === "tool"), false);
  const finalMessage = snapshot.turns[0].messages.find((message) =>
    message.message.role === "assistant" && message.message.content === "verified answer");
  assert.ok(finalMessage);
  const feedback = await host.sendCommand({
    kind: RECORD_RUNTIME_LOGIC_FEEDBACK_COMMAND,
    payload: {
      sessionId: "session_1",
      turnId: "turn_lem",
      messageId: finalMessage.messageId,
      rating: "up",
    },
  });
  assert.deepEqual(feedback.associatedLogicIds, [learned.logic_id]);
  assert.deepEqual(feedback.updatedLogicIds, [learned.logic_id]);
  const stored = JSON.parse(await readFile(memory.path, "utf8"))[0];
  assert.equal(stored.positive_feedback_count, 1);
});

test("forces atomic context compaction and resumes the same active Turn", async () => {
  const observedRequests = [];
  let call = 0;
  const host = new InMemoryRuntimeHost({
    provider: {
      async countInputTokens(request) {
        return {
          inputTokens: request.messages.some((message) =>
            message.name === "turn_context_summary")
              ? 100
            : request.messages.some((message) => message.name === "context_pressure")
              ? 2_900
              : 2_860,
          source: "provider",
        };
      },
      async *stream(request) {
        observedRequests.push(structuredClone(request));
        call += 1;
        yield event(request.requestId, 0, "response_started");
        if (call === 1) {
          yield event(request.requestId, 1, "text_delta", { delta: "first complete" });
          yield event(request.requestId, 2, "usage", {
            inputTokens: 60,
            outputTokens: 4,
            cachedInputTokens: 20,
          });
          yield event(request.requestId, 3, "response_completed", { finishReason: "stop" });
          return;
        }
        if (
          request.tools.some((tool) => tool.name === "checkpoint_context") &&
          request.messages.some((message) => message.name === "context_pressure")
        ) {
          const argumentsText = JSON.stringify({
            session_revision: 2,
            summaries: [{
              turn_id: "turn_compact_1",
              summary: "The user supplied a large prior payload; the Turn completed without external side effects.",
            }],
          });
          yield event(request.requestId, 1, "tool_call_delta", {
            index: 0,
            toolCallId: "call_checkpoint",
            nameDelta: "checkpoint_context",
            argumentsDelta: argumentsText,
          });
          yield event(request.requestId, 2, "usage", {
            inputTokens: 90,
            outputTokens: 8,
            cachedInputTokens: 50,
          });
          yield event(request.requestId, 3, "response_completed", { finishReason: "tool_calls" });
          return;
        }
        yield event(request.requestId, 1, "text_delta", { delta: "second complete" });
        yield event(request.requestId, 2, "usage", {
          inputTokens: 110,
          outputTokens: 5,
          cachedInputTokens: 80,
        });
        yield event(request.requestId, 3, "response_completed", { finishReason: "stop" });
      },
    },
    sessionNow: () => NOW,
    eventLogOptions: deterministicEventLogOptions(),
    projectorOptions: {
      createMessageId: counter("assistant_compact"),
      createSegmentId: counter("segment_compact"),
    },
  });

  await host.runSessionTurn(sessionRequest(
    "request_compact_1",
    "turn_compact_1",
    "user_compact_1",
    "x".repeat(20),
  ));
  const second = sessionRequest(
    "request_compact_2",
    "turn_compact_2",
    "user_compact_2",
    "continue",
  );
  second.tools = [ordinaryToolDefinition()];
  second.maxOutputTokens = 1000;
  second.metadata = { contextWindowTokens: 4000 };
  await host.runSessionTurn(second);

  assert.equal(observedRequests.length, 3);
  assert.deepEqual(
    observedRequests[1].tools.map((tool) => tool.name),
    ["ordinary_tool", "checkpoint_context"],
  );
  assert.deepEqual(
    observedRequests[2].tools.map((tool) => tool.name),
    ["ordinary_tool", "checkpoint_context"],
  );
  assert.match(
    observedRequests[2].messages.find((message) => message.name === "turn_context_summary")?.content ?? "",
    /large prior payload/,
  );
  const snapshot = await host.sendCommand({
    kind: GET_RUNTIME_SESSION_COMMAND,
    payload: { sessionId: "session_1" },
  });
  assert.match(snapshot.turns[0].contextSummary, /large prior payload/);
  assert.equal(snapshot.turns[0].messages[0].message.content.length, 20);
  assert.equal(snapshot.turns[1].messages.length, 2);
  assert.equal(snapshot.turns[1].usage.inputTokens, 200);
  assert.equal(snapshot.turns[1].usage.model, "model");
  assert.equal(snapshot.turns[1].usage.contextWindowTokens, 4000);
  assert.equal(snapshot.turns[1].usage.lastRequestInputTokens, 110);
  assert.equal(snapshot.turns[1].usage.lastRequestCachedInputTokens, 80);
  assert.equal(
    snapshot.turns[1].messages.some((message) =>
      message.message.role === "assistant" &&
      message.message.toolCalls.some((toolCall) => toolCall.name === "checkpoint_context")),
    false,
  );
  assert.equal(
    host.events("session_1", "turn_compact_2")
      .filter((event) => event.kind === "assistant_segment_started").length,
    1,
  );
});

test("keeps checkpoint_context visible but rejects proactive compaction below 95 percent", async () => {
  const observedRequests = [];
  let call = 0;
  const host = new InMemoryRuntimeHost({
    provider: {
      async *stream(request) {
        observedRequests.push(structuredClone(request));
        call += 1;
        yield event(request.requestId, 0, "response_started");
        if (call === 2) {
          yield event(request.requestId, 1, "tool_call_delta", {
            index: 0,
            toolCallId: "call_proactive_checkpoint",
            nameDelta: "checkpoint_context",
            argumentsDelta: JSON.stringify({
              session_revision: 2,
              summaries: [{ turn_id: "turn_proactive_1", summary: "Should be rejected." }],
            }),
          });
          yield event(request.requestId, 2, "response_completed", { finishReason: "tool_calls" });
          return;
        }
        yield event(request.requestId, 1, "text_delta", {
          delta: call === 1 ? "first complete" : "continued without compaction",
        });
        yield event(request.requestId, 2, "response_completed", { finishReason: "stop" });
      },
    },
    sessionNow: () => NOW,
    eventLogOptions: deterministicEventLogOptions(),
    projectorOptions: {
      createMessageId: counter("assistant_proactive"),
      createSegmentId: counter("segment_proactive"),
    },
  });

  await host.runSessionTurn(sessionRequest(
    "request_proactive_1",
    "turn_proactive_1",
    "user_proactive_1",
    "x".repeat(9_000),
  ));
  const second = sessionRequest(
    "request_proactive_2",
    "turn_proactive_2",
    "user_proactive_2",
    "continue",
  );
  second.maxOutputTokens = 1000;
  second.metadata = { contextWindowTokens: 4000 };
  const terminal = await host.runSessionTurn(second);

  assert.equal(terminal.payload.status, "completed");
  assert.equal(observedRequests.length, 3);
  assert.ok(observedRequests.every((request) =>
    request.tools.some((tool) => tool.name === "checkpoint_context")));
  assert.equal(
    observedRequests[1].messages.some((message) => message.name === "context_pressure"),
    false,
  );
  assert.match(
    observedRequests[2].messages.find((message) =>
      message.name === "context_compaction_correction")?.content ?? "",
    /do not call checkpoint_context proactively/,
  );
  const snapshot = await host.sendCommand({
    kind: GET_RUNTIME_SESSION_COMMAND,
    payload: { sessionId: "session_1" },
  });
  assert.equal(snapshot.turns[0].contextSummary, undefined);
  assert.equal(
    snapshot.turns[1].messages.some((message) =>
      message.message.role === "assistant" &&
      message.message.toolCalls.some((toolCall) => toolCall.name === "checkpoint_context")),
    false,
  );
});

test("fails before dispatch when the Provider cannot count the final input projection", async () => {
  let streamed = false;
  const host = new InMemoryRuntimeHost({
    provider: {
      async countInputTokens() {
        throw new Error("count endpoint unavailable");
      },
      async *stream() {
        streamed = true;
      },
    },
    sessionNow: () => NOW,
    eventLogOptions: deterministicEventLogOptions(),
  });
  const request = sessionRequest(
    "request_count_failure",
    "turn_count_failure",
    "user_count_failure",
    "hello",
  );
  request.metadata = { contextWindowTokens: 4_000 };

  const terminal = await host.runSessionTurn(request);

  assert.equal(streamed, false);
  assert.equal(terminal.payload.status, "failed");
  assert.equal(terminal.payload.reason, "provider_input_token_count_failed");
  assert.match(terminal.payload.details.message, /count endpoint unavailable/);
});

test("dispatches with a fallback estimate when exact Provider counting is unsupported", async () => {
  let counted = 0;
  let streamed = false;
  const host = new InMemoryRuntimeHost({
    provider: {
      async countInputTokens() {
        counted += 1;
        return undefined;
      },
      async *stream(request) {
        streamed = true;
        yield event(request.requestId, 0, "response_started");
        yield event(request.requestId, 1, "text_delta", { delta: "fallback continued" });
        yield event(request.requestId, 2, "response_completed", { finishReason: "stop" });
      },
    },
    sessionNow: () => NOW,
    eventLogOptions: deterministicEventLogOptions(),
  });
  const request = sessionRequest(
    "request_count_unsupported",
    "turn_count_unsupported",
    "user_count_unsupported",
    "hello",
  );
  request.metadata = { contextWindowTokens: 4_000 };

  const terminal = await host.runSessionTurn(request);

  assert.equal(counted, 1);
  assert.equal(streamed, true);
  assert.equal(terminal.payload.status, "completed");
  assert.equal(terminal.payload.reason, "model_response_completed");
});

function sessionRequest(requestId, turnId, messageId, content) {
  return {
    protocol: BUSH_SESSION_TURN_REQUEST_PROTOCOL,
    requestId,
    sessionId: "session_1",
    turnId,
    model: "model",
    prefixMessages: [{ role: "system", content: "fixed-prefix" }],
    inputMessages: [{ messageId, createdAt: NOW, message: { role: "user", content } }],
    tools: [],
    metadata: {},
  };
}

function event(requestId, sequence, kind, payload = {}) {
  return {
    protocol: BUSH_MODEL_EVENT_PROTOCOL,
    requestId,
    sequence,
    createdAt: NOW,
    kind,
    ...payload,
  };
}

function ordinaryToolDefinition() {
  return {
    name: "ordinary_tool",
    description: "An ordinary Tool that must remain in the stable schema.",
    inputSchema: { type: "object", properties: {} },
  };
}

function deterministicEventLogOptions() {
  let eventId = 0;
  return {
    createEventId: () => `event_${++eventId}`,
    now: () => NOW,
  };
}

function counter(prefix) {
  let value = 0;
  return () => `${prefix}_${++value}`;
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Runtime fact.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
