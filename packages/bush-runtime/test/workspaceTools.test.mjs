import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ToolExecutionCoordinator,
  ToolRegistry,
  WorkspaceObservationStore,
  protectedTerminalDeletion,
  registerWorkspaceTools,
} from "../dist/index.js";

test("permanently denies direct deletion of invariant protected directories", () => {
  const home = resolve(homedir());
  const filesystemRoot = resolve(parse(home).root);
  const homeSibling = join(dirname(home), "cardbush-protected-home-sibling");
  const projectRoot = join(tmpdir(), "cardbush-protected-project-root");
  const shell = process.platform === "win32" ? "powershell" : "posix";
  const deletion = (target) => process.platform === "win32"
    ? `Remove-Item -LiteralPath '${target.replaceAll("'", "''")}' -Recurse -Force`
    : `rm -rf -- '${target.replaceAll("'", "'\\''")}'`;
  const inspect = (target) => protectedTerminalDeletion({
    command: deletion(target),
    cwd: projectRoot,
    shell,
    projectRoots: [projectRoot],
  });

  assert.equal(inspect(filesystemRoot)?.protection, "filesystem_root");
  assert.equal(inspect(home)?.protection, "user_home");
  assert.equal(inspect(homeSibling)?.protection, "user_home_sibling");
  assert.equal(inspect(projectRoot)?.protection, "project_root");
  assert.equal(inspect(join(projectRoot, "build")), null);
  const variableDelete = process.platform === "win32"
    ? "Remove-Item -LiteralPath $env:USERPROFILE -Recurse -Force"
    : "rm -rf -- \"$HOME\"";
  assert.equal(
    protectedTerminalDeletion({
      command: variableDelete,
      cwd: projectRoot,
      shell,
      projectRoots: [projectRoot],
    })?.protection,
    "user_home",
  );

  if (process.platform === "win32") {
    assert.equal(
      protectedTerminalDeletion({
        command: "Remove-Item -Path 'build' -Filter '*' -Recurse -Force",
        cwd: projectRoot,
        shell,
        projectRoots: [projectRoot],
      }),
      null,
      "A filter on a safe child must not be mistaken for a project-root target",
    );
  }

  const changeThenDelete = process.platform === "win32"
    ? "Set-Location ..; Remove-Item -LiteralPath . -Recurse -Force"
    : "cd ..; rm -rf -- .";
  assert.equal(
    protectedTerminalDeletion({
      command: changeThenDelete,
      cwd: join(projectRoot, "child"),
      shell,
      projectRoots: [projectRoot],
    })?.protection,
    "project_root",
  );

  const chained = process.platform === "win32"
    ? `Write-Output safe; ${deletion(home)}`
    : `printf safe; ${deletion(home)}`;
  assert.equal(
    protectedTerminalDeletion({
      command: chained,
      cwd: projectRoot,
      shell,
      projectRoots: [projectRoot],
    })?.protection,
    "user_home",
  );

  const nested = process.platform === "win32"
    ? `powershell -NoProfile -Command "${deletion(filesystemRoot)}"`
    : `sh -c "${deletion(filesystemRoot)}"`;
  assert.equal(
    protectedTerminalDeletion({
      command: nested,
      cwd: projectRoot,
      shell,
      projectRoots: [projectRoot],
    })?.protection,
    "filesystem_root",
  );

  const grouped = process.platform === "win32"
    ? `& { ${deletion(home)} }`
    : `( ${deletion(home)} )`;
  assert.equal(
    protectedTerminalDeletion({
      command: grouped,
      cwd: projectRoot,
      shell,
      projectRoots: [projectRoot],
    })?.protection,
    "user_home",
  );

  const wildcardSelection = process.platform === "win32"
    ? "Remove-Item -Path '*.log' -Force"
    : "rm -f -- *.log";
  assert.equal(
    protectedTerminalDeletion({
      command: wildcardSelection,
      cwd: projectRoot,
      shell,
      projectRoots: [projectRoot],
    }),
    null,
    "A wildcard child selection must not be promoted into deletion of its parent directory",
  );
});

