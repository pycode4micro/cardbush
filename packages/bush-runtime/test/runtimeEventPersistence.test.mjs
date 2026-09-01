import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FileRuntimeEventPersistence,
  InMemoryRuntimeEventLog,
  RuntimeEventJournalCorruptionError,
} from "../dist/index.js";

const identity = {
  requestId: "request_persistence",
  sessionId: "session_persistence",
  turnId: "turn_persistence",
};

test("replays persisted events after a Runtime Event Log restart", (t) => {
  const root = temporaryRoot(t);
  const persistence = new FileRuntimeEventPersistence({ root });
  const first = eventLog(persistence);
  first.append(identity, {
    kind: "turn_accepted",
    payload: { status: "accepted" },
  });
  first.append(identity, {
    kind: "turn_started",
    payload: { status: "running" },
  });

  const restartedPersistence = new FileRuntimeEventPersistence({ root });
  const restarted = eventLog(restartedPersistence);
  const replay = restarted.replay(identity.sessionId, identity.turnId);
  assert.deepEqual(replay.map((event) => event.sequence), [1, 2]);
  assert.deepEqual(replay.map((event) => event.kind), [
    "turn_accepted",
    "turn_started",
  ]);

  const terminal = restarted.append(identity, {
    kind: "turn_terminal",
    payload: { status: "stopped", reason: "host_restart", details: {} },
  });
  assert.equal(terminal.sequence, 3);
  persistence.close();
  restartedPersistence.close();
});

test("does not publish an event when durable append fails", () => {
  const log = eventLog({
    load: () => [],
    append() {
      throw new Error("disk unavailable");
    },
  });

  assert.throws(() =>
    log.append(identity, {
      kind: "turn_accepted",
      payload: { status: "accepted" },
    }),
  );
  assert.deepEqual(log.replay(identity.sessionId, identity.turnId), []);
});

test("removes only an incomplete trailing record and reports the recovery fact", (t) => {
  const root = temporaryRoot(t);
  const writer = new FileRuntimeEventPersistence({ root });
  const first = eventLog(writer);
  first.append(identity, {
    kind: "turn_accepted",
    payload: { status: "accepted" },
  });
  writer.close();
  const journal = join(root, readdirSync(root)[0]);
  appendFileSync(journal, '{"protocol":"incomplete"', "utf8");
  const issues = [];

  const persistence = new FileRuntimeEventPersistence({
    root,
    onRecoveryIssue: (issue) => issues.push(issue),
  });
  const replay = eventLog(persistence).replay(identity.sessionId, identity.turnId);

  assert.equal(replay.length, 1);
  assert.equal(issues[0].code, "truncated_tail_removed");
  assert.ok(issues[0].removedBytes > 0);
  assert.ok(readFileSync(journal, "utf8").endsWith("\n"));
});

test("fails closed for a complete corrupted journal record", (t) => {
  const root = temporaryRoot(t);
  const writer = new FileRuntimeEventPersistence({ root });
  eventLog(writer).append(identity, {
    kind: "turn_accepted",
    payload: { status: "accepted" },
  });
  writer.close();
  const journal = join(root, readdirSync(root)[0]);
  const corrupted = readFileSync(journal, "utf8").replace(
    '"status":"accepted"',
    '"status":"running"',
  );
  writeFileSync(journal, corrupted, "utf8");

  assert.throws(
    () =>
      eventLog(new FileRuntimeEventPersistence({ root })).replay(
        identity.sessionId,
        identity.turnId,
      ),
    RuntimeEventJournalCorruptionError,
  );
});

test("verifies the persisted bytes before schema defaults are applied", (t) => {
  const root = temporaryRoot(t);
  const writer = new FileRuntimeEventPersistence({ root });
  eventLog(writer).append(identity, {
    kind: "tool_failed",
    payload: {
      toolCallId: "call_legacy_error",
      toolName: "fixture_tool",
      ordinal: 0,
      error: {
        kind: "tool",
        code: "fixture_failure",
        message: "fixture failed",
        details: {},
      },
    },
  });
  writer.close();

  const journal = join(root, readdirSync(root)[0]);
  const persisted = JSON.parse(readFileSync(journal, "utf8"));
  delete persisted.event.payload.error.kind;
  persisted.checksum = createHash("sha256")
    .update(JSON.stringify(persisted.event))
    .digest("hex");
  writeFileSync(journal, `${JSON.stringify(persisted)}\n`, "utf8");

  const [recovered] = new FileRuntimeEventPersistence({ root }).load(
    identity.sessionId,
    identity.turnId,
  );
  assert.equal(recovered.payload.error.kind, "tool");
});

test("rejects persisted sequence gaps and identity conflicts mechanically", () => {
  const accepted = eventLog().append(identity, {
    kind: "turn_accepted",
    payload: { status: "accepted" },
  });
  const badSequence = { ...accepted, sequence: 2 };
  const badIdentity = { ...accepted, sessionId: "different_session" };

  assert.throws(() =>
    eventLog({ load: () => [badSequence], append() {} }).replay(
      identity.sessionId,
      identity.turnId,
    ),
  );
  assert.throws(() =>
    eventLog({ load: () => [badIdentity], append() {} }).replay(
      identity.sessionId,
      identity.turnId,
    ),
  );
});

test("requires an explicit absolute persistence root", () => {
  assert.throws(
    () => new FileRuntimeEventPersistence({ root: "relative/runtime-events" }),
    /must be absolute/,
  );
});

function eventLog(persistence) {
  return new InMemoryRuntimeEventLog({
    persistence,
    createEventId: ({ sequence }) => `event_persistence_${sequence}`,
    now: () => "2026-08-29T00:00:00.000Z",
  });
}

function temporaryRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "cardbush-runtime-events-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
