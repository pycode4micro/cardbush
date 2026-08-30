import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ToolExecutionCoordinator,
  ToolRegistry,
  WorkspaceObservationStore,
  registerWorkspaceTools,
} from "../dist/index.js";

test("requires an exact observed revision before edit and permits inherited fork evidence", async (t) => {
  const root = temporaryRoot(t);
  const path = join(root, "file.txt");
  writeFileSync(path, "before\n");
  const setup = tools(root);

  const rejected = await setup.execute("child", "edit_file", {
    path,
    old_text: "before",
    new_text: "after",
  });
  assert.equal(rejected.kind, "failed");
  assert.match(rejected.result.error.message, /read_file first/);

  const read = await setup.execute("parent", "read_file", { path });
  assert.equal(read.kind, "completed");
  const edited = await setup.execute("child", "edit_file", {
    path,
    old_text: "before",
    new_text: "after",
  }, { inheritedObservationSessionId: "parent" });
  assert.equal(edited.kind, "completed");
  assert.equal(readFileSync(path, "utf8"), "after\n");
  assert.equal(edited.result.workspace_changes[0].status, "modified");
  assert.equal(edited.result.workspace_changes[0].additions, 1);
  assert.equal(edited.result.workspace_changes[0].deletions, 1);
  assert.match(edited.result.workspace_changes[0].metadata.diff, /-before/);
  assert.match(edited.result.workspace_changes[0].metadata.diff, /\+after/);
});

test("invalidates read evidence when the file changes outside Runtime", async (t) => {
  const root = temporaryRoot(t);
  const path = join(root, "file.txt");
  writeFileSync(path, "observed");
  const setup = tools(root);

  assert.equal((await setup.execute("session", "read_file", { path })).kind, "completed");
  writeFileSync(path, "changed externally");
  const outcome = await setup.execute("session", "edit_file", {
    path,
    old_text: "changed externally",
    new_text: "edited",
  });

  assert.equal(outcome.kind, "failed");
  assert.match(outcome.result.error.message, /has not been observed/);
});

test("writes new files, treats search no-match as a successful fact, and reports exit codes", async (t) => {
  const root = temporaryRoot(t);
  const setup = tools(root);
  const path = join(root, "new.txt");
  const written = await setup.execute("session", "write_file", {
    path,
    content: "hello",
  });
  assert.equal(written.kind, "completed");
  assert.equal(written.result.workspace_changes[0].status, "added");

  const searched = await setup.execute("session", "search_file_content", {
    path: root,
    query: "absent-value",
  });
  assert.equal(searched.kind, "completed");
  assert.equal(searched.result.output.matched, false);

  const terminal = await setup.execute("session", "terminal_exec", {
    command: "node -e \"process.stdout.write('ok')\"",
    cwd: root,
  });
  assert.equal(terminal.kind, "completed");
  assert.equal(terminal.result.output.exitCode, 0);
  assert.equal(terminal.result.output.stdout, "ok");

  const nonzero = await setup.execute("session", "terminal_exec", {
    command: "node -e \"process.stdout.write('out'); process.stderr.write('err'); process.exit(7)\"",
    cwd: root,
  });
  assert.equal(nonzero.kind, "failed");
  assert.equal(nonzero.result.success, false);
  assert.equal(nonzero.result.error.code, "terminal_exit_nonzero");
  assert.equal(nonzero.result.output.exitCode, 7);
  assert.equal(nonzero.result.output.stdout, "out");
  assert.equal(nonzero.result.output.stderr, "err");
});

test("uses absolute filesystem paths safely when a Turn has no workspace", async (t) => {
  const external = temporaryRoot(t);
  const path = join(external, "desktop-file.txt");
  const registry = new ToolRegistry();
  registerWorkspaceTools(registry, new WorkspaceObservationStore());
  const permissionRequests = [];
  const coordinator = new ToolExecutionCoordinator({
    registry,
    permissions: {
      async request(input) {
        permissionRequests.push(input);
        return {
          protocol: "bush.runtime_permission_answer.v1",
          permissionId: `permission_${permissionRequests.length}`,
          answerId: `answer_${permissionRequests.length}`,
          decision: "allow_once",
          grantedCapabilityIds: input.capabilityIds,
        };
      },
    },
  });

  const written = await coordinator.execute(
    call("write_file", { path, content: "hello world" }),
    identity("session"),
    undefined,
    turn(registry, undefined, {}),
  );
  assert.equal(written.kind, "completed");
  assert.equal(readFileSync(path, "utf8"), "hello world");
  assert.deepEqual(permissionRequests[0].resources, [path]);

  const relative = await coordinator.execute(
    call("write_file", { path: "relative.txt", content: "blocked" }),
    { ...identity("session"), ordinal: 1 },
    undefined,
    turn(registry, undefined, {}),
  );
  assert.equal(relative.kind, "failed");
  assert.match(relative.result.error.message, /Relative paths require a workspaceDir/);
});

