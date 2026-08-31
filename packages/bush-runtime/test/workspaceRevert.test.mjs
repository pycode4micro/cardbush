import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CREATE_RUNTIME_SESSION_COMMAND,
  GET_RUNTIME_SESSION_COMMAND,
  REVERT_RUNTIME_WORKSPACE_CHANGES_COMMAND,
  RUNTIME_REVERTED_WORKSPACE_CHANGE_IDS_METADATA_KEY,
} from "@cardbush/bush-protocol";
import {
  InMemoryRuntimeHost,
  ToolExecutionCoordinator,
  ToolExecutionStore,
  ToolRegistry,
  WorkspaceObservationStore,
  registerWorkspaceTools,
} from "../dist/index.js";

test("reverts one Turn and persists reverted Workspace Change identities", async (t) => {
  const setup = await environment(t, "single-session");
  const path = join(setup.root, "file.txt");
  writeFileSync(path, "before");
  await setup.execute("turn-1", 1, "read_file", { path });
  const edited = await setup.execute("turn-1", 1, "edit_file", {
    path,
    old_text: "before",
    new_text: "after",
  });

  const result = await setup.revert(["turn-1"]);
  assert.equal(readFileSync(path, "utf8"), "before");
  assert.equal(result.revertedFiles, 1);
  assert.deepEqual(result.revertedChangeIds, [edited.result.workspace_changes[0].change_id]);
  const session = await setup.host.sendCommand({
    kind: GET_RUNTIME_SESSION_COMMAND,
    payload: { sessionId: setup.sessionId },
  });
  assert.deepEqual(
    session.metadata[RUNTIME_REVERTED_WORKSPACE_CHANGE_IDS_METADATA_KEY],
    result.revertedChangeIds,
  );
  assert.equal((await setup.revert(["turn-1"])).revertedFiles, 0);
});

test("uses caller Turn order before reversing executions inside each Turn", async (t) => {
  const setup = await environment(t, "ordered-session");
  const path = join(setup.root, "file.txt");
  writeFileSync(path, "A");
  await setup.execute("turn-1", 9, "read_file", { path });
  await setup.execute("turn-1", 10, "edit_file", {
    path,
    old_text: "A",
    new_text: "B",
  });
  await setup.execute("turn-2", 1, "edit_file", {
    path,
    old_text: "B",
    new_text: "C",
  });

  const result = await setup.revert(["turn-2", "turn-1"]);
  assert.equal(result.revertedFiles, 1);
  assert.equal(readFileSync(path, "utf8"), "A");
});

test("preflights every revision before mutating any file", async (t) => {
  const setup = await environment(t, "atomic-session");
  const first = join(setup.root, "first.txt");
  const second = join(setup.root, "second.txt");
  writeFileSync(first, "first-before");
  writeFileSync(second, "second-before");
  await setup.execute("turn-1", 1, "read_file", { path: first });
  await setup.execute("turn-1", 1, "edit_file", {
    path: first,
    old_text: "first-before",
    new_text: "first-after",
  });
  await setup.execute("turn-1", 1, "read_file", { path: second });
  await setup.execute("turn-1", 1, "edit_file", {
    path: second,
    old_text: "second-before",
    new_text: "second-after",
  });
  writeFileSync(first, "external-change");

  await assert.rejects(
    setup.revert(["turn-1"]),
    /current revision no longer matches/,
  );
  assert.equal(readFileSync(first, "utf8"), "external-change");
  assert.equal(readFileSync(second, "utf8"), "second-after");
});

test("reports an unavailable Runtime snapshot instead of a false zero-file success", async (t) => {
  const setup = await environment(t, "missing-session");
  await assert.rejects(
    setup.revert(["turn-without-records"]),
    /runtime_workspace_snapshot_unavailable/,
  );
});

async function environment(t, sessionId) {
  const root = mkdtempSync(join(tmpdir(), "cardbush-workspace-revert-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const registry = new ToolRegistry();
  registerWorkspaceTools(registry, new WorkspaceObservationStore());
  const store = new ToolExecutionStore();
  const coordinator = new ToolExecutionCoordinator({
    registry,
    permissions: { request: async () => { throw new Error("unexpected permission"); } },
  });
  const host = new InMemoryRuntimeHost({
    toolExecutionStore: store,
    registerDefaultWorkspaceTools: false,
  });
  await host.sendCommand({
    kind: CREATE_RUNTIME_SESSION_COMMAND,
    payload: { sessionId, metadata: { projectDir: root } },
  });
  let ordinal = 0;
  return {
    root,
    sessionId,
    host,
    async execute(turnId, round, name, input) {
      const toolCall = {
        protocol: "bush.tool_call.v1",
        id: `call_${ordinal}`,
        name,
        argumentsText: JSON.stringify(input),
      };
      const identity = {
        requestId: `request_${turnId}`,
        sessionId,
        turnId,
        round,
        ordinal: ordinal++,
      };
      const outcome = await coordinator.execute(
        toolCall,
        identity,
        undefined,
        {
          request: {
            protocol: "bush.model_request.v1",
            requestId: identity.requestId,
            sessionId,
            turnId,
            model: "test-model",
            messages: [],
            tools: registry.definitions(),
            metadata: { workspaceDir: root },
          },
          contextMessages: [],
        },
      );
      assert.equal(outcome.kind, "completed");
      store.record(toolCall, identity, outcome);
      return outcome;
    },
    revert(turnIds) {
      return host.sendCommand({
        kind: REVERT_RUNTIME_WORKSPACE_CHANGES_COMMAND,
        payload: { sessionId, turnIds },
      });
    },
  };
}
