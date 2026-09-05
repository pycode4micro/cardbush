import assert from "node:assert/strict";
import test from "node:test";
import { runtimeSessionCommitCheckpointSchema } from "@cardbush/bush-protocol";
import {
  SessionStore, RuntimeSessionCoordinator, InMemoryRuntimeHost, assembleContext,
} from "../dist/index.js";

const now = "2026-09-05T00:00:00.000Z";
function fixture() {
  const events = [];
  let failCommit = false;
  const persistence = {
    load: () => structuredClone(events),
    append: (event) => {
      if (failCommit && event.kind === "turn_committed") throw new Error("disk failure");
      events.push(structuredClone(event));
    },
  };
  const store = new SessionStore({ persistence, now: () => now });
  const original = {
    turnId: "old", turnSequence: 1, createdAt: now, completedAt: now,
    status: "completed", reason: "done", usage: {},
    messages: ["original question", "original answer"].map((content, i) => ({
      messageId: `old_${i}`, turnId: "old", turnSequence: 1, messageIndex: i, createdAt: now,
      message: i === 0 ? { role: "user", content } : { role: "assistant", content, toolCalls: [] },
    })),
  };
  store.commitTurn("s", original);
  const coordinator = new RuntimeSessionCoordinator({ store, now: () => now });
  const request = {
    protocol: "bush.session_turn_request.v1", requestId: "r", sessionId: "s", turnId: "new",
    model: "test", tools: [], metadata: {},
    prefixMessages: [{ role: "system", content: "prefix" }],
    inputMessages: [{ messageId: "new_user", createdAt: now, message: { role: "user", content: "edited" } }],
    supersession: { expectedRevision: store.snapshot("s").revision,
      messageIds: ["old_0", "old_1"], reason: "user_edit_regenerate" },
  };
  return { events, persistence, store, coordinator, request,
    failCommit: () => { failCommit = true; } };
}
function finalize(coordinator, prepared) {
  coordinator.finalizer(prepared.modelRequest, prepared.sessionCommit)(
    { status: "completed", reason: "done", details: {} },
    [{ messageId: "new_answer", createdAt: now,
      message: { role: "assistant", content: "new answer", toolCalls: [] } }],
    {}, undefined,
  );
}

test("preparing and abandoning an edit never changes durable history", () => {
  const { coordinator, store, request } = fixture();
  const before = store.snapshot("s");
  const prepared = coordinator.prepare(request);
  assert.deepEqual(prepared.modelRequest.messages.map((m) => m.content), ["prefix", "edited"]);
  assert.deepEqual(store.snapshot("s"), before);
  assert.deepEqual(coordinator.contextCompactionState("s").unsummarizedTurnIds, []);
  assert.deepEqual(coordinator.rebuildActiveContext({
    sessionId: "s", prefix: [], current: [{ role: "user", content: "edited" }],
  }).messages.map((m) => m.content), ["edited"]);
  assert.throws(() => coordinator.delete("s"), /active Session/);
  coordinator.abandon("s", "new");
  assert.deepEqual(store.snapshot("s"), before);
  assert.deepEqual(coordinator.contextCompactionState("s").unsummarizedTurnIds, ["old"]);
});

test("stale, unknown, duplicate and invalid-context edits fail without superseding anything", () => {
  for (const patch of [
    { supersession: { expectedRevision: 1, messageIds: ["old_0"], reason: "edit" } },
    { supersession: { expectedRevision: 2, messageIds: ["unknown"], reason: "edit" } },
    { supersession: { expectedRevision: 2, messageIds: ["old_0", "old_0"], reason: "edit" } },
    { inputMessages: [{ messageId: "bad", message: { role: "tool", toolCallId: "missing", content: "x" } }] },
  ]) {
    const { coordinator, store, request } = fixture();
    const before = store.snapshot("s");
    assert.throws(() => coordinator.prepare({ ...request, ...patch }));
    assert.deepEqual(store.snapshot("s"), before);
  }
});

test("replacement and supersession persist in one replayable, idempotent commit", () => {
  const { coordinator, store, request, events, persistence } = fixture();
  const prepared = coordinator.prepare(request);
  finalize(coordinator, prepared);
  assert.equal(events.length, 3);
  assert.equal(events[2].kind, "turn_committed");
  assert.deepEqual(events[2].payload.supersession.messageIds, ["old_0", "old_1"]);
  const snapshot = store.snapshot("s");
  assert.deepEqual(assembleContext({ session: snapshot }).messages.map((m) => m.content), ["edited", "new answer"]);
  assert.equal(snapshot.turns[0].messages[0].message.content, "original question");
  assert.deepEqual(new SessionStore({ persistence }).snapshot("s"), snapshot);
  assert.deepEqual(store.commitTurn("s", snapshot.turns[1]), snapshot);
});

test("failed durable commit preserves the original branch", () => {
  const { coordinator, store, request, failCommit } = fixture();
  const before = store.snapshot("s");
  const prepared = coordinator.prepare(request);
  failCommit();
  assert.throws(() => finalize(coordinator, prepared), /disk failure/);
  assert.deepEqual(store.snapshot("s"), before);
});

test("checkpoint recovery retains the replacement context before committing", () => {
  const { coordinator, store, request, persistence } = fixture();
  const prepared = coordinator.prepare(request);
  const checkpoint = runtimeSessionCommitCheckpointSchema.parse(prepared.sessionCommit);
  const recovered = new RuntimeSessionCoordinator({ store: new SessionStore({ persistence }) });
  const context = recovered.rebuildActiveContext({ sessionId: "s", prefix: checkpoint.prefixMessages,
    current: checkpoint.inputMessages.map((m) => m.message), supersession: checkpoint.supersession });
  assert.deepEqual(context.messages.map((m) => m.content), ["prefix", "edited"]);
  assert.deepEqual(store.snapshot("s").supersededMessageIds, []);
  finalize(recovered, { ...prepared, sessionCommit: checkpoint });
  assert.deepEqual(recovered.snapshot("s").supersededMessageIds, ["old_0", "old_1"]);
});

test("the live host passes only replacement context to the provider and commits it", async () => {
  const { store, request } = fixture();
  let observed;
  const host = new InMemoryRuntimeHost({ sessionStore: store, provider: {
    async *stream(input) {
      observed = input.messages;
      yield { protocol: "bush.model_event.v1", requestId: input.requestId, sequence: 1,
        kind: "response_completed", finishReason: "stop" };
    },
  } });
  await host.runSessionTurn(request);
  assert.deepEqual(observed.map((m) => m.content), ["prefix", "edited"]);
  assert.deepEqual(store.snapshot("s").supersededMessageIds, ["old_0", "old_1"]);
});
