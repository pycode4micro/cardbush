import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BUSH_MODEL_EVENT_PROTOCOL,
  BUSH_MODEL_REQUEST_PROTOCOL,
  INSPECT_RUNTIME_RECOVERY_COMMAND,
  RESUME_MODEL_TURN_COMMAND,
} from "@cardbush/bush-protocol";
import {
  FileRuntimeCheckpointStore,
  FileRuntimeEventPersistence,
  InMemoryRuntimeCheckpointStore,
  InMemoryRuntimeEventLog,
  InMemoryRuntimeHost,
  RuntimeCheckpointCorruptionError,
  RuntimeRecoveryCoordinator,
  CacheChainTracker,
} from "../dist/index.js";

test("resumes from the last stable checkpoint and supersedes partial provider output", async (t) => {
  const roots = stateRoots(t);
  const firstPersistence = new FileRuntimeEventPersistence({ root: roots.events });
  const firstLog = persistedEventLog(firstPersistence);
  const first = host({
    eventLog: firstLog,
    checkpoints: new FileRuntimeCheckpointStore(roots.checkpoints),
    provider: hangingProvider(),
    messagePrefix: "first",
  });
  void first.runModelTurn(request());
  await waitForEvent(firstLog, "assistant_segment_delta");
  firstPersistence.close();

  const secondPersistence = new FileRuntimeEventPersistence({ root: roots.events });
  const secondLog = persistedEventLog(secondPersistence);
  const secondProvider = providerWithRounds([answerRound("recovered")]);
  const second = host({
    eventLog: secondLog,
    checkpoints: new FileRuntimeCheckpointStore(roots.checkpoints),
    provider: secondProvider,
    messagePrefix: "second",
  });
  const inspection = await second.sendCommand({
    kind: INSPECT_RUNTIME_RECOVERY_COMMAND,
    payload: { sessionId: "session_recovery", turnId: "turn_recovery" },
  });

  assert.equal(inspection.status, "resumable");
  assert.equal(inspection.nextRound, 1);
  assert.equal("checkpoint" in inspection, false);
  const terminal = await second.sendCommand({
    kind: RESUME_MODEL_TURN_COMMAND,
    payload: { sessionId: "session_recovery", turnId: "turn_recovery" },
  });
  const events = second.events("session_recovery", "turn_recovery");

  assert.equal(terminal.payload.status, "completed");
  assert.ok(events.find((event) => event.kind === "replay_reset"));
  assert.ok(events.find((event) => event.kind === "stream_resumed"));
  assert.equal(secondProvider.requests[0].messages.length, 1);
  assert.equal(
    new FileRuntimeCheckpointStore(roots.checkpoints).load(
      "session_recovery",
      "turn_recovery",
    ),
    undefined,
  );
  secondPersistence.close();
});

test("blocks recovery after a tool entered execution beyond the checkpoint", () => {
  const eventLog = new InMemoryRuntimeEventLog({
    createEventId: ({ sequence }) => `event_blocked_${sequence}`,
    now: () => "2026-08-29T00:00:00.000Z",
  });
  const checkpoints = new InMemoryRuntimeCheckpointStore();
  const recovery = new RuntimeRecoveryCoordinator({ eventLog, checkpoints });
  const identity = {
    requestId: "request_recovery",
    sessionId: "session_recovery",
    turnId: "turn_recovery",
  };
  eventLog.append(identity, {
    kind: "turn_accepted",
    payload: { status: "accepted" },
  });
  eventLog.append(identity, {
    kind: "turn_started",
    payload: { status: "running" },
  });
  recovery.save({
    request: request(),
    messages: request().messages,
    nextRound: 1,
    completedReceiptIds: [],
    cacheChainState: new CacheChainTracker().snapshot(),
  });
  const tool = {
    toolCallId: "call_ambiguous",
    toolName: "fixture_tool",
    ordinal: 0,
  };
  eventLog.append(identity, { kind: "tool_queued", payload: tool });
  eventLog.append(identity, { kind: "tool_running", payload: tool });

  const inspection = recovery.inspect(identity.sessionId, identity.turnId);
  assert.equal(inspection.status, "blocked");
  assert.equal(inspection.reason, "post_checkpoint_tool_running");
  assert.throws(() => recovery.prepareResume(identity.sessionId, identity.turnId));
});

