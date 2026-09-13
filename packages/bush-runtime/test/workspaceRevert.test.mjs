import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CREATE_RUNTIME_SESSION_COMMAND,
  GET_RUNTIME_SESSION_COMMAND,
  REVERT_RUNTIME_WORKSPACE_CHANGES_COMMAND,
  RESTORE_RUNTIME_WORKSPACE_CHANGES_COMMAND,
  RUNTIME_REVERTED_WORKSPACE_CHANGE_IDS_METADATA_KEY,
  UPDATE_RUNTIME_SESSION_METADATA_COMMAND,
} from "@cardbush/bush-protocol";
import {
  InMemoryRuntimeHost,
  ToolExecutionCoordinator,
  ToolExecutionStore,
  ToolRegistry,
  WorkspaceObservationStore,
  SessionStore,
  FileSessionEventPersistence,
  FileToolExecutionPersistence,
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
  assert.deepEqual(result.revertedChangeIds, [edited.workspaceChanges[0].change_id]);
  const session = await setup.host.sendCommand({
    kind: GET_RUNTIME_SESSION_COMMAND,
    payload: { sessionId: setup.sessionId },
  });
  assert.deepEqual(
    session.metadata[RUNTIME_REVERTED_WORKSPACE_CHANGE_IDS_METADATA_KEY],
    result.revertedChangeIds,
  );
  assert.equal((await setup.revert(["turn-1"])).revertedFiles, 0);
  const restored = await setup.restore(["turn-1"]);
  assert.equal(restored.restoredFiles, 1);
  assert.equal(readFileSync(path, "utf8"), "after");
  assert.deepEqual(restored.restoredChangeIds, result.revertedChangeIds);
  assert.equal((await setup.restore(["turn-1"])).restoredFiles, 0);
  assert.deepEqual((await setup.host.sendCommand({ kind: GET_RUNTIME_SESSION_COMMAND,
    payload: { sessionId: setup.sessionId } })).metadata[RUNTIME_REVERTED_WORKSPACE_CHANGE_IDS_METADATA_KEY], []);
  assert.equal((await setup.revert(["turn-1"])).revertedFiles, 1, 'a restored edit can be reverted again');
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
    (error) => error?.code === "runtime_workspace_snapshot_unavailable",
  );
});

test("restores a previously empty file in direct mode", async (t) => {
  const setup = await environment(t, "empty-before-session");
  const path = join(setup.root, "empty.txt");
  writeFileSync(path, "");
  await setup.execute("turn-1", 1, "read_file", { path });
  await setup.execute("turn-1", 2, "write_file", { path, content: "after" });
  assert.equal((await setup.revert(["turn-1"])).revertedFiles, 1);
  assert.equal(readFileSync(path).length, 0);
});

test("replays a historical workspace change after its project folder is renamed", async (t) => {
  const setup = await environment(t, "renamed-project-session");
  const previousPath = join(setup.root, "file.txt");
  writeFileSync(previousPath, "before");
  await setup.execute("turn-1", 1, "read_file", { path: previousPath });
  await setup.execute("turn-1", 2, "edit_file", {
    path: previousPath,
    old_text: "before",
    new_text: "after",
  });

  const nextRoot = `${setup.root}-renamed`;
  t.after(() => rmSync(nextRoot, { recursive: true, force: true }));
  renameSync(setup.root, nextRoot);
  const session = await setup.host.sendCommand({
    kind: GET_RUNTIME_SESSION_COMMAND,
    payload: { sessionId: setup.sessionId },
  });
  await setup.host.sendCommand({
    kind: UPDATE_RUNTIME_SESSION_METADATA_COMMAND,
    payload: {
      sessionId: setup.sessionId,
      expectedRevision: session.revision,
      metadata: {
        ...session.metadata,
        projectDir: nextRoot,
        project_path_aliases: [{ from: setup.root, to: nextRoot }],
      },
    },
  });

  const result = await setup.revert(["turn-1"]);
  assert.equal(result.revertedFiles, 1);
  assert.equal(readFileSync(join(nextRoot, "file.txt"), "utf8"), "before");
});

