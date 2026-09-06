import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { BUSH_MODEL_EVENT_PROTOCOL, BUSH_SESSION_TURN_REQUEST_PROTOCOL, RESUME_MODEL_TURN_COMMAND } from "@cardbush/bush-protocol";
import { FileSessionEventPersistence, InMemoryRuntimeCheckpointStore, InMemoryRuntimeEventLog, InMemoryRuntimeHost,
  LogicMemoryStore, SessionStore } from "../dist/index.js";
import { LOGIC_REMINDER_NAME, LOGIC_REMINDER_CONTENT } from "../dist/logicReminder.js";

const NOW = "2026-09-06T00:00:00.000Z";
const reminders = messages => messages.filter(m => m.role === "developer" && m.name === LOGIC_REMINDER_NAME);
const user = content => ({ role: "user", content });
const assistant = content => ({ role: "assistant", content, toolCalls: [] });
const event = (request, sequence, kind, payload = {}) => ({ protocol: BUSH_MODEL_EVENT_PROTOCOL,
  requestId: request.requestId, sequence, createdAt: NOW, kind, ...payload });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "cardbush-logic-reminder-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const memory = new LogicMemoryStore(join(root, "lem", "logic.json"));
  await memory.learn({ scenario: "socket connection ECONNRESET", bias: "Assuming server failure",
    correction: "Check client connection reuse before blaming the server", evidence: "fixture passed", evidence_state: "verified" });
  return { root, memory };
}
async function request(host, turnId, text = "socket connection") {
  const tools = await host.sendCommand({ kind: "runtime.get_tool_catalog", payload: {} });
  return { protocol: BUSH_SESSION_TURN_REQUEST_PROTOCOL, requestId: `req_${turnId}`, sessionId: "session", turnId,
    model: "fixture", prefixMessages: [{ role: "system", content: "stable prefix" }],
    inputMessages: [{ messageId: `user_${turnId}`, message: user(text) }],
    tools: tools.filter(t => t.name === "consult_logic"), metadata: {} };
}
async function* answer(request, text = "done") {
  yield event(request, 0, "response_started");
  yield event(request, 1, "text_delta", { delta: text });
  yield event(request, 2, "response_completed", { finishReason: "stop" });
}
function seed(store, id, messages, status = "completed") {
  store.commitTurn("session", { turnId: id, turnSequence: (store.snapshot("session")?.turns.length ?? 0) + 1,
    createdAt: NOW, completedAt: NOW, status, reason: "model_response_completed", usage: {},
    messages: messages.map((message, i) => ({ messageId: `${id}_${i}`, turnId: id,
      turnSequence: (store.snapshot("session")?.turns.length ?? 0) + 1, messageIndex: i, createdAt: NOW, message })) });
}

test("one durable, hidden, optional reminder per Turn without automatic consult or cache-prefix rewrites", async t => {
  const { root, memory } = await fixture(t);
  const originalMemory = await readFile(memory.path, "utf8");
  const persistence = new FileSessionEventPersistence({ root: join(root, "sessions") });
  t.after(() => persistence.close());
  const observed = [];
  const host = new InMemoryRuntimeHost({ dataRoot: root, sessionStore: new SessionStore({ persistence }),
    provider: { async *stream(r) { observed.push(structuredClone(r)); yield* answer(r); } } });
  for (const id of ["one", "two"]) {
    assert.equal((await host.runSessionTurn(await request(host, id))).payload.status, "completed");
    assert.equal(host.events("session", id).some(e => e.kind === "tool_running"), false);
  }
  assert.equal(observed.length, 2, "ignoring the advisory reminder needs no extra model round");
  assert.equal(reminders(observed[0].messages).length, 1);
  assert.equal(reminders(observed[1].messages).length, 2, "one per Turn, with the old fact preserved");
  assert.equal(observed[0].messages.at(-1).content, LOGIC_REMINDER_CONTENT);
  for (const e of host.events("session", "two").filter(e => e.kind === "cache_chain_observed")) {
    assert.equal(e.payload.frozenPrefixBreak, false, JSON.stringify(e.payload));
  }
  const visible = await host.sendCommand({ kind: "runtime.get_session", payload: { sessionId: "session", messageProjection: "conversation" } });
  assert.equal(reminders(visible.turns.flatMap(t => t.messages.map(m => m.message))).length, 0);
  const feedback = await host.sendCommand({ kind: "runtime.record_logic_feedback", payload: {
    sessionId: "session", turnId: "one", rating: "up",
    messageId: visible.turns[0].messages.find(m => m.message.role === "assistant").messageId,
  } });
  assert.deepEqual(feedback.associatedLogicIds, [], "a hint alone is not a consult, adoption or feedback attribution");
  persistence.close();
  const reopened = new FileSessionEventPersistence({ root: join(root, "sessions") });
  try {
    const saved = new SessionStore({ persistence: reopened }).snapshot("session");
    assert.deepEqual(saved.turns.map(t => reminders(t.messages.map(m => m.message)).length), [1, 1]);
  } finally { reopened.close(); }
  assert.equal(await readFile(memory.path, "utf8"), originalMemory);
});