test("full control cannot override protected project deletion", async (t) => {
  const projectRoot = temporaryRoot(t);
  const setup = tools(projectRoot);
  const shell = process.platform === "win32" ? "powershell" : "posix";
  const command = process.platform === "win32"
    ? `Remove-Item -LiteralPath '${projectRoot.replaceAll("'", "''")}' -Recurse -Force`
    : `rm -rf -- '${projectRoot.replaceAll("'", "'\\''")}'`;

  const outcome = await setup.execute("session", "terminal_exec", {
    command,
    cwd: projectRoot,
    yield_time_ms: 100,
    shell,
  }, { permissionMode: "all_free", projectDir: projectRoot });

  assert.equal(outcome.kind, "failed");
  assert.equal(outcome.error.code, "protected_path_delete_denied");
  assert.equal(outcome.error.kind, "permission");
  assert.equal(setup.permissionRequestCount, 0);
  assert.equal(existsSync(projectRoot), true);
});

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
  assert.match(rejected.error.message, /read_file first/);

  const read = await setup.execute("parent", "read_file", { path });
  assert.equal(read.kind, "returned");
  const edited = await setup.execute("child", "edit_file", {
    path,
    old_text: "before",
    new_text: "after",
  }, { inheritedObservationSessionId: "parent" });
  assert.equal(edited.kind, "returned");
  assert.equal(readFileSync(path, "utf8"), "after\n");
  assert.equal(edited.workspaceChanges[0].status, "modified");
  assert.equal(edited.workspaceChanges[0].additions, 1);
  assert.equal(edited.workspaceChanges[0].deletions, 1);
  assert.match(edited.workspaceChanges[0].metadata.diff, /-before/);
  assert.match(edited.workspaceChanges[0].metadata.diff, /\+after/);
});

test("invalidates read evidence when the file changes outside Runtime", async (t) => {
  const root = temporaryRoot(t);
  const path = join(root, "file.txt");
  writeFileSync(path, "observed");
  const setup = tools(root);

  assert.equal((await setup.execute("session", "read_file", { path })).kind, "returned");
  writeFileSync(path, "changed externally");
  const outcome = await setup.execute("session", "edit_file", {
    path,
    old_text: "changed externally",
    new_text: "edited",
  });

  assert.equal(outcome.kind, "failed");
  assert.match(outcome.error.message, /has not been observed/);
});

test("write and edit return compact receipts while Runtime retains full change evidence", async (t) => {
  const root = temporaryRoot(t);
  const path = join(root, "large.txt");
  const setup = tools(root);
  const original = `unique-write-payload\n${"filler line\n".repeat(4_000)}`;

  const written = await setup.execute("session", "write_file", {
    path,
    content: original,
  });
  assert.equal(written.kind, "returned");
  assert.equal(written.result.path, path);
  assert.equal(written.result.status, "added");
  assert.equal(typeof written.result.sha256, "string");
  assert.equal(typeof written.result.change_id, "string");
  assert.equal("change" in written.result, false);
  assert.ok(JSON.stringify(written.result).length < 512);
  assert.match(written.workspaceChanges[0].metadata.diff, /unique-write-payload/);

  const edited = await setup.execute("session", "edit_file", {
    path,
    old_text: "unique-write-payload",
    new_text: "unique-edited-payload",
  });
  assert.equal(edited.kind, "returned");
  assert.equal(edited.result.path, path);
  assert.equal(edited.result.status, "modified");
  assert.equal("change" in edited.result, false);
  assert.ok(JSON.stringify(edited.result).length < 512);
  assert.doesNotMatch(JSON.stringify(edited.result), /unique-(?:write|edited)-payload/);
  assert.ok(edited.workspaceChanges[0].metadata.beforeContentBase64.length > 40_000);
  assert.match(edited.workspaceChanges[0].metadata.diff, /-unique-write-payload/);
  assert.match(edited.workspaceChanges[0].metadata.diff, /\+unique-edited-payload/);
});

