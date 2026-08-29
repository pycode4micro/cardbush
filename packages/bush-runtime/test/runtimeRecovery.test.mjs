import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BUSH_MODEL_EVENT_PROTOCOL,
  BUSH_MODEL_REQUEST_PROTOCOL,
  BUSH_SESSION_TURN_REQUEST_PROTOCOL,
  BUSH_EXECUTION_FACT_PROTOCOL,
  BUSH_TOOL_RESULT_PROTOCOL,
  INSPECT_RUNTIME_RECOVERY_COMMAND,
  RESUME_MODEL_TURN_COMMAND,
} from "@cardbush/bush-protocol";
import {
  FileRuntimeCheckpointStore,
  FileRuntimeEventPersistence,
  FileSessionEventPersistence,
  InMemoryRuntimeCheckpointStore,
  InMemoryRuntimeEventLog,
  InMemoryRuntimeHost,
  RuntimeCheckpointCorruptionError,
  RuntimeRecoveryCoordinator,
  SessionStore,
  ToolRegistry,
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

test("resumes a Session Turn with prior tool messages and commits it exactly once", async (t) => {
  const roots = stateRoots(t);
  const firstEvents = new FileRuntimeEventPersistence({ root: roots.events });
  const firstSessions = new FileSessionEventPersistence({ root: roots.sessions });
  const firstLog = persistedEventLog(firstEvents);
  let providerRound = 0;
  const first = new InMemoryRuntimeHost({
    provider: {
      async *stream(modelRequest) {
        providerRound += 1;
        if (providerRound === 1) {
          yield recoveryEvent(modelRequest.requestId, 0, "response_started");
          yield recoveryEvent(modelRequest.requestId, 1, "tool_call_delta", {
            index: 0,
            toolCallId: "call_recovery",
            nameDelta: "fixture_tool",
            argumentsDelta: '{"value":"fixture"}',
          });
          yield recoveryEvent(modelRequest.requestId, 2, "usage", {
            inputTokens: 10,
            outputTokens: 2,
          });
          yield recoveryEvent(modelRequest.requestId, 3, "response_completed", {
            finishReason: "tool_calls",
          });
          return;
        }
        yield recoveryEvent(modelRequest.requestId, 0, "response_started");
        yield recoveryEvent(modelRequest.requestId, 1, "text_delta", { delta: "partial" });
        await new Promise(() => {});
      },
    },
    eventLog: firstLog,
    checkpointStore: new FileRuntimeCheckpointStore(roots.checkpoints),
    sessionStore: new SessionStore({ persistence: firstSessions }),
    toolRegistry: recoveryToolRegistry(),
    sessionNow: () => "2026-08-29T00:00:00.000Z",
    checkpointNow: () => "2026-08-29T00:00:00.000Z",
    projectorOptions: {
      createMessageId: counter("first_session_message"),
      createSegmentId: counter("first_session_segment"),
    },
  });
  void first.runSessionTurn({
    protocol: BUSH_SESSION_TURN_REQUEST_PROTOCOL,
    requestId: "request_session_recovery",
    sessionId: "session_recovery",
    turnId: "turn_recovery",
    model: "fixture-model",
    prefixMessages: [{ role: "system", content: "fixed" }],
    inputMessages: [{
      messageId: "user_recovery",
      createdAt: "2026-08-29T00:00:00.000Z",
      message: { role: "user", content: "recover this" },
    }],
    tools: [recoveryToolDefinition],
  });
  await waitForEvent(firstLog, "assistant_segment_delta");
  firstEvents.close();
  firstSessions.close();

  const secondEvents = new FileRuntimeEventPersistence({ root: roots.events });
  const secondSessions = new FileSessionEventPersistence({ root: roots.sessions });
  const secondStore = new SessionStore({ persistence: secondSessions });
  const second = new InMemoryRuntimeHost({
    provider: providerWithRounds([[
      recoveryEvent("request_session_recovery", 0, "response_started"),
      recoveryEvent("request_session_recovery", 1, "text_delta", { delta: "recovered" }),
      recoveryEvent("request_session_recovery", 2, "usage", {
        inputTokens: 20,
        outputTokens: 3,
      }),
      recoveryEvent("request_session_recovery", 3, "response_completed", {
        finishReason: "stop",
      }),
    ]]),
    eventLog: persistedEventLog(secondEvents),
    checkpointStore: new FileRuntimeCheckpointStore(roots.checkpoints),
    sessionStore: secondStore,
    toolRegistry: recoveryToolRegistry(),
    sessionNow: () => "2026-08-29T00:00:01.000Z",
    checkpointNow: () => "2026-08-29T00:00:01.000Z",
    projectorOptions: {
      createMessageId: counter("second_session_message"),
      createSegmentId: counter("second_session_segment"),
    },
  });
  const terminal = await second.sendCommand({
    kind: RESUME_MODEL_TURN_COMMAND,
    payload: { sessionId: "session_recovery", turnId: "turn_recovery" },
  });
  const snapshot = secondStore.snapshot("session_recovery");

  assert.equal(terminal.payload.status, "completed");
  assert.equal(snapshot.turns.length, 1);
  assert.deepEqual(
    snapshot.turns[0].messages.map((item) => item.message.role),
    ["user", "assistant", "tool", "assistant"],
  );
  assert.equal(snapshot.turns[0].messages.at(-1).message.content, "recovered");
  assert.equal(snapshot.turns[0].usage.inputTokens, 30);
  assert.equal(snapshot.turns[0].usage.outputTokens, 5);
  secondEvents.close();
  secondSessions.close();
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
    sessions: join(root, "sessions"),
  };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return roots;
}

const recoveryToolDefinition = {
  name: "fixture_tool",
  description: "Returns a fixture result.",
  inputSchema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
};

function recoveryToolRegistry() {
  return new ToolRegistry().register({
    definition: recoveryToolDefinition,
    manifest: {
      effect_kind: "observation",
      operation: "fixture.read",
      risk: "low",
      owner: "fixture_runtime",
      dispatch_phase: "execution",
      dispatch_scope: "turn",
      dispatch_side_effect: "none",
      dispatch_mutating: false,
      dispatch_source: "registered_tool",
      stage_modes: ["execute"],
      output_kinds: ["structured_data"],
      handoff_exports: [],
      evidence_hints: ["observation"],
    },
    decodeInput(input) {
      return input;
    },
    execute({ toolCall, actionManifest }) {
      return {
        protocol: BUSH_TOOL_RESULT_PROTOCOL,
        tool_call_id: toolCall.id,
        success: true,
        output: { value: "fixture-result" },
        facts: [{
          protocol: BUSH_EXECUTION_FACT_PROTOCOL,
          receipt_id: `receipt_${toolCall.id}`,
          action_manifest_id: actionManifest.manifest_id,
          status: "succeeded",
          operation: actionManifest.operation,
          effect_kind: actionManifest.effect_kind,
          owner: actionManifest.owner,
          dispatch_scope: actionManifest.dispatch_scope,
          categories: ["observation"],
          paths: [],
          execution_success: true,
          semantic_success: true,
          verification_state: "unverified",
          error_code: "",
        }],
      };
    },
  });
}

function recoveryEvent(requestId, sequence, kind, fields = {}) {
  return {
    protocol: BUSH_MODEL_EVENT_PROTOCOL,
    requestId,
    sequence,
    createdAt: "2026-08-29T00:00:00.000Z",
    kind,
    ...fields,
  };
}

function counter(prefix) {
  let value = 0;
  return () => `${prefix}_${++value}`;
}
