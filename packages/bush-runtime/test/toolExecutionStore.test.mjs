import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FileToolExecutionPersistence,
  ToolExecutionJournalCorruptionError,
  ToolExecutionStore,
} from "../dist/index.js";

test("persists authoritative facts, artifacts and workspace changes", (t) => {
  const root = temporaryRoot(t);
  const persistence = new FileToolExecutionPersistence({ root });
  const store = new ToolExecutionStore({ persistence, now: () => NOW });
  const saved = store.record(toolCall(), identity(), outcome());
  persistence.close();

  assert.deepEqual(saved.result.artifacts.map((item) => item.artifact_id), ["artifact_1"]);
  assert.deepEqual(saved.result.workspace_changes.map((item) => item.change_id), ["change_1"]);
  const reopened = new FileToolExecutionPersistence({ root });
  const recovered = new ToolExecutionStore({ persistence: reopened });
  assert.equal(recovered.get("session_1", "turn_1", "call_1")?.result.output.value, "ok");
  assert.equal(recovered.listTurn("session_1", "turn_1").length, 1);
  reopened.close();
});

test("rejects conflicting identities and duplicate artifact references", () => {
  const store = new ToolExecutionStore({ now: () => NOW });
  store.record(toolCall(), identity(), outcome());
  assert.throws(
    () => store.record(toolCall(), identity(), outcome({ output: { value: "changed" } })),
    /different facts/,
  );
  assert.throws(
    () => new ToolExecutionStore({ now: () => NOW }).record(
      toolCall(),
      identity(),
      outcome({ artifacts: [artifact(), artifact()] }),
    ),
    /duplicate Artifact/,
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

function outcome(overrides = {}) {
  const manifest = {
    protocol: "bush.tool.action_manifest.v1",
    manifest_id: "attempt:turn_1:1:call_1",
    effect_kind: "observation",
    operation: "fixture.read",
    risk: "low",
    owner: "fixture",
    dispatch_phase: "execution",
    dispatch_scope: "turn",
    dispatch_side_effect: "none",
    dispatch_mutating: false,
    dispatch_source: "registered_tool",
    stage_modes: ["execute"],
    output_kinds: ["structured_data"],
    handoff_exports: [],
    evidence_hints: ["observation"],
  };
  return {
    kind: "completed",
    actionManifest: manifest,
    result: {
      protocol: "bush.tool_result.v1",
      tool_call_id: "call_1",
      success: true,
      output: { value: "ok" },
      facts: [{
        protocol: "bush.tool.execution_fact.v1",
        receipt_id: "receipt_1",
        action_manifest_id: manifest.manifest_id,
        status: "succeeded",
        operation: manifest.operation,
        effect_kind: manifest.effect_kind,
        owner: manifest.owner,
        dispatch_scope: manifest.dispatch_scope,
        categories: ["observation"],
        paths: [],
        execution_success: true,
        semantic_success: true,
        verification_state: "verified",
        error_code: "",
      }],
      artifacts: [artifact()],
      workspace_changes: [{
        change_id: "change_1",
        path: "src/file.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        metadata: {},
      }],
      ...overrides,
    },
  };
}

function temporaryRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "cardbush-tool-facts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