test("preserves filesystem error codes as Tool failures", async (t) => {
  const root = temporaryRoot(t);
  const setup = tools(root);
  const outcome = await setup.execute("session", "read_file", {
    path: join(root, "missing.txt"),
  });

  assert.equal(outcome.kind, "failed");
  assert.equal(outcome.error.kind, "tool");
  assert.equal(outcome.error.code, "ENOENT");
});

test("writes new files, treats search no-match as a successful fact, and reports exit codes", async (t) => {
  const root = temporaryRoot(t);
  const setup = tools(root);
  const path = join(root, "new.txt");
  const written = await setup.execute("session", "write_file", {
    path,
    content: "hello",
  });
  assert.equal(written.kind, "returned");
  assert.equal(written.workspaceChanges[0].status, "added");

  const searched = await setup.execute("session", "search_file_content", {
    path: root,
    query: "absent-value",
  });
  assert.equal(searched.kind, "returned");
  assert.equal(searched.result.matched, false);
  assert.equal("path" in searched.result, false);
  assert.equal("query" in searched.result, false);

  const terminal = await setup.execute("session", "terminal_exec", {
    command: "node -e \"process.stdout.write('ok')\"",
    cwd: root,
    yield_time_ms: 5_000,
  });
  assert.equal(terminal.kind, "returned");
  assert.equal(terminal.result.exitCode, 0);
  assert.equal(terminal.result.stdout, "ok");
  assert.equal(typeof terminal.result.shellExecutable, "string");
  for (const echoedInput of ["command", "cwd", "shell", "yieldTimeMs"]) {
    assert.equal(echoedInput in terminal.result, false);
  }

  const nonzero = await setup.execute("session", "terminal_exec", {
    command: "node -e \"process.stdout.write('out'); process.stderr.write('err'); process.exit(7)\"",
    cwd: root,
    yield_time_ms: 5_000,
  });
  assert.equal(nonzero.kind, "returned");
  assert.equal(nonzero.result.exitCode, 7);
  assert.equal(nonzero.result.stdout, "out");
  assert.equal(nonzero.result.stderr, "err");
});

test("searches with the Node fallback when ripgrep is unavailable in a packaged environment", async (t) => {
  const root = temporaryRoot(t);
  writeFileSync(join(root, "first.txt"), "alpha\nneedle here\n");
  writeFileSync(join(root, "ignored.log"), "needle ignored\n");
  const setup = tools(root);
  const previousPath = process.env.PATH;
  const previousBundled = process.env.CARDBUSH_RG_PATH;
  process.env.PATH = "";
  delete process.env.CARDBUSH_RG_PATH;
  try {
    const outcome = await setup.execute("session", "search_file_content", {
      path: root,
      query: "needle",
      globs: ["**/*.txt"],
    });
    assert.equal(outcome.kind, "returned");
    assert.equal(outcome.result.matched, true);
    assert.match(outcome.result.output, /first\.txt:2:1:needle here/);
    assert.doesNotMatch(outcome.result.output, /ignored\.log/);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousBundled === undefined) delete process.env.CARDBUSH_RG_PATH;
    else process.env.CARDBUSH_RG_PATH = previousBundled;
  }
});

test("prefers the bundled ripgrep executable when the system PATH has no rg", async (t) => {
  if (process.platform !== "win32" || process.arch !== "x64") return;
  const root = temporaryRoot(t);
  writeFileSync(join(root, "visible.txt"), "bundled needle\n");
  writeFileSync(join(root, ".hidden.txt"), "hidden needle\n");
  const bundled = fileURLToPath(new URL(
    "../../../assets/runtime-tools/ripgrep/win32-x64/rg.exe",
    import.meta.url,
  ));
  const setup = tools(root);
  const previousPath = process.env.PATH;
  const previousBundled = process.env.CARDBUSH_RG_PATH;
  process.env.PATH = "";
  process.env.CARDBUSH_RG_PATH = bundled;
  try {
    const outcome = await setup.execute("session", "search_file_content", {
      path: root,
      query: "needle",
    });
    assert.equal(outcome.kind, "returned");
    assert.match(outcome.result.output, /visible\.txt:1:9:bundled needle/);
    assert.doesNotMatch(outcome.result.output, /hidden\.txt/);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousBundled === undefined) delete process.env.CARDBUSH_RG_PATH;
    else process.env.CARDBUSH_RG_PATH = previousBundled;
  }
});

