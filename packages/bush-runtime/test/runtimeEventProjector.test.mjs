import assert from "node:assert/strict";
import test from "node:test";

import {
  BUSH_MODEL_EVENT_PROTOCOL,
} from "@cardbush/bush-protocol";
import {
  InMemoryRuntimeEventLog,
  RuntimeEventProjector,
} from "../dist/index.js";

const identity = {
  requestId: "req_projector",
  sessionId: "session_projector",
  turnId: "turn_projector",
};

const modelBase = {
  protocol: BUSH_MODEL_EVENT_PROTOCOL,
  requestId: identity.requestId,
  createdAt: "2026-08-29T00:00:00.000Z",
};

test("projects reasoning and assistant text into separate stable segments", () => {
  const log = deterministicLog();
  let segment = 0;
  const projector = new RuntimeEventProjector(log, identity, {
    createMessageId: () => "message_1",
    createSegmentId: () => `segment_${++segment}`,
  });

  projector.accept({ ...modelBase, sequence: 0, kind: "reasoning_delta", delta: "A" });
  projector.accept({ ...modelBase, sequence: 1, kind: "reasoning_delta", delta: "B" });
  projector.accept({ ...modelBase, sequence: 2, kind: "text_delta", delta: "C" });
  projector.accept({ ...modelBase, sequence: 3, kind: "response_completed" });

  const events = log.replay(identity.sessionId, identity.turnId);
  assert.deepEqual(events.map((event) => event.kind), [
    "reasoning_segment_started",
    "reasoning_segment_delta",
    "reasoning_segment_delta",
    "reasoning_segment_completed",
    "assistant_segment_started",
    "assistant_segment_delta",
    "assistant_segment_completed",
  ]);
  assert.equal(events[3].payload.content, "AB");
  assert.equal(events[6].payload.content, "C");
  assert.equal(events[0].payload.messageId, events[4].payload.messageId);
  assert.notEqual(events[0].payload.segmentId, events[4].payload.segmentId);
  assert.equal(projector.finalMessageId, "message_1");
});

test("does not fabricate a final assistant message for reasoning-only output", () => {
  const log = deterministicLog();
  const projector = new RuntimeEventProjector(log, identity, {
    createMessageId: () => "message_reasoning_only",
    createSegmentId: () => "segment_reasoning_only",
  });
  projector.accept({ ...modelBase, sequence: 0, kind: "reasoning_delta", delta: "A" });
  projector.accept({ ...modelBase, sequence: 1, kind: "response_failed", code: "x", message: "x", retryable: false });

  assert.equal(projector.finalMessageId, undefined);
});

function deterministicLog() {
  return new InMemoryRuntimeEventLog({
    createEventId: ({ sequence }) => `event_${sequence}`,
    now: () => "2026-08-29T00:00:00.000Z",
  });
}