test("provider retries and explicit consult Tool loops retain just the initial reminder", async t => {
  const { root } = await fixture(t);
  const observed = [];
  const host = new InMemoryRuntimeHost({ dataRoot: root, maxAttempts: 2, wait: async () => {},
    provider: { async *stream(r) {
      observed.push(structuredClone(r));
      if (observed.length === 1) {
        yield event(r, 0, "response_failed", { code: "busy", message: "busy", retryable: true });
      } else if (observed.length === 2) {
        yield event(r, 0, "response_started");
        yield event(r, 1, "tool_call_delta", { index: 0, toolCallId: "call_consult", nameDelta: "consult_logic",
          argumentsDelta: JSON.stringify({ query: "socket connection" }) });
        yield event(r, 2, "response_completed", { finishReason: "tool_calls" });
      } else yield* answer(r);
    } } });
  assert.equal((await host.runSessionTurn(await request(host, "loop"))).payload.status, "completed");
  assert.equal(observed.length, 3);
  assert.deepEqual(observed.map(r => reminders(r.messages).length), [1, 1, 1]);
  assert.deepEqual(observed[0].messages, observed[1].messages);
  assert.equal(host.events("session", "loop").filter(e => e.kind === "tool_running").length, 1);
  assert.ok(host.events("session", "loop").filter(e => e.kind === "cache_chain_observed").every(e => !e.payload.frozenPrefixBreak));
});

test("compacted original user instructions and previous final replies both remain eligible", async t => {
  const { root } = await fixture(t);
  for (const messages of [
    [user("socket connection"), assistant("finished")],
    [user("inspect"), assistant("socket connection")],
  ]) {
    const store = new SessionStore();
    seed(store, "history", messages);
    store.summarizeTurns({ sessionId: "session", expectedRevision: store.snapshot("session").revision,
      summaries: [{ turnId: "history", summary: "old work" }] });
    let observed;
    const host = new InMemoryRuntimeHost({ dataRoot: root, sessionStore: store,
      provider: { async *stream(r) { observed = r; yield* answer(r); } } });
    await host.runSessionTurn(await request(host, "next", "continue"));
    assert.equal(reminders(observed.messages).length, 1);
    assert.equal(observed.messages.filter(m => m.content === "socket connection").length, 0,
      "matching raw history must not uncompact or re-inject that history");
  }
});

test("a pending replacement excludes old instructions and replies from local matching", async t => {
  const { root } = await fixture(t);
  const store = new SessionStore();
  seed(store, "old", [user("socket connection"), assistant("ECONNRESET")]);
  let observed;
  const host = new InMemoryRuntimeHost({ dataRoot: root, sessionStore: store,
    provider: { async *stream(r) { observed = r; yield* answer(r); } } });
  const candidate = await request(host, "replacement", "绘制山川风景");
  candidate.supersession = { expectedRevision: store.snapshot("session").revision,
    messageIds: ["old_0", "old_1"], reason: "user_edit_regenerate" };
  await host.runSessionTurn(candidate);
  assert.equal(reminders(observed.messages).length, 0);
});

test("corrupted local memory does not fail a normal model Turn", async t => {
  const { root, memory } = await fixture(t);
  await writeFile(memory.path, "{broken");
  let observed;
  const host = new InMemoryRuntimeHost({ dataRoot: root,
    provider: { async *stream(r) { observed = r; yield* answer(r); } } });
  assert.equal((await host.runSessionTurn(await request(host, "bad_memory"))).payload.status, "completed");
  assert.equal(reminders(observed.messages).length, 0);
  assert.equal(await readFile(memory.path, "utf8"), "{broken");
});

test("first-round checkpoint recovery neither rechecks nor duplicates the saved reminder", async t => {
  const { root, memory } = await fixture(t);
  const checkpoints = new InMemoryRuntimeCheckpointStore();
  const log = new InMemoryRuntimeEventLog();
  const store = new SessionStore();
  const abort = new AbortController();
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const first = new InMemoryRuntimeHost({ dataRoot: root, eventLog: log, checkpointStore: checkpoints, sessionStore: store,
    provider: { async *stream(r) { yield event(r, 0, "response_started"); entered(); await new Promise(() => {}); } } });
  const running = first.runSessionTurn(await request(first, "recover"), { signal: abort.signal });
  await ready;
  const saved = checkpoints.load("session", "recover");
  assert.equal(reminders(saved.request.messages).length, 1);
  // Retain the checkpoint/events as a crash snapshot before stopping the isolated old host.
  const recoveryCheckpoints = new InMemoryRuntimeCheckpointStore();
  recoveryCheckpoints.save(saved);
  const oldEvents = log.replay("session", "recover");
  const recoveryLog = new InMemoryRuntimeEventLog({ persistence: { load: () => oldEvents, append() {} } });
  abort.abort();
  await running;
  await writeFile(memory.path, "{broken-after-checkpoint");
  let observed;
  const second = new InMemoryRuntimeHost({ dataRoot: root, eventLog: recoveryLog, checkpointStore: recoveryCheckpoints,
    provider: { async *stream(r) { observed = r; yield* answer(r); } } });
  const result = await second.sendCommand({ kind: RESUME_MODEL_TURN_COMMAND, payload: { sessionId: "session", turnId: "recover" } });
  assert.equal(result.payload.status, "completed");
  assert.equal(reminders(observed.messages).length, 1);
  assert.equal(observed.messages.at(-1).content, LOGIC_REMINDER_CONTENT);
  assert.ok(second.events("session", "recover").filter(e => e.kind === "cache_chain_observed")
    .every(e => !e.payload.frozenPrefixBreak));
});