test("preserves UTF-8 output and decodes legacy Windows shell output", async (t) => {
  const root = temporaryRoot(t);
  const setup = tools(root);
  const utf8 = await setup.execute("session", "terminal_exec", {
    command: "node -e \"process.stdout.write('中文文件')\"",
    cwd: root,
    yield_time_ms: 5_000,
  });
  assert.equal(utf8.kind, "returned");
  assert.equal(utf8.result.stdout, "中文文件");

  if (process.platform !== "win32") return;
  writeFileSync(join(root, "中文目录.txt"), "content");
  const shellBuiltin = await setup.execute("session", "terminal_exec", {
    command: "dir /b",
    cwd: root,
    yield_time_ms: 5_000,
    shell: "cmd",
  });
  assert.equal(shellBuiltin.kind, "returned");
  assert.match(shellBuiltin.result.stdout, /中文目录\.txt/);

  const legacy = await setup.execute("session", "terminal_exec", {
    command: "node -e \"process.stdout.write(Buffer.from([0xd6,0xd0,0xce,0xc4])); process.stderr.write(Buffer.from([0xb4,0xed,0xce,0xf3]))\"",
    cwd: root,
    yield_time_ms: 5_000,
  });
  assert.equal(legacy.kind, "returned");
  assert.equal(legacy.result.stdout, "中文");
  assert.equal(legacy.result.stderr, "错误");
});

test("publishes an explicit platform shell contract and rejects unavailable shells", async (t) => {
  const root = temporaryRoot(t);
  const setup = tools(root);
  const definition = setup.registry.resolve("terminal_exec").definition;
  const shellSchema = definition.inputSchema.properties.shell;
  const expected = process.platform === "win32" ? ["powershell", "cmd"] : ["posix"];
  assert.deepEqual(shellSchema.enum, expected);
  assert.equal(shellSchema.default, expected[0]);
  assert.deepEqual(definition.inputSchema.required, ["command", "cwd", "yield_time_ms", "shell"]);
  assert.equal(definition.inputSchema.properties.yield_time_ms.maximum, 30_000);
  assert.match(definition.inputSchema.properties.cwd.description, /absolute path/i);
  assert.match(definition.description, /never rewrites commands/i);

  const unavailable = await setup.execute("session", "terminal_exec", {
    command: "echo blocked",
    cwd: root,
    yield_time_ms: 5_000,
    shell: process.platform === "win32" ? "posix" : "cmd",
  });
  assert.equal(unavailable.kind, "failed");
  assert.match(unavailable.error.message, /shell must be one of/);
});

test("returns a session handle at the bounded yield point and later reports exit", async (t) => {
  const root = temporaryRoot(t);
  const setup = tools(root);

  const missing = await setup.execute("session", "terminal_exec", {
    command: "node -e \"process.stdout.write('should not run')\"",
    cwd: root,
  });
  assert.equal(missing.kind, "failed");
  assert.match(missing.error.message, /yield_time_ms is required/);

  const excessive = await setup.execute("session", "terminal_exec", {
    command: "node -e \"process.stdout.write('should not run')\"",
    cwd: root,
    yield_time_ms: 30_001,
  });
  assert.equal(excessive.kind, "failed");
  assert.match(excessive.error.message, /must not exceed 30000/);

  const startedAt = Date.now();
  const running = await setup.execute("session", "terminal_exec", {
    command: "node -e \"setTimeout(() => {}, 500)\"",
    cwd: root,
    yield_time_ms: 100,
  });
  assert.equal(running.kind, "returned");
  assert.equal(running.result.state, "running");
  assert.match(running.result.terminalSessionId, /^terminal_/);
  assert.equal("yieldTimeMs" in running.result, false);
  assert.ok(running.result.durationMs >= 90);
  assert.ok(Date.now() - startedAt < 2_000);

  const completed = await setup.execute("session", "terminal_poll", {
    session_id: running.result.terminalSessionId,
    yield_time_ms: 1_000,
  });
  assert.equal(completed.kind, "returned");
  assert.equal(completed.result.state, "exited");
  assert.equal(completed.result.exitCode, 0);
  for (const echoedInvocation of ["command", "cwd", "shell", "yieldTimeMs"]) {
    assert.equal(echoedInvocation in completed.result, false);
  }
});

