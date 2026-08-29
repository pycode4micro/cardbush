import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FileSubagentTaskPersistence,
  SubagentJournalCorruptionError,
  SubagentTaskStore,
} from "../dist/index.js";

test("persists Subagent lifecycle facts and fails closed after committed corruption", (t) => {
  const root = mkdtempSync(join(tmpdir(), "cardbush-subagent-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const persistence = new FileSubagentTaskPersistence({ root });
  const store = new SubagentTaskStore({ persistence, now: () => NOW });
  store.start(startInput());
  store.finish({
    parentSessionId: "parent",
    taskId: "task_1",
    status: "completed",
    finalResponse: "done",
    errorMessage: "",
    usage: { outputTokens: 1 },
  });
  persistence.close();

  const reopened = new FileSubagentTaskPersistence({ root });
  assert.equal(new SubagentTaskStore({ persistence: reopened }).get("parent", "task_1")?.finalResponse, "done");
  reopened.close();

  const path = join(root, readdirSync(root)[0]);
  writeFileSync(path, readFileSync(path, "utf8").replace('"done"', '"tampered"'));
  const corrupted = new FileSubagentTaskPersistence({ root });
  assert.throws(
    () => new SubagentTaskStore({ persistence: corrupted }).list("parent"),
    SubagentJournalCorruptionError,
  );
  corrupted.close();
});

test("replays journals written before Team origin fields existed without changing checksums", (t) => {
  const root = mkdtempSync(join(tmpdir(), "cardbush-subagent-old-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const event = {
    protocol: "bush.subagent_event.v1",
    eventId: "old_event",
    sequence: 1,
    parentSessionId: "parent",
    taskId: "old_task",
    createdAt: NOW,
    task: {
      protocol: "bush.subagent_task.v1",
      taskId: "old_task",
      parentSessionId: "parent",
      parentTurnId: "parent_turn",
      childSessionId: "child",
      childTurnId: "child_turn",
      prompt: "legacy work",
      inheritContext: true,
      inheritedMessageCount: 1,
      status: "running",
      finalResponse: "",
      errorMessage: "",
      usage: {},
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    },
  };
  const serialized = JSON.stringify(event);
  const record = {
    protocol: "bush.subagent_journal_record.v1",
    checksum: createHash("sha256").update(serialized).digest("hex"),
    event,
  };
  writeFileSync(join(root, `${createHash("sha256").update("parent").digest("hex")}.jsonl`), `${JSON.stringify(record)}\n`);
  const persistence = new FileSubagentTaskPersistence({ root });
  const loaded = new SubagentTaskStore({ persistence }).get("parent", "old_task");
  assert.equal(loaded?.prompt, "legacy work");
  assert.equal(loaded?.origin, undefined);
  persistence.close();
});

function startInput() {
  return {
    taskId: "task_1",
    parentSessionId: "parent",
    parentTurnId: "parent_turn",
    childSessionId: "child",
    childTurnId: "child_turn",
    prompt: "work",
    inheritContext: true,
    inheritedMessageCount: 2,
  };
}

const NOW = "2026-08-29T00:00:00.000Z";
