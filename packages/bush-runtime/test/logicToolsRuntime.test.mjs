import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { BUSH_MODEL_EVENT_PROTOCOL, BUSH_SESSION_TURN_REQUEST_PROTOCOL, RESUME_MODEL_TURN_COMMAND } from "@cardbush/bush-protocol";
import { FileSessionEventPersistence, InMemoryRuntimeCheckpointStore, InMemoryRuntimeEventLog,
  InMemoryRuntimeHost, LogicMemoryStore, SessionStore } from "../dist/index.js";

const NOW = "2026-09-06T00:00:00.000Z";
const user = content => ({ role: "user", content });
const assistant = content => ({ role: "assistant", content, toolCalls: [] });
const event = (request, sequence, kind, payload = {}) => ({ protocol: BUSH_MODEL_EVENT_PROTOCOL,
  requestId: request.requestId, sequence, createdAt: NOW, kind, ...payload });
const reminders = messages => messages.filter(m => m.role === "developer" && m.name === "lem_consult_reminder");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "cardbush-logic-tools-"));
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
    tools: tools.filter(t => ["consult_logic", "learn_logic"].includes(t.name)), metadata: {} };
}

async function* answer(request, text = "done") {
  yield event(request, 0, "response_started");
  yield event(request, 1, "text_delta", { delta: text });
  yield event(request, 2, "response_completed", { finishReason: "stop" });
}

function seed(store, id, messages) {
  const turnSequence = (store.snapshot("session")?.turns.length ?? 0) + 1;
  store.commitTurn("session", { turnId: id, turnSequence,
    createdAt: NOW, completedAt: NOW, status: "completed", reason: "model_response_completed", usage: {},
    messages: messages.map((message, i) => ({ messageId: `${id}_${i}`, turnId: id,
      turnSequence, messageIndex: i, createdAt: NOW, message })) });
}

test("matching context leaves memory untouched unless the model calls a memory Tool", async t => {
  const { root, memory } = await fixture(t);
  const originalMemory = await readFile(memory.path, "utf8");
  const persistence = new FileSessionEventPersistence({ root: join(root, "sessions") });
  t.after(() => persistence.close());
  const store = new SessionStore({ persistence });
  const consult = t.mock.method(LogicMemoryStore.prototype, "consult");
  const learn = t.mock.method(LogicMemoryStore.prototype, "learn");
  const observed = [];
  const host = new InMemoryRuntimeHost({ dataRoot: root, sessionStore: store,
    provider: { async *stream(r) { observed.push(structuredClone(r)); yield* answer(r); } } });
  for (const id of ["one", "two"]) {
    assert.equal((await host.runSessionTurn(await request(host, id))).payload.status, "completed");
    assert.equal(host.events("session", id).some(e => e.kind === "tool_running"), false);
  }
  assert.equal(consult.mock.callCount(), 0);
  assert.equal(learn.mock.callCount(), 0);
  assert.equal(observed.length, 2);
  assert.deepEqual(observed[0].messages.map(m => m.role), ["system", "user"]);
  assert.deepEqual(observed[1].messages.map(m => m.role), ["system", "user", "assistant", "user"]);
  assert.ok(host.events("session", "two").filter(e => e.kind === "cache_chain_observed")
    .every(e => !e.payload.frozenPrefixBreak));
  assert.ok(store.snapshot("session").turns.every(t => t.messages.length === 2));
  assert.equal(await readFile(memory.path, "utf8"), originalMemory);
});

test("explicit consult uses supplied context and remains append-only across provider retries", async t => {
  const { root } = await fixture(t);
  const observed = [];
  const consult = t.mock.method(LogicMemoryStore.prototype, "consult");
  const host = new InMemoryRuntimeHost({ dataRoot: root, maxAttempts: 2, wait: async () => {},
    provider: { async *stream(r) {
      observed.push(structuredClone(r));
      if (observed.length === 1) {
        yield event(r, 0, "response_failed", { code: "busy", message: "busy", retryable: true });
      } else if (observed.length === 2) {
        yield event(r, 0, "response_started");
        yield event(r, 1, "tool_call_delta", { index: 0, toolCallId: "call_consult", nameDelta: "consult_logic",
          argumentsDelta: JSON.stringify({ query: "socket connection", decision_context: "ECONNRESET" }) });
        yield event(r, 2, "response_completed", { finishReason: "tool_calls" });
      } else yield* answer(r);
    } } });
  assert.equal((await host.runSessionTurn(await request(host, "loop"))).payload.status, "completed");
  assert.equal(observed.length, 3);
  assert.deepEqual(observed[0].messages, observed[1].messages);
  assert.ok(observed.every(r => reminders(r.messages).length === 0));
  assert.equal(consult.mock.callCount(), 1);
  assert.equal(consult.mock.calls[0].arguments[0].decision_context, "ECONNRESET");
  const toolResult = observed[2].messages.find(m => m.role === "tool");
  assert.match(toolResult.content, /Check client connection reuse before blaming the server/);
  assert.equal(host.events("session", "loop").filter(e => e.kind === "tool_running").length, 1);
  assert.ok(host.events("session", "loop").filter(e => e.kind === "cache_chain_observed")
    .every(e => !e.payload.frozenPrefixBreak));
});