test("returns a session handle instead of waiting on inherited descendant stdio", async (t) => {
  const root = temporaryRoot(t);
  const setup = tools(root);
  const startedAt = Date.now();
  const outcome = await setup.execute("session", "terminal_exec", {
    command: "node -e \"const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setTimeout(()=>{},750)'],{stdio:'inherit'}); child.unref();\"",
    cwd: root,
    yield_time_ms: 1_000,
  });
  assert.equal(outcome.kind, "returned");
  assert.equal(outcome.result.state, "exited");
  assert.match(outcome.result.terminalSessionId, /^terminal_/);
  assert.ok(Date.now() - startedAt < 2_000);
});

test("writes to and explicitly stops persistent terminal sessions", async (t) => {
  const root = temporaryRoot(t);
  const setup = tools(root);
  const interactive = await setup.execute("session", "terminal_exec", {
    command: "node -e \"process.stdin.once('data',d=>{process.stdout.write(d);process.exit(0)})\"",
    cwd: root,
    yield_time_ms: 100,
  });
  assert.equal(interactive.result.state, "running");
  const written = await setup.execute("session", "terminal_write", {
    session_id: interactive.result.terminalSessionId,
    chars: "hello terminal\\n",
    yield_time_ms: 1_000,
  });
  assert.equal(written.kind, "returned");
  assert.match(written.result.stdout, /hello terminal/);
  const interactiveCompleted = written.result.state === "exited"
    ? written
    : await setup.execute("session", "terminal_poll", {
        session_id: interactive.result.terminalSessionId,
        yield_time_ms: 1_000,
      });
  assert.equal(interactiveCompleted.result.state, "exited");

  const persistent = await setup.execute("session", "terminal_exec", {
    command: "node -e \"setInterval(()=>{},1000)\"",
    cwd: root,
    yield_time_ms: 100,
  });
  assert.equal(persistent.result.state, "running");
  const listed = await setup.execute("session", "terminal_list", {});
  assert.equal(listed.kind, "returned");
  assert.ok(listed.result.sessions.some(
    (item) => item.terminalSessionId === persistent.result.terminalSessionId,
  ));
  const stopped = await setup.execute("session", "terminal_stop", {
    session_id: persistent.result.terminalSessionId,
  });
  assert.equal(stopped.kind, "returned");
  assert.equal(stopped.result.state, "stopped");
  const afterStop = await setup.execute("session", "terminal_list", {});
  assert.equal(afterStop.result.sessions.length, 0);
});

test("full control stops an owned terminal without publishing a permission request", async (t) => {
  const root = temporaryRoot(t);
  const setup = tools(root);
  const metadata = { permissionMode: "all_free", projectDir: root };
  const persistent = await setup.execute("session", "terminal_exec", {
    command: "node -e \"setInterval(()=>{},1000)\"",
    cwd: root,
    yield_time_ms: 100,
  }, metadata);
  assert.equal(persistent.kind, "returned");
  assert.equal(persistent.result.state, "running");

  const permissionRequestsBeforeStop = setup.permissionRequestCount;
  const stopped = await setup.execute("session", "terminal_stop", {
    session_id: persistent.result.terminalSessionId,
  }, metadata);

  assert.equal(stopped.kind, "returned");
  assert.equal(stopped.result.state, "stopped");
  assert.equal(setup.permissionRequestCount, permissionRequestsBeforeStop);
});