test("atomically replaces checkpoints and fails closed after corruption", (t) => {
  const roots = stateRoots(t);
  const store = new FileRuntimeCheckpointStore(roots.checkpoints);
  const eventLog = new InMemoryRuntimeEventLog({
    createEventId: ({ sequence }) => `event_checkpoint_${sequence}`,
    now: () => "2026-08-29T00:00:00.000Z",
  });
  const identity = {
    requestId: "request_recovery",
    sessionId: "session_recovery",
    turnId: "turn_recovery",
  };
  eventLog.append(identity, {
    kind: "turn_accepted",
    payload: { status: "accepted" },
  });
  const recovery = new RuntimeRecoveryCoordinator({ eventLog, checkpoints: store });
  recovery.save({
    request: request(),
    messages: request().messages,
    nextRound: 1,
    completedReceiptIds: [],
    cacheChainState: new CacheChainTracker().snapshot(),
  });
  eventLog.append(identity, {
    kind: "turn_started",
    payload: { status: "running" },
  });
  recovery.save({
    request: request(),
    messages: request().messages,
    nextRound: 2,
    completedReceiptIds: ["receipt_1"],
    cacheChainState: new CacheChainTracker().snapshot(),
  });
  assert.equal(store.load(identity.sessionId, identity.turnId).nextRound, 2);

  const path = join(roots.checkpoints, readdirSync(roots.checkpoints)[0]);
  const corrupted = readFileSync(path, "utf8").replace("receipt_1", "receipt_x");
  writeFileSync(path, corrupted, "utf8");
  assert.throws(
    () => store.load(identity.sessionId, identity.turnId),
    RuntimeCheckpointCorruptionError,
  );
});

test("requires an explicit absolute checkpoint root", () => {
  assert.throws(
    () => new FileRuntimeCheckpointStore("relative/runtime-checkpoints"),
    /must be absolute/,
  );
});

function request() {
  return {
    protocol: BUSH_MODEL_REQUEST_PROTOCOL,
    requestId: "request_recovery",
    sessionId: "session_recovery",
    turnId: "turn_recovery",
    model: "fixture-model",
    messages: [{ role: "user", content: "Complete the recovery fixture." }],
    tools: [],
  };
}

function hangingProvider() {
  return {
    async *stream(modelRequest) {
      yield modelEvent(modelRequest.requestId, 0, "response_started");
      yield modelEvent(modelRequest.requestId, 1, "text_delta", {
        delta: "partial",
      });
      await new Promise(() => {});
    },
  };
}

function providerWithRounds(rounds) {
  let index = 0;
  return {
    requests: [],
    async *stream(modelRequest) {
      this.requests.push(structuredClone(modelRequest));
      yield* rounds[index++] ?? [];
    },
  };
}

function answerRound(text) {
  return [
    modelEvent("request_recovery", 0, "response_started"),
    modelEvent("request_recovery", 1, "text_delta", { delta: text }),
    modelEvent("request_recovery", 2, "response_completed", {
      finishReason: "stop",
    }),
  ];
}

function modelEvent(requestId, sequence, kind, fields = {}) {
  return {
    protocol: BUSH_MODEL_EVENT_PROTOCOL,
    requestId,
    sequence,
    createdAt: "2026-08-29T00:00:00.000Z",
    kind,
    ...fields,
  };
}

function host({ eventLog, checkpoints, provider, messagePrefix }) {
  return new InMemoryRuntimeHost({
    provider,
    eventLog,
    checkpointStore: checkpoints,
    checkpointNow: () => "2026-08-29T00:00:00.000Z",
    projectorOptions: {
      createMessageId: counter(`${messagePrefix}_message`),
      createSegmentId: counter(`${messagePrefix}_segment`),
    },
  });
}

function persistedEventLog(persistence) {
  return new InMemoryRuntimeEventLog({
    persistence,
    now: () => "2026-08-29T00:00:00.000Z",
  });
}

async function waitForEvent(eventLog, kind) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const event = eventLog
      .replay("session_recovery", "turn_recovery")
      .find((candidate) => candidate.kind === kind);
    if (event) return event;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${kind}.`);
}

function stateRoots(t) {
  const root = mkdtempSync(join(tmpdir(), "cardbush-runtime-recovery-"));
  const roots = {
    root,
    events: join(root, "events"),
    checkpoints: join(root, "checkpoints"),
  };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return roots;
}

function counter(prefix) {
  let value = 0;
  return () => `${prefix}_${++value}`;
}