test("old reminders are excluded from new model context without rewriting stored history", async t => {
  const { root } = await fixture(t);
  const persistence = new FileSessionEventPersistence({ root: join(root, "sessions") });
  t.after(() => persistence.close());
  const store = new SessionStore({ persistence });
  seed(store, "old", [user("socket connection"),
    { role: "developer", name: "lem_consult_reminder", content: "Consider consult_logic, even if confident." },
    { role: "developer", name: "other_context", content: "Unrelated context fact" },
    assistant("done")]);
  const original = persistence.load("session");
  const observed = [];
  const host = new InMemoryRuntimeHost({ dataRoot: root, sessionStore: store,
    provider: { async *stream(r) { observed.push(structuredClone(r)); yield* answer(r); } } });
  for (const id of ["next", "again"]) await host.runSessionTurn(await request(host, id, "这里是因为cpu渲染才速度慢的么"));
  assert.ok(observed.every(r => reminders(r.messages).length === 0));
  assert.ok(observed[0].messages.some(m => m.name === "other_context"));
  assert.deepEqual(persistence.load("session").slice(0, original.length), original);
  assert.equal(reminders(store.snapshot("session").turns[0].messages.map(m => m.message)).length, 1);
  assert.ok(host.events("session", "again").filter(e => e.kind === "cache_chain_observed")
    .every(e => !e.payload.frozenPrefixBreak));
});

test("an unreadable memory store affects only an explicit consult", async t => {
  const { root, memory } = await fixture(t);
  await writeFile(memory.path, "{broken");
  const observed = [];
  const host = new InMemoryRuntimeHost({ dataRoot: root,
    provider: { async *stream(r) {
      observed.push(structuredClone(r));
      if (r.turnId === "explicit" && !r.messages.some(m => m.role === "tool")) {
        yield event(r, 0, "response_started");
        yield event(r, 1, "tool_call_delta", { index: 0, toolCallId: "call_bad_memory", nameDelta: "consult_logic",
          argumentsDelta: JSON.stringify({ query: "socket connection" }) });
        yield event(r, 2, "response_completed", { finishReason: "tool_calls" });
      } else yield* answer(r);
    } } });
  assert.equal((await host.runSessionTurn(await request(host, "normal"))).payload.status, "completed");
  assert.equal(host.events("session", "normal").some(e => e.kind === "tool_running"), false);
  assert.equal((await host.runSessionTurn(await request(host, "explicit"))).payload.status, "completed");
  assert.ok(host.events("session", "explicit").some(e => e.kind === "tool_failed"));
  assert.ok(observed.every(r => reminders(r.messages).length === 0));
  assert.equal(await readFile(memory.path, "utf8"), "{broken");
});

test("checkpoint recovery preserves the exact request without memory notices or extra Tools", async t => {
  const { root, memory } = await fixture(t);
  const checkpoints = new InMemoryRuntimeCheckpointStore();
  const log = new InMemoryRuntimeEventLog();
  const store = new SessionStore();
  const abort = new AbortController();
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  let initialMessages;
  const first = new InMemoryRuntimeHost({ dataRoot: root, eventLog: log, checkpointStore: checkpoints, sessionStore: store,
    provider: { async *stream(r) {
      initialMessages = structuredClone(r.messages);
      yield event(r, 0, "response_started"); entered(); await new Promise(() => {});
    } } });
  const running = first.runSessionTurn(await request(first, "recover"), { signal: abort.signal });
  await ready;
  const saved = checkpoints.load("session", "recover");
  assert.deepEqual(saved.request.messages, initialMessages);
  assert.equal(reminders(saved.request.messages).length, 0);
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
  assert.deepEqual(observed.messages, initialMessages);
  assert.equal(second.events("session", "recover").some(e => e.kind === "tool_running"), false);
  assert.ok(second.events("session", "recover").filter(e => e.kind === "cache_chain_observed")
    .every(e => !e.payload.frozenPrefixBreak));
});