test('restores chained edits across Turns in forward order and rejects partial conflicting restores', async t => {
  const setup = await environment(t, 'redo-ordered');
  const file = join(setup.root, 'file.txt'), other = join(setup.root, 'other.txt');
  writeFileSync(file, 'A');
  await setup.execute('one', 1, 'read_file', { path: file });
  await setup.execute('one', 2, 'write_file', { path: file, content: 'B' });
  await setup.execute('one', 3, 'write_file', { path: file, content: 'C' });
  await setup.execute('two', 1, 'write_file', { path: file, content: 'D' });
  await setup.execute('two', 2, 'write_file', { path: other, content: 'new file' });
  await setup.revert(['two', 'one']);
  writeFileSync(other, 'user created this');
  await assert.rejects(setup.restore(['one', 'two']), /revision no longer matches/);
  assert.equal(readFileSync(file, 'utf8'), 'A', 'every change is checked before any write');
  assert.equal(readFileSync(other, 'utf8'), 'user created this');
  rmSync(other);
  await assert.rejects(setup.restore(['two', 'one']), /revision no longer matches/);
  await setup.restore(['one', 'two']);
  assert.equal(readFileSync(file, 'utf8'), 'D');
  assert.equal(readFileSync(other, 'utf8'), 'new file');
});

test('retains redo bytes across host restart and rejects missing or corrupted bytes without changing files', async t => {
  const setup = await environment(t, 'redo-restart', true);
  const file = join(setup.root, 'empty.txt');
  writeFileSync(file, '');
  await setup.execute('one', 1, 'read_file', { path: file });
  const outcome = await setup.execute('one', 2, 'write_file', { path: file, content: 'after\r\n中文' });
  await setup.revert(['one']);
  const hash = outcome.workspaceChanges[0].after_hash;
  const savedPath = join(setup.dataRoot, 'workspace-redo', hash);
  const after = readFileSync(savedPath);
  const reopened = setup.reopen();
  const restore = () => reopened.sendCommand({ kind: RESTORE_RUNTIME_WORKSPACE_CHANGES_COMMAND,
    payload: { sessionId: setup.sessionId, turnIds: ['one'] } });
  writeFileSync(savedPath, 'corrupted');
  await assert.rejects(restore(), /does not match/);
  assert.equal(readFileSync(file).length, 0);
  rmSync(savedPath);
  await assert.rejects(restore(), /unavailable/);
  assert.equal(readFileSync(file).length, 0);
  writeFileSync(savedPath, after);
  assert.equal((await restore()).restoredFiles, 1);
  assert.deepEqual(readFileSync(file), after);
});

async function environment(t, sessionId, persistent = false) {
  const root = mkdtempSync(join(tmpdir(), "cardbush-workspace-revert-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const registry = new ToolRegistry();
  registerWorkspaceTools(registry, new WorkspaceObservationStore());
  const toolPersistence = persistent ? new FileToolExecutionPersistence({ root: join(root, 'tool-journal') }) : undefined;
  const sessionPersistence = persistent ? new FileSessionEventPersistence({ root: join(root, 'session-journal') }) : undefined;
  if (persistent) t.after(() => { toolPersistence.close(); sessionPersistence.close(); });
  const store = new ToolExecutionStore({ persistence: toolPersistence });
  const coordinator = new ToolExecutionCoordinator({
    registry,
    permissions: { request: async () => { throw new Error("unexpected permission"); } },
  });
  const sessionStore = new SessionStore({ persistence: sessionPersistence });
  const dataRoot = persistent ? join(root, 'runtime') : undefined;
  const reopen = () => new InMemoryRuntimeHost({
    toolExecutionStore: persistent ? new ToolExecutionStore({ persistence: toolPersistence }) : store,
    sessionStore: persistent ? new SessionStore({ persistence: sessionPersistence }) : sessionStore,
    dataRoot,
    registerDefaultWorkspaceTools: false,
  });
  const host = reopen();
  await host.sendCommand({
    kind: CREATE_RUNTIME_SESSION_COMMAND,
    payload: { sessionId, metadata: { projectDir: root } },
  });
  let ordinal = 0;
  return {
    root,
    sessionId,
    host,
    reopen, dataRoot,
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
      assert.equal(outcome.kind, "returned");
      store.record(toolCall, identity, outcome);
      return outcome;
    },
    restore(turnIds) {
      return host.sendCommand({ kind: RESTORE_RUNTIME_WORKSPACE_CHANGES_COMMAND, payload: { sessionId, turnIds } });
    },
    revert(turnIds) {
      return host.sendCommand({
        kind: REVERT_RUNTIME_WORKSPACE_CHANGES_COMMAND,
        payload: { sessionId, turnIds },
      });
    },
  };
}
