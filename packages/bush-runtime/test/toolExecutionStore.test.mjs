import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FileToolExecutionPersistence,
  ToolExecutionJournalCorruptionError,
  ToolExecutionStore,
} from "../dist/index.js";

test("persists native results and Runtime-owned workspace changes", (t) => {
  const root = temporaryRoot(t);
  const persistence = new FileToolExecutionPersistence({ root });
  const store = new ToolExecutionStore({ persistence, now: () => NOW });
  const saved = store.record(toolCall(), identity(), outcome());
  persistence.close();

  assert.deepEqual(saved.result.artifacts.map((item) => item.artifact_id), ["artifact_1"]);
  assert.deepEqual(saved.workspaceChanges.map((item) => item.change_id), ["change_1"]);
  const reopened = new FileToolExecutionPersistence({ root });
  const recovered = new ToolExecutionStore({ persistence: reopened });
  assert.equal(recovered.get("session_1", "turn_1", "call_1")?.result.value, "ok");
  assert.equal(recovered.listTurn("session_1", "turn_1").length, 1);
  reopened.close();
});

test("rejects conflicting identities and duplicate Runtime workspace changes", () => {
  const store = new ToolExecutionStore({ now: () => NOW });
  store.record(toolCall(), identity(), outcome());
  assert.throws(
    () => store.record(toolCall(), identity(), outcome({ result: { value: "changed" } })),
    /different record/,
  );
  assert.throws(
    () => new ToolExecutionStore({ now: () => NOW }).record(
      toolCall(),
      identity(),
      outcome({ workspaceChanges: [workspaceChange(), workspaceChange()] }),
    ),
    /duplicate Workspace Change/,
  );
});

test("fails closed when a complete persisted Tool record is mutated", (t) => {
  const root = temporaryRoot(t);
  const persistence = new FileToolExecutionPersistence({ root });
  new ToolExecutionStore({ persistence, now: () => NOW }).record(
    toolCall(),
    identity(),
    outcome(),
  );
  persistence.close();
  const path = join(root, readdirSync(root)[0]);
  writeFileSync(path, readFileSync(path, "utf8").replace('"ok"', '"no"'));
  const reopened = new FileToolExecutionPersistence({ root });
  assert.throws(
    () => new ToolExecutionStore({ persistence: reopened }).listTurn("session_1", "turn_1"),
    ToolExecutionJournalCorruptionError,
  );
  reopened.close();
});

test("checks persisted Tool bytes before adding protocol defaults", (t) => {
  const root = temporaryRoot(t);
  const persistence = new FileToolExecutionPersistence({ root });
  const failed = outcome({
    kind: "failed",
    result: undefined,
    error: {
      kind: "tool",
      code: "fixture_failure",
      message: "fixture failed",
      details: {},
    },
  });
  new ToolExecutionStore({ persistence, now: () => NOW }).record(
    toolCall(),
    identity(),
    failed,
  );
  persistence.close();

  const path = join(root, readdirSync(root)[0]);
  const persisted = JSON.parse(readFileSync(path, "utf8"));
  delete persisted.record.error.kind;
  persisted.checksum = createHash("sha256")
    .update(JSON.stringify(persisted.record))
    .digest("hex");
  writeFileSync(path, `${JSON.stringify(persisted)}\n`, "utf8");

  const [recovered] = new FileToolExecutionPersistence({ root }).load("session_1");
  assert.equal(recovered.error.kind, "tool");
});

const NOW = "2026-08-29T00:00:00.000Z";

function identity() {
  return {
    requestId: "request_1",
    sessionId: "session_1",
    turnId: "turn_1",
    round: 1,
    ordinal: 0,
  };
}

function toolCall() {
  return {
    protocol: "bush.tool_call.v1",
    id: "call_1",
    name: "fixture_tool",
    argumentsText: "{}",
  };
}

function artifact() {
  return {
    artifact_id: "artifact_1",
    type: "image",
    path: "C:\\tmp\\image.png",
    media_type: "image/png",
    display: "inline",
    metadata: {},
  };
}

function workspaceChange() {
  return {
    change_id: "change_1",
    path: "src/file.ts",
    status: "modified",
    additions: 1,
    deletions: 0,
    metadata: {},
  };
}

function outcome(overrides = {}) {
  const manifest = {
    protocol: "bush.tool.action_manifest.v1",
    manifest_id: "attempt:turn_1:1:call_1",
    effect_kind: "observation",
    operation: "fixture.read",
    risk: "low",
    owner: "fixture",
    dispatch_scope: "turn",
    mutating: false,
  };
  const base = {
    kind: "returned",
    actionManifest: manifest,
    result: { value: "ok", artifacts: [artifact()] },
    workspaceChanges: [workspaceChange()],
  };
  return { ...base, ...overrides };
}

function temporaryRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "cardbush-tool-facts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
