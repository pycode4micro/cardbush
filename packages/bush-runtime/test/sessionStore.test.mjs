import assert from "node:assert/strict";
import test from "node:test";

import {
  SessionStore,
  assembleContext,
} from "../dist/index.js";

const NOW = "2026-08-29T00:00:00.000Z";

test("commits ordered Turns atomically and assembles append-only context", () => {
  const store = deterministicStore();
  const first = turn("turn_1", 1, [
    { role: "user", content: "first" },
    { role: "assistant", content: "one", toolCalls: [] },
  ]);
  const second = turn("turn_2", 2, [
    { role: "user", content: "second" },
    { role: "assistant", content: "two", toolCalls: [] },
  ]);

  store.commitTurn("session_1", first);
  const snapshot = store.commitTurn("session_1", second);
  const context = assembleContext({
    session: snapshot,
    prefix: [{ role: "system", content: "fixed" }],
    current: [{ role: "user", content: "third" }],
  });

  assert.equal(snapshot.revision, 3);
  assert.deepEqual(context.messages.map((message) => message.content), [
    "fixed",
    "first",
    "one",
    "second",
    "two",
    "third",
  ]);
  assert.deepEqual(context.sourceMessageIds, [
    "turn_1_message_0",
    "turn_1_message_1",
    "turn_2_message_0",
    "turn_2_message_1",
  ]);
});

test("identical Turn commit is idempotent but conflicting reuse is rejected", () => {
  const store = deterministicStore();
  const original = turn("turn_1", 1, [{ role: "user", content: "same" }]);
  const first = store.commitTurn("session_1", original);
  const repeated = store.commitTurn("session_1", original);

  assert.equal(repeated.revision, first.revision);
  assert.throws(
    () => store.commitTurn("session_1", turn("turn_1", 1, [{ role: "user", content: "changed" }])),
    /different facts/,
  );
});

test("rejects sequence gaps, duplicate message identities, and orphan tool results", () => {
  const store = deterministicStore();
  store.commitTurn("session_1", turn("turn_1", 1, [{ role: "user", content: "one" }]));

  assert.throws(
    () => store.commitTurn("session_1", turn("turn_3", 3, [{ role: "user", content: "gap" }])),
    /does not follow/,
  );
  const duplicate = turn("turn_2", 2, [
    { role: "user", content: "two" },
    { role: "assistant", content: "ok", toolCalls: [] },
  ]);
  duplicate.messages[1].messageId = duplicate.messages[0].messageId;
  assert.throws(() => store.commitTurn("session_1", duplicate), /Duplicate message/);
  assert.throws(
    () => store.commitTurn("session_1", turn("turn_2", 2, [
      { role: "tool", toolCallId: "missing", content: "{}" },
    ])),
    /no pending call/,
  );
});

test("preserves complete tool-call adjacency as durable context facts", () => {
  const store = deterministicStore();
  const snapshot = store.commitTurn("session_1", turn("turn_1", 1, [
    { role: "user", content: "inspect" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_1", name: "read_file", argumentsText: "{}" }],
    },
    { role: "tool", toolCallId: "call_1", content: "result" },
    { role: "assistant", content: "done", toolCalls: [] },
  ]));

  assert.equal(assembleContext({ session: snapshot }).messages.length, 4);
});

test("projects a partial active-Turn checkpoint while retaining raw Tool history", () => {
  const store = deterministicStore();
  const candidate = turn("turn_1", 1, [
    { role: "user", content: "inspect and finish" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_1", name: "read_file", argumentsText: "{}" }],
    },
    { role: "tool", toolCallId: "call_1", content: "large result" },
    { role: "assistant", content: "finished after checkpoint", toolCalls: [] },
  ]);
  candidate.contextCheckpoint = {
    throughMessageId: "turn_1_message_2",
    summary: "The requested file was inspected successfully; report the verified result next.",
    inputMessageCount: 1,
  };
  const committed = store.commitTurn("session_1", candidate);

  assert.equal(committed.turns[0].messages[2].message.content, "large result");
  const projected = assembleContext({ session: committed });
  assert.deepEqual(projected.messages.map((message) => message.role), [
    "user",
    "assistant",
    "assistant",
  ]);
  assert.match(projected.messages[1].content, /active_turn_checkpoint/);
  assert.match(projected.messages[1].content, /inspected successfully/);
  assert.equal(projected.messages[2].content, "finished after checkpoint");
  assert.deepEqual(projected.sourceMessageIds, candidate.messages.map((message) =>
    message.messageId));

  const summarized = store.summarizeTurns({
    sessionId: "session_1",
    expectedRevision: committed.revision,
    summaries: [{
      turnId: "turn_1",
      summary: "The file inspection and final report both completed successfully.",
    }],
  });
  const fullyProjected = assembleContext({ session: summarized });
  assert.equal(fullyProjected.messages.length, 1);
  assert.equal(fullyProjected.messages[0].name, "turn_context_summary");
  assert.equal(summarized.turns[0].messages[2].message.content, "large result");
});

test("rejects active-Turn checkpoints outside generated message boundaries", () => {
  const store = deterministicStore();
  const candidate = turn("turn_1", 1, [
    { role: "user", content: "inspect" },
    { role: "assistant", content: "done", toolCalls: [] },
  ]);
  candidate.contextCheckpoint = {
    throughMessageId: "turn_1_message_0",
    summary: "invalid boundary",
    inputMessageCount: 1,
  };
  assert.throws(
    () => store.commitTurn("session_1", candidate),
    /boundary must be a generated Turn message/,
  );
});

