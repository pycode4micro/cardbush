import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  GET_RUNTIME_CAPABILITIES_COMMAND,
  decodeRuntimeFixture,
} from "../dist/index.js";

const fixtureUrl = new URL(
  "../reference-fixtures/single-turn-stream.v1.json",
  import.meta.url,
);

test("single-turn fixture is a complete replayable product stream", async () => {
  const fixture = decodeRuntimeFixture(
    JSON.parse(await readFile(fixtureUrl, "utf8")),
  );
  const events = fixture.events.map((frame) => frame.event);
  const capabilities =
    fixture.commandResponses[GET_RUNTIME_CAPABILITIES_COMMAND];

  assert.equal(events[0].kind, "turn_accepted");
  assert.equal(events[1].kind, "turn_started");
  assert.deepEqual(
    events.filter((event) => event.kind.includes("reasoning")).map((event) => event.kind),
    [
      "reasoning_segment_started",
      "reasoning_segment_delta",
      "reasoning_segment_completed",
    ],
  );
  assert.deepEqual(
    events.filter((event) => event.kind.includes("assistant")).map((event) => event.kind),
    [
      "assistant_segment_started",
      "assistant_segment_delta",
      "assistant_segment_completed",
    ],
  );
  assert.equal(events.at(-1)?.kind, "turn_terminal");
  assert.equal(events.at(-1)?.payload.status, "completed");
  assert.ok(
    capabilities.supportedCommands.includes(GET_RUNTIME_CAPABILITIES_COMMAND),
  );
  assert.ok(events.every((event) => capabilities.supportedEvents.includes(event.kind)));
  assert.deepEqual(
    events.map((event) => event.sequence),
    [...events.keys()].map((index) => index + 1),
  );
  assert.equal(new Set(events.map((event) => event.eventId)).size, events.length);
});
