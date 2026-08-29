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
