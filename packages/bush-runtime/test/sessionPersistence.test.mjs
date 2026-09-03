import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assembleContext,
  FileSessionEventPersistence,
  SessionJournalCorruptionError,
  SessionStore,
} from "../dist/index.js";

const NOW = "2026-08-29T00:00:00.000Z";

test("recovers committed Session facts after a process restart", () => {
  withRoot((root) => {
    const persistence = new FileSessionEventPersistence({ root });
    const store = deterministicStore(persistence);
    store.commitTurn("session_1", turn("turn_1", 1, "hello"));
    persistence.close();

    const reopened = new FileSessionEventPersistence({ root });
    const recovered = new SessionStore({ persistence: reopened }).snapshot("session_1");
    assert.equal(recovered?.turns[0].messages[0].message.content, "hello");
    assert.equal(recovered?.revision, 2);
    reopened.close();
  });
});

test("recovers append-only Turn context summaries without altering raw history", () => {
  withRoot((root) => {
    const persistence = new FileSessionEventPersistence({ root });
    const store = deterministicStore(persistence);
    const committed = store.commitTurn("session_1", turn("turn_1", 1, "hello"));
    store.summarizeTurns({
      sessionId: "session_1",
      expectedRevision: committed.revision,
      summaries: [{ turnId: "turn_1", summary: "The user said hello." }],
    });
    persistence.close();

    const reopened = new FileSessionEventPersistence({ root });
    const recovered = new SessionStore({ persistence: reopened }).snapshot("session_1");
    assert.equal(recovered?.turns[0].messages[0].message.content, "hello");
    assert.equal(recovered?.turns[0].contextSummary, "The user said hello.");
    assert.equal(recovered?.revision, 3);
    reopened.close();
  });
});

test("recovers an active-Turn context checkpoint and its raw history", () => {
  withRoot((root) => {
    const persistence = new FileSessionEventPersistence({ root });
    const store = deterministicStore(persistence);
    const candidate = {
      turnId: "turn_1",
      turnSequence: 1,
      createdAt: NOW,
      completedAt: NOW,
      status: "completed",
      reason: "model_response_completed",
      usage: {},
      contextCheckpoint: {
        throughMessageId: "turn_1_message_2",
        summary: "The first inspection completed; the final answer followed.",
        inputMessageCount: 1,
      },
      messages: [
        { role: "user", content: "inspect and finish" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_1", name: "read_file", argumentsText: "{}" }],
        },
        { role: "tool", toolCallId: "call_1", content: "raw durable result" },
        { role: "assistant", content: "finished", toolCalls: [] },
      ].map((message, messageIndex) => ({
        messageId: `turn_1_message_${messageIndex}`,
        turnId: "turn_1",
        turnSequence: 1,
        messageIndex,
        createdAt: NOW,
        message,
      })),
    };
    store.commitTurn("session_1", candidate);
    persistence.close();

    const reopened = new FileSessionEventPersistence({ root });
    const recovered = new SessionStore({ persistence: reopened }).snapshot("session_1");
    assert.equal(recovered?.turns[0].messages[2].message.content, "raw durable result");
    assert.match(recovered?.turns[0].contextCheckpoint.summary, /first inspection/);
    const projected = assembleContext({ session: recovered });
    assert.equal(projected.messages.some((message) => message.role === "tool"), false);
    assert.match(projected.messages[1].content, /active_turn_checkpoint/);
    reopened.close();
  });
});

test("recovers an edit rerun as one durable replacement branch", () => {
  withRoot((root) => {
    const persistence = new FileSessionEventPersistence({ root });
    const store = deterministicStore(persistence);
    store.commitTurn("session_1", turn("turn_1", 1, "keep before edit"));
    store.commitTurn("session_1", turn("turn_2", 2, "old user request"));
    store.supersedeMessages({
      sessionId: "session_1",
      messageIds: ["turn_2_message_0"],
      reason: "user_edit_regenerate",
      replacementTurnId: "turn_3",
    });
    store.commitTurn("session_1", turn("turn_3", 3, "updated user request"));
    persistence.close();

    const records = readFileSync(journalPath(root), "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    const replacementEvent = records.find(
      (record) => record.event?.kind === "messages_superseded",
    )?.event;
    assert.equal(replacementEvent?.payload.replacementTurnId, "turn_3");

    const reopened = new FileSessionEventPersistence({ root });
    const recovered = new SessionStore({ persistence: reopened }).snapshot("session_1");
    assert.deepEqual(recovered?.supersededMessageIds, ["turn_2_message_0"]);
    assert.deepEqual(
      assembleContext({ session: recovered }).messages.map((message) => message.content),
      ["keep before edit", "updated user request"],
    );
    reopened.close();
  });
});

test("removes an incomplete journal tail without inventing a Session event", () => {
  withRoot((root) => {
    const issues = [];
    const persistence = new FileSessionEventPersistence({ root });
    deterministicStore(persistence).commitTurn("session_1", turn("turn_1", 1, "hello"));
    persistence.close();
    const path = journalPath(root);
    appendFileSync(path, '{"protocol":"broken');

    const reopened = new FileSessionEventPersistence({
      root,
      onRecoveryIssue: (issue) => issues.push(issue),
    });
    assert.equal(new SessionStore({ persistence: reopened }).snapshot("session_1")?.revision, 2);
    assert.equal(issues[0]?.code, "truncated_tail_removed");
    reopened.close();
  });
});

test("fails closed on a checksummed committed-record mutation", () => {
  withRoot((root) => {
    const persistence = new FileSessionEventPersistence({ root });
    deterministicStore(persistence).commitTurn("session_1", turn("turn_1", 1, "hello"));
    persistence.close();
    const path = journalPath(root);
    writeFileSync(path, readFileSync(path, "utf8").replace("hello", "jello"));

    const reopened = new FileSessionEventPersistence({ root });
    assert.throws(
      () => new SessionStore({ persistence: reopened }).snapshot("session_1"),
      SessionJournalCorruptionError,
    );
    reopened.close();
  });
});

test("enumerates durable Sessions and preserves their explicit metadata", () => {
  withRoot((root) => {
    const persistence = new FileSessionEventPersistence({ root });
    const store = deterministicStore(persistence);
    store.ensureSession("session_a", { title: "A" });
    store.ensureSession("session_b", { title: "B" });
    persistence.close();

    const reopened = new FileSessionEventPersistence({ root });
    const sessions = new SessionStore({ persistence: reopened }).list();
    assert.deepEqual(
      sessions.map((session) => [session.sessionId, session.metadata?.title]).sort(),
      [["session_a", "A"], ["session_b", "B"]],
    );
    reopened.close();
  });
});

function deterministicStore(persistence) {
  let id = 0;
  return new SessionStore({
    persistence,
    createEventId: () => `event_${++id}`,
    now: () => NOW,
  });
}

function turn(turnId, turnSequence, content) {
  return {
    turnId,
    turnSequence,
    createdAt: NOW,
    completedAt: NOW,
    status: "completed",
    reason: "model_response_completed",
    usage: {},
    messages: [{
      messageId: `${turnId}_message_0`,
      turnId,
      turnSequence,
      messageIndex: 0,
      createdAt: NOW,
      message: { role: "user", content },
    }],
  };
}

function withRoot(run) {
  const root = mkdtempSync(join(tmpdir(), "cardbush-session-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function journalPath(root) {
  const files = readdirSync(root);
  assert.equal(files.length, 1);
  return join(root, files[0]);
}
