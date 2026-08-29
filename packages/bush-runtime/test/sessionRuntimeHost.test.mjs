import assert from "node:assert/strict";
import test from "node:test";

import {
  ASSEMBLE_RUNTIME_SESSION_CONTEXT_COMMAND,
  BUSH_MODEL_EVENT_PROTOCOL,
  BUSH_SESSION_TURN_REQUEST_PROTOCOL,
  GET_RUNTIME_SESSION_COMMAND,
  RUN_RUNTIME_SESSION_TURN_COMMAND,
} from "@cardbush/bush-protocol";
import { InMemoryRuntimeHost } from "../dist/index.js";

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
        yield event(request.requestId, 1, "text_delta", { delta: `answer-${response}` });
        yield event(request.requestId, 2, "usage", {
          inputTokens: response * 10,
          outputTokens: response,
          cachedInputTokens: response * 5,
        });
        yield event(request.requestId, 3, "response_completed", { finishReason: "stop" });
      },
    },
    sessionNow: () => NOW,
    eventLogOptions: deterministicEventLogOptions(),
    projectorOptions: {
      createMessageId: counter("assistant"),
      createSegmentId: counter("segment"),
    },
  });

  await host.sendCommand({
    kind: RUN_RUNTIME_SESSION_TURN_COMMAND,
    payload: sessionRequest("request_1", "turn_1", "user_1", "first"),
  });
  await host.sendCommand({
    kind: RUN_RUNTIME_SESSION_TURN_COMMAND,
    payload: sessionRequest("request_2", "turn_2", "user_2", "second"),
  });

  assert.deepEqual(observedRequests[0].messages.map((message) => message.content), [
    "fixed-prefix",
    "first",
  ]);
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
  assert.equal(snapshot.turns[1].usage.cachedInputTokens, 10);
  assert.equal(snapshot.turns.flatMap((turn) => turn.messages).length, 4);
  assert.ok(host.capabilities().features.includes("append_only_session_context"));
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
    toolChoice: "auto",
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