test("keeps a spawned terminal session available when the waiting Tool is cancelled", async (t) => {
  const root = temporaryRoot(t);
  const setup = tools(root);
  const controller = new AbortController();
  const execution = setup.execute("session", "terminal_exec", {
    command: "node -e \"setInterval(()=>{},1000)\"",
    cwd: root,
    yield_time_ms: 5_000,
  }, {}, controller.signal);
  setTimeout(() => controller.abort(), 100);
  const cancelled = await execution;
  assert.equal(cancelled.kind, "cancelled");

  const listed = await setup.execute("session", "terminal_list", {});
  assert.equal(listed.kind, "returned");
  assert.equal(listed.result.sessions.length, 1);
  const stopped = await setup.execute("session", "terminal_stop", {
    session_id: listed.result.sessions[0].terminalSessionId,
  });
  assert.equal(stopped.kind, "returned");
  assert.equal(stopped.result.state, "stopped");
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
  assert.equal(written.kind, "returned");
  assert.equal(readFileSync(path, "utf8"), "hello world");
  assert.deepEqual(permissionRequests[0].targets, [{ kind: "filesystem_path", value: path }]);
  assert.deepEqual(permissionRequests[0].scope, { mode: "task_free", roots: [] });

  const relative = await coordinator.execute(
    call("write_file", { path: "relative.txt", content: "blocked" }),
    { ...identity("session"), ordinal: 1 },
    undefined,
    turn(registry, undefined, {}),
  );
  assert.equal(relative.kind, "failed");
  assert.match(relative.error.message, /Relative paths require a workspaceDir/);
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
  assert.equal(insideOutcome.kind, "returned");
  assert.equal(requests.length, 0);

  const escapeOutcome = await coordinator.execute(
    call("read_file", { path: join("external-link", "outside.txt") }),
    { ...identity("session"), ordinal: 1 },
    undefined,
    turn(registry, linkedWorkspace, {}),
  );
  assert.equal(escapeOutcome.kind, "returned");
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].targets, [{ kind: "filesystem_path", value: outside }]);
  assert.equal(requests[0].scope.mode, "task_free");
  assert.equal(requests[0].scope.roots.length, 1);
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
  assert.equal(outcome.kind, "returned");
  assert.deepEqual(permissionRequest.targets, [{ kind: "filesystem_path", value: path }]);
  assert.equal(permissionRequest.capabilityIds.length, 1);
});

function tools(workspace) {
  const registry = new ToolRegistry();
  registerWorkspaceTools(registry, new WorkspaceObservationStore());
  let ordinal = 0;
  let permissionRequestCount = 0;
  const coordinator = new ToolExecutionCoordinator({
    registry,
    permissions: {
      async request(input) {
        permissionRequestCount += 1;
        return {
          protocol: "bush.runtime_permission_answer.v1",
          permissionId: `permission_${Math.random()}`,
          answerId: `answer_${Math.random()}`,
          decision: "allow_once",
          grantedCapabilityIds: input.capabilityIds,
        };
      },
    },
  });
  return {
    registry,
    get permissionRequestCount() {
      return permissionRequestCount;
    },
    execute(sessionId, name, input, metadata = {}, signal) {
      return coordinator.execute(
        call(name, input),
        { ...identity(sessionId), ordinal: ordinal++ },
        signal,
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
  const permissionMode = metadata.permissionMode ?? "task_free";
  const requestMetadata = { ...metadata };
  delete requestMetadata.permissionMode;
  return {
    request: {
      protocol: "bush.model_request.v1",
      requestId: "request",
      sessionId: "session",
      turnId: "turn",
      model: "model",
      messages: [],
      tools: registry.definitions(),
      permissionMode,
      metadata: { workspaceDir, ...requestMetadata },
    },
    contextMessages: [],
  };
}

function temporaryRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "cardbush-workspace-tools-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
