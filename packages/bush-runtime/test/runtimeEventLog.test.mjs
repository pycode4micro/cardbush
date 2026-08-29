import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryRuntimeEventLog,
  RuntimeCursorError,
} from "../dist/index.js";

const identity = {
  requestId: "req_log",
  sessionId: "session_log",
  turnId: "turn_log",
};

test("replays by sequence or event identity and validates combined cursors", () => {
  const log = deterministicLog();
  const accepted = log.append(identity, {
    kind: "turn_accepted",
    payload: { status: "accepted" },
  });
  const started = log.append(identity, {
    kind: "turn_started",
    payload: { status: "running" },
  });

  assert.deepEqual(
    log.replay(identity.sessionId, identity.turnId, { afterSequence: 1 }),
    [started],
  );
  assert.deepEqual(
    log.replay(identity.sessionId, identity.turnId, { lastEventId: accepted.eventId }),
    [started],
  );
  assert.throws(
    () =>
      log.replay(identity.sessionId, identity.turnId, {
        afterSequence: 2,
        lastEventId: accepted.eventId,
      }),
    (error) =>
      error instanceof RuntimeCursorError &&
      error.code === "cursor_identity_mismatch",
  );
  assert.throws(() =>
    log.replay(identity.sessionId, identity.turnId, { afterSequence: -1 }),
  );
  assert.throws(
    () =>
      log.replay(identity.sessionId, identity.turnId, {
        lastEventId: "event_from_another_turn",
      }),
    (error) =>
      error instanceof RuntimeCursorError && error.code === "cursor_event_not_found",
  );
});

test("an already aborted subscription yields no replayed events", async () => {
  const log = deterministicLog();
  log.append(identity, {
    kind: "turn_accepted",
    payload: { status: "accepted" },
  });
  const controller = new AbortController();
  controller.abort();

  assert.deepEqual(
    await collect(
      log.subscribe(
        identity.sessionId,
        identity.turnId,
        {},
        controller.signal,
      ),
    ),
    [],
  );
});

test("live subscription cannot miss events and closes on a terminal fact", async () => {
  const log = deterministicLog();
  const receivedPromise = collect(
    log.subscribe(identity.sessionId, identity.turnId),
  );
  await Promise.resolve();
  log.append(identity, {
    kind: "turn_accepted",
    payload: { status: "accepted" },
  });
  log.append(identity, {
    kind: "turn_started",
    payload: { status: "running" },
  });
  const terminal = log.append(identity, {
    kind: "turn_terminal",
    payload: { status: "completed", reason: "test", details: {} },
  });

  const received = await receivedPromise;
  assert.deepEqual(received.map((event) => event.sequence), [1, 2, 3]);
  assert.equal(received.at(-1)?.eventId, terminal.eventId);

  const afterTerminal = await collect(
    log.subscribe(identity.sessionId, identity.turnId, {
      lastEventId: terminal.eventId,
    }),
  );
  assert.deepEqual(afterTerminal, []);
  assert.throws(() =>
    log.append(identity, {
      kind: "turn_started",
      payload: { status: "running" },
    }),
  );
});

function deterministicLog() {
  return new InMemoryRuntimeEventLog({
    createEventId: ({ sequence }) => `event_${sequence}`,
    now: () => "2026-08-29T00:00:00.000Z",
  });
}

async function collect(events) {
  const values = [];
  for await (const event of events) values.push(event);
  return values;
}