test("canonicalizes a linked workspace root and rejects a linked escape", async (t) => {
  const parent = temporaryRoot(t);
  const realWorkspace = temporaryRoot(t);
  const external = temporaryRoot(t);
  const linkedWorkspace = join(parent, "workspace-link");
  const linkedExternal = join(realWorkspace, "external-link");
  symlinkSync(realWorkspace, linkedWorkspace, process.platform === "win32" ? "junction" : "dir");
  symlinkSync(external, linkedExternal, process.platform === "win32" ? "junction" : "dir");
  const inside = join(realWorkspace, "inside.txt");
  const outside = join(external, "outside.txt");
  writeFileSync(inside, "inside");
  writeFileSync(outside, "outside");
  const registry = new ToolRegistry();
  registerWorkspaceTools(registry, new WorkspaceObservationStore());
  const requests = [];
  const coordinator = new ToolExecutionCoordinator({
    registry,
    permissions: {
      async request(input) {
        requests.push(input);
        return {
          protocol: "bush.runtime_permission_answer.v1",
          permissionId: `permission_${requests.length}`,
          answerId: `answer_${requests.length}`,
          decision: "allow_once",
          grantedCapabilityIds: input.capabilityIds,
        };
      },
    },
  });

  const insideOutcome = await coordinator.execute(
    call("read_file", { path: "inside.txt" }),
    identity("session"),
    undefined,
    turn(registry, linkedWorkspace, {}),
  );
  assert.equal(insideOutcome.kind, "completed");
  assert.equal(requests.length, 0);

  const escapeOutcome = await coordinator.execute(
    call("read_file", { path: join("external-link", "outside.txt") }),
    { ...identity("session"), ordinal: 1 },
    undefined,
    turn(registry, linkedWorkspace, {}),
  );
  assert.equal(escapeOutcome.kind, "completed");
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].resources, [outside]);
});

test("binds external path approval to the exact requested capability", async (t) => {
  const workspace = temporaryRoot(t);
  const external = temporaryRoot(t);
  const path = join(external, "outside.txt");
  writeFileSync(path, "outside");
  let permissionRequest;
  const registry = new ToolRegistry();
  registerWorkspaceTools(registry, new WorkspaceObservationStore());
  const coordinator = new ToolExecutionCoordinator({
    registry,
    permissions: {
      async request(input) {
        permissionRequest = input;
        return {
          protocol: "bush.runtime_permission_answer.v1",
          permissionId: "permission_1",
          answerId: "answer_1",
          decision: "allow_once",
          grantedCapabilityIds: input.capabilityIds,
        };
      },
    },
  });
  const outcome = await coordinator.execute(
    call("read_file", { path }),
    identity("session"),
    undefined,
    turn(registry, workspace, {}),
  );
  assert.equal(outcome.kind, "completed");
  assert.deepEqual(permissionRequest.resources, [path]);
  assert.equal(permissionRequest.capabilityIds.length, 1);
});

function tools(workspace) {
  const registry = new ToolRegistry();
  registerWorkspaceTools(registry, new WorkspaceObservationStore());
  let ordinal = 0;
  const coordinator = new ToolExecutionCoordinator({
    registry,
    permissions: { request: async () => { throw new Error("unexpected permission"); } },
  });
  return {
    execute(sessionId, name, input, metadata = {}) {
      return coordinator.execute(
        call(name, input),
        { ...identity(sessionId), ordinal: ordinal++ },
        undefined,
        turn(registry, workspace, metadata),
      );
    },
  };
}

function call(name, input) {
  return {
    protocol: "bush.tool_call.v1",
    id: `call_${name}_${Math.random()}`,
    name,
    argumentsText: JSON.stringify(input),
  };
}

function identity(sessionId) {
  return { requestId: "request", sessionId, turnId: "turn", round: 1, ordinal: 0 };
}

function turn(registry, workspaceDir, metadata) {
  return {
    request: {
      protocol: "bush.model_request.v1",
      requestId: "request",
      sessionId: "session",
      turnId: "turn",
      model: "model",
      messages: [],
      tools: registry.definitions(),
      toolChoice: "auto",
      metadata: { workspaceDir, ...metadata },
    },
    contextMessages: [],
  };
}

function temporaryRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "cardbush-workspace-tools-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