test("only explicit supersession changes committed context", () => {
  const store = deterministicStore();
  store.commitTurn("session_1", turn("turn_1", 1, [
    { role: "user", content: "old" },
    { role: "assistant", content: "answer", toolCalls: [] },
  ]));
  const before = store.snapshot("session_1");
  const after = store.supersedeMessages({
    sessionId: "session_1",
    messageIds: ["turn_1_message_0", "turn_1_message_1"],
    reason: "user_replaced_turn",
  });

  assert.equal(assembleContext({ session: before }).messages.length, 2);
  assert.equal(assembleContext({ session: after }).messages.length, 0);
  assert.throws(
    () => store.supersedeMessages({
      sessionId: "session_1",
      messageIds: ["turn_1_message_0"],
      reason: "again",
    }),
    /already superseded/,
  );
});

test("large append-only history is not altered by thresholds", () => {
  const store = deterministicStore();
  for (let sequence = 1; sequence <= 80; sequence += 1) {
    store.commitTurn("session_1", turn(`turn_${sequence}`, sequence, [
      { role: "user", content: `payload-${sequence}-${"x".repeat(16_000)}` },
    ]));
  }
  const snapshot = store.snapshot("session_1");
  const context = assembleContext({ session: snapshot });

  assert.equal(context.messages.length, 80);
  assert.equal(context.sourceMessageIds.length, 80);
  assert.match(context.messages.at(-1).content, /^payload-80-/);
});

test("projects immutable Turn summaries without replacing durable messages", () => {
  const store = deterministicStore();
  store.commitTurn("session_1", turn("turn_1", 1, [
    { role: "user", content: "inspect the project" },
    { role: "assistant", content: "done", toolCalls: [] },
  ]));
  const before = store.commitTurn("session_1", turn("turn_2", 2, [
    { role: "user", content: "run tests" },
    { role: "assistant", content: "passed", toolCalls: [] },
  ]));
  const after = store.summarizeTurns({
    sessionId: "session_1",
    expectedRevision: before.revision,
    summaries: [
      { turnId: "turn_1", summary: "Inspected the project and completed the requested review." },
      { turnId: "turn_2", summary: "Ran the requested tests; they passed." },
    ],
  });

  assert.equal(after.revision, before.revision + 1);
  assert.equal(after.turns[0].messages[0].message.content, "inspect the project");
  assert.match(after.turns[0].contextSummary, /Inspected the project/);
  const context = assembleContext({ session: after });
  assert.equal(context.messages.length, 2);
  assert.ok(context.messages.every((message) => message.name === "turn_context_summary"));
  assert.deepEqual(context.sourceMessageIds, [
    "turn_1_message_0",
    "turn_1_message_1",
    "turn_2_message_0",
    "turn_2_message_1",
  ]);
  assert.throws(() => store.summarizeTurns({
    sessionId: "session_1",
    expectedRevision: after.revision,
    summaries: [{ turnId: "turn_1", summary: "replacement" }],
  }), /already has a context summary/);
  const superseded = store.supersedeMessages({
    sessionId: "session_1",
    messageIds: ["turn_1_message_0", "turn_1_message_1"],
    reason: "user_replaced_turn",
  });
  const supersededContext = assembleContext({ session: superseded });
  assert.equal(supersededContext.messages.length, 1);
  assert.match(supersededContext.messages[0].content, /Ran the requested tests/);
});

test("limits only projected summaries in the extreme fallback", () => {
  const store = deterministicStore();
  for (let sequence = 1; sequence <= 25; sequence += 1) {
    store.commitTurn("session_1", turn(`turn_${sequence}`, sequence, [
      { role: "user", content: `request ${sequence}` },
    ]));
  }
  const before = store.snapshot("session_1");
  const snapshot = store.summarizeTurns({
    sessionId: "session_1",
    expectedRevision: before.revision,
    summaries: before.turns.map((item) => ({
      turnId: item.turnId,
      summary: `summary ${item.turnSequence}`,
    })),
  });

  const context = assembleContext({ session: snapshot, maxSummaryTurns: 20 });
  assert.equal(context.messages.length, 20);
  assert.equal(context.truncated, true);
  assert.match(context.messages[0].content, /summary 6/);
  assert.equal(assembleContext({ session: snapshot, maxSummaryTurns: 0 }).messages.length, 0);
});

test("stores product-owned Session metadata with optimistic revisions", () => {
  const store = deterministicStore();
  const created = store.ensureSession("session_1", {
    title: "Explicit title",
    projectDir: "C:\\project",
  });
  assert.deepEqual(created.metadata, {
    title: "Explicit title",
    projectDir: "C:\\project",
  });
  const updated = store.updateMetadata({
    sessionId: "session_1",
    expectedRevision: created.revision,
    metadata: { title: "Renamed" },
  });
  assert.deepEqual(updated.metadata, { title: "Renamed" });
  assert.throws(() => store.updateMetadata({
    sessionId: "session_1",
    expectedRevision: created.revision,
    metadata: {},
  }), /does not match/);
});

function deterministicStore() {
  let id = 0;
  return new SessionStore({
    createEventId: () => `event_${++id}`,
    now: () => NOW,
  });
}

function turn(turnId, turnSequence, messages) {
  return {
    turnId,
    turnSequence,
    createdAt: NOW,
    completedAt: NOW,
    status: "completed",
    reason: "model_response_completed",
    usage: {},
    messages: messages.map((message, messageIndex) => ({
      messageId: `${turnId}_message_${messageIndex}`,
      turnId,
      turnSequence,
      messageIndex,
      createdAt: NOW,
      message,
    })),
  };
}
