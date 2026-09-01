import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { homedir } from "node:os";

import type {
  ToolAdmissionContext,
  ToolHandlerContext,
  ToolRegistration,
  ToolRegistry,
} from "./toolRegistry.js";

interface PathInput { path: string }
interface ReadFileInput extends PathInput { encoding: BufferEncoding }
interface WriteFileInput extends PathInput { content: string; encoding: BufferEncoding }
interface EditFileInput extends PathInput {
  oldText: string;
  newText: string;
  replaceAll: boolean;
  encoding: BufferEncoding;
}
interface SearchInput extends PathInput {
  query: string;
  regex: boolean;
  globs: string[];
}
interface TerminalInput {
  command: string;
  cwd: string;
  yieldTimeMs: number;
  shell: TerminalShell;
}

interface TerminalSessionInput { sessionId: string }
interface TerminalPollInput extends TerminalSessionInput { yieldTimeMs: number }
interface TerminalWriteInput extends TerminalPollInput { chars: string }

type TerminalShell = "cmd" | "powershell" | "posix";

const MAX_TERMINAL_YIELD_MS = 30_000;
const MAX_TERMINAL_OUTPUT_BYTES = 1024 * 1024;

interface Observation {
  sha256: string;
  observedAt: string;
}

export class WorkspaceObservationStore {
  readonly #observations = new Map<string, Map<string, Observation>>();
  readonly #projectObservations = new Map<string, Map<string, Observation>>();
  readonly #mutations = new Set<string>();
  readonly #persistencePath?: string;

  constructor(options: { persistencePath?: string } = {}) {
    this.#persistencePath = options.persistencePath;
    if (this.#persistencePath) this.#load();
  }

  record(sessionId: string, path: string, sha256: string, projectRoot?: string): void {
    const session = this.#observations.get(sessionId) ?? new Map<string, Observation>();
    session.set(normalizeIdentity(path), { sha256, observedAt: new Date().toISOString() });
    this.#observations.set(sessionId, session);
    if (projectRoot) {
      const project = this.#projectObservations.get(normalizeIdentity(projectRoot)) ?? new Map<string, Observation>();
      project.set(normalizeIdentity(path), { sha256, observedAt: new Date().toISOString() });
      this.#projectObservations.set(normalizeIdentity(projectRoot), project);
      this.#persist();
    }
  }

  matches(sessionId: string, path: string, sha256: string, inheritedSessionId?: string, projectRoot?: string): boolean {
    const identity = normalizeIdentity(path);
    return (
      this.#observations.get(sessionId)?.get(identity)?.sha256 === sha256 ||
      (inheritedSessionId
        ? this.#observations.get(inheritedSessionId)?.get(identity)?.sha256 === sha256
        : false) ||
      (projectRoot
        ? this.#projectObservations.get(normalizeIdentity(projectRoot))?.get(identity)?.sha256 === sha256
        : false)
    );
  }

  acquireMutation(path: string): () => void {
    const identity = normalizeIdentity(path);
    if (this.#mutations.has(identity)) {
      throw codedError(
        "workspace_resource_busy",
        `A concurrent mutation already holds the resource lease for ${path}.`,
      );
    }
    this.#mutations.add(identity);
    return () => this.#mutations.delete(identity);
  }

  #load(): void {
    let input: unknown;
    try {
      input = JSON.parse(readFileSync(this.#persistencePath!, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error(`Project cognition store is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Project cognition store must be an object.");
    }
    for (const [root, records] of Object.entries(input as Record<string, unknown>)) {
      if (!records || typeof records !== "object" || Array.isArray(records)) {
        throw new Error(`Project cognition records for ${root} are invalid.`);
      }
      const project = new Map<string, Observation>();
      for (const [path, value] of Object.entries(records as Record<string, unknown>)) {
        const item = value as Partial<Observation> | null;
        if (!item || typeof item.sha256 !== "string" || typeof item.observedAt !== "string") {
          throw new Error(`Project cognition observation for ${path} is invalid.`);
        }
        project.set(path, { sha256: item.sha256, observedAt: item.observedAt });
      }
      this.#projectObservations.set(root, project);
    }
  }

  #persist(): void {
    if (!this.#persistencePath) return;
    const value = Object.fromEntries([...this.#projectObservations].map(([root, entries]) => [
      root,
      Object.fromEntries(entries),
    ]));
    mkdirSync(dirname(this.#persistencePath), { recursive: true });
    const temporary = `${this.#persistencePath}.tmp-${process.pid}`;
    writeFileSync(temporary, JSON.stringify(value), "utf8");
    try {
      renameSync(temporary, this.#persistencePath);
    } catch {
      rmSync(this.#persistencePath, { force: true });
      renameSync(temporary, this.#persistencePath);
    }
  }
}

export function registerWorkspaceTools(
  registry: ToolRegistry,
  observations: WorkspaceObservationStore = new WorkspaceObservationStore(),
  options: { createChangeId?: () => string } = {},
): WorkspaceObservationStore {
  const createChangeId = options.createChangeId ?? (() => `change_${randomUUID()}`);
  const terminals = new TerminalSessionManager();

  registerIfMissing(registry, {
    definition: {
      name: "read_file",
      description: "Read one file exactly. Returns its absolute path, SHA-256 revision and complete content. Use an absolute path when the Turn has no workspace.",
      inputSchema: objectSchema({
        path: { type: "string", minLength: 1 },
        encoding: { type: "string", default: "utf8" },
      }, ["path"]),
    },
    manifest: manifest("filesystem.read", "observation", false),
    parallelSafe: true,
    decodeInput: decodeRead,
    authorize: authorizePath("read"),
    execute: async (context: ToolHandlerContext<ReadFileInput>) => {
      const path = await resolveToolPath(context, context.input.path);
      const bytes = await readFile(path);
      const sha256 = digest(bytes);
      observations.record(context.sessionId, path, sha256, workspaceRoot(context));
      return {
        path,
        sha256,
        content: bytes.toString(context.input.encoding),
      };
    },
  });

  registerIfMissing(registry, {
    definition: {
      name: "search_file_content",
      description: "Search file content beneath a file or directory using ripgrep and return exact matching lines.",
      inputSchema: objectSchema({
        query: { type: "string", minLength: 1 },
        path: { type: "string", minLength: 1 },
        regex: { type: "boolean", default: false },
        globs: { type: "array", items: { type: "string" }, default: [] },
      }, ["query", "path"]),
    },
    manifest: manifest("filesystem.search", "observation", false),
    parallelSafe: true,
    decodeInput: decodeSearch,
    authorize: authorizePath("read"),
    execute: async (context: ToolHandlerContext<SearchInput>) => {
      const path = await resolveToolPath(context, context.input.path);
      const args = ["--line-number", "--column", "--no-heading", "--color", "never"];
      if (!context.input.regex) args.push("--fixed-strings");
      for (const glob of context.input.globs) args.push("--glob", glob);
      args.push("--", context.input.query, path);
      const execution = await searchFileContent(
        path,
        context.input,
        args,
        workspaceRoot(context) ?? dirname(path),
        context.signal,
      );
      if (execution.exitCode !== 0 && execution.exitCode !== 1) {
        throw new Error(execution.stderr || `ripgrep exited with code ${execution.exitCode}.`);
      }
      return {
        path,
        query: context.input.query,
        matched: execution.exitCode === 0,
        output: execution.stdout,
      };
    },
  });

  registerIfMissing(registry, {
    definition: {
      name: "write_file",
      description: "Create or replace one file. Existing files must have been read at their current SHA-256 revision first. Use an absolute path when the Turn has no workspace.",
      inputSchema: objectSchema({
        path: { type: "string", minLength: 1 },
        content: { type: "string" },
        encoding: { type: "string", default: "utf8" },
      }, ["path", "content"]),
    },
    manifest: manifest("filesystem.write", "filesystem_change", true),
    decodeInput: decodeWrite,
    authorize: authorizePath("write"),
    execute: async (context: ToolHandlerContext<WriteFileInput>) => {
      const path = await resolveToolPath(context, context.input.path, true);
      const release = observations.acquireMutation(path);
      try {
        const before = await optionalBytes(path);
        assertObservedIfExisting(context, observations, path, before);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, context.input.content, { encoding: context.input.encoding });
        const after = await readFile(path);
        const afterHash = digest(after);
        observations.record(context.sessionId, path, afterHash, workspaceRoot(context));
        return changeResult(
          context,
          path,
          before,
          after,
          before ? "modified" : "added",
          context.input.encoding,
          createChangeId(),
        );
      } finally {
        release();
      }
    },
  });

  registerIfMissing(registry, {
    definition: {
      name: "edit_file",
      description: "Replace exact text in one previously read file. Fails if the current file revision was not observed or the old text is absent/ambiguous.",
      inputSchema: objectSchema({
        path: { type: "string", minLength: 1 },
        old_text: { type: "string", minLength: 1 },
        new_text: { type: "string" },
        replace_all: { type: "boolean", default: false },
        encoding: { type: "string", default: "utf8" },
      }, ["path", "old_text", "new_text"]),
    },
    manifest: manifest("filesystem.edit", "filesystem_change", true),
    decodeInput: decodeEdit,
    authorize: authorizePath("write"),
    execute: async (context: ToolHandlerContext<EditFileInput>) => {
      const path = await resolveToolPath(context, context.input.path);
      const release = observations.acquireMutation(path);
      try {
        const before = await readFile(path);
        assertObservedIfExisting(context, observations, path, before);
        const source = before.toString(context.input.encoding);
        const count = occurrences(source, context.input.oldText);
        if (count === 0) {
          throw codedError(
            "edit_old_text_not_found",
            "old_text was not found in the current file revision.",
          );
        }
        if (!context.input.replaceAll && count !== 1) {
          throw codedError(
            "edit_old_text_ambiguous",
            `old_text matched ${count} times; set replace_all or provide a unique value.`,
          );
        }
        const next = context.input.replaceAll
          ? source.split(context.input.oldText).join(context.input.newText)
          : source.replace(context.input.oldText, context.input.newText);
        await writeFile(path, next, { encoding: context.input.encoding });
        const after = await readFile(path);
        const afterHash = digest(after);
        observations.record(context.sessionId, path, afterHash, workspaceRoot(context));
        return changeResult(
          context,
          path,
          before,
          after,
          "modified",
          context.input.encoding,
          createChangeId(),
        );
      } finally {
        release();
      }
    },
  });

  registerIfMissing(registry, {
    definition: {
      name: "terminal_exec",
      description: terminalToolDescription(),
      inputSchema: objectSchema({
        command: { type: "string", minLength: 1 },
        cwd: {
          type: "string",
          minLength: 1,
          description: "Working directory. Use an absolute path when the Turn has no workspace.",
        },
        yield_time_ms: {
          type: "integer",
          minimum: 1,
          maximum: MAX_TERMINAL_YIELD_MS,
          description: `Required initial wait before a still-running command returns a terminal session handle. Maximum ${MAX_TERMINAL_YIELD_MS}.`,
        },
        shell: {
          type: "string",
          enum: availableTerminalShells(),
          default: defaultTerminalShell(),
          description: "Explicit command interpreter. Runtime never rewrites commands between shell syntaxes.",
        },
      }, ["command", "cwd", "yield_time_ms", "shell"]),
    },
    manifest: manifest("terminal.execute", "process_execution", true),
    decodeInput: decodeTerminal,
    authorize: async (context: ToolAdmissionContext<TerminalInput>) => {
      const cwd = await resolveToolPath(context, terminalWorkingDirectory(context), true);
      return pathAdmission(context, cwd, "execute");
    },
    execute: async (context: ToolHandlerContext<TerminalInput>) => {
      const cwd = await resolveToolPath(context, terminalWorkingDirectory(context), true);
      return terminals.start({
        ownerSessionId: context.sessionId,
        command: context.input.command,
        cwd,
        yieldTimeMs: context.input.yieldTimeMs,
        signal: context.signal,
        shell: context.input.shell,
      });
    },
  });

  registerIfMissing(registry, {
    definition: {
      name: "terminal_poll",
      description: "Wait for new output or a state change from one running terminal session. Returns only output produced since the preceding terminal result.",
      inputSchema: objectSchema({
        session_id: { type: "string", minLength: 1 },
        yield_time_ms: {
          type: "integer",
          minimum: 1,
          maximum: MAX_TERMINAL_YIELD_MS,
        },
      }, ["session_id", "yield_time_ms"]),
    },
    manifest: manifest("terminal.poll", "observation", false),
    decodeInput: decodeTerminalPoll,
    execute: (context: ToolHandlerContext<TerminalPollInput>) =>
      terminals.poll(context.sessionId, context.input, context.signal),
  });

  registerIfMissing(registry, {
    definition: {
      name: "terminal_write",
      description: "Write exact characters to the stdin of one running terminal session, then return newly produced output and its current state.",
      inputSchema: objectSchema({
        session_id: { type: "string", minLength: 1 },
        chars: { type: "string" },
        yield_time_ms: {
          type: "integer",
          minimum: 1,
          maximum: MAX_TERMINAL_YIELD_MS,
        },
      }, ["session_id", "chars", "yield_time_ms"]),
    },
    manifest: manifest("terminal.write", "process_execution", true),
    decodeInput: decodeTerminalWrite,
    execute: (context: ToolHandlerContext<TerminalWriteInput>) =>
      terminals.write(context.sessionId, context.input, context.signal),
  });

  registerIfMissing(registry, {
    definition: {
      name: "terminal_stop",
      description: "Stop one running terminal session and its process tree. This is an explicit destructive process-control action.",
      inputSchema: objectSchema({
        session_id: { type: "string", minLength: 1 },
      }, ["session_id"]),
    },
    manifest: manifest("terminal.stop", "process_control", true),
    decodeInput: decodeTerminalSession,
    authorize: (context: ToolAdmissionContext<TerminalSessionInput>) => {
      const terminal = terminals.describe(context.sessionId, context.input.sessionId);
      return {
        kind: "ask" as const,
        request: {
          reason: "Stopping a running terminal session requires explicit permission.",
          actions: ["stop"],
          targets: [{
            kind: "process" as const,
            value: terminal.sessionId,
            label: terminal.command,
          }],
          capabilityIds: [`process.stop:${terminal.sessionId}`],
        },
      };
    },
    execute: (context: ToolHandlerContext<TerminalSessionInput>) =>
      terminals.stop(context.sessionId, context.input.sessionId),
  });

  registerIfMissing(registry, {
    definition: {
      name: "terminal_list",
      description: "List terminal sessions owned by the current Runtime session without consuming their pending output.",
      inputSchema: objectSchema({}, []),
    },
    manifest: manifest("terminal.list", "observation", false),
    parallelSafe: true,
    decodeInput: () => ({}),
    execute: (context: ToolHandlerContext<Record<string, never>>) => ({
      sessions: terminals.list(context.sessionId),
    }),
  });

  return observations;
}

function registerIfMissing<T>(registry: ToolRegistry, registration: ToolRegistration<T>): void {
  if (!registry.resolve(registration.definition.name)) registry.register(registration);
}

function manifest(operation: string, effectKind: string, mutating: boolean) {
  return {
    effect_kind: effectKind,
    operation,
    risk: mutating ? "medium" : "low",
    owner: "runtime_workspace",
    dispatch_scope: "resource",
    mutating,
  };
}

function authorizePath(action: "read" | "write") {
  return async (context: ToolAdmissionContext<PathInput>) => {
    const path = await resolveToolPath(context, context.input.path, action === "write");
    return pathAdmission(context, path, action);
  };
}

async function pathAdmission(
  context: ToolAdmissionContext<unknown>,
  path: string,
  action: string,
): Promise<
  | { kind: "allow" }
  | {
      kind: "ask";
      request: {
        reason: string;
        actions: string[];
        targets: Array<{ kind: "filesystem_path"; value: string }>;
        capabilityIds: string[];
        scope: {
          mode: "task_free" | "user_free";
          roots: string[];
        };
      };
    }
> {
  const mode = permissionMode(context);
  if (mode === "all_free") return { kind: "allow" } as const;
  const roots = await Promise.all(allowedRoots(context, mode).map(canonicalPath));
  if (roots.some((root) => isWithin(root, path))) return { kind: "allow" } as const;
  const capabilityId = capability(action, path);
  return {
    kind: "ask" as const,
    request: {
      reason: `${action} requires access outside the ${mode === "user_free" ? "user" : "task"} roots.`,
      actions: [action],
      targets: [{ kind: "filesystem_path", value: path }],
      capabilityIds: [capabilityId],
      scope: { mode, roots },
    },
  };
}

function permissionMode(context: ToolAdmissionContext<unknown>): "task_free" | "user_free" | "all_free" {
  const candidate = context.turn?.request.permissionMode;
  return candidate === "user_free" || candidate === "all_free" ? candidate : "task_free";
}

function allowedRoots(
  context: ToolAdmissionContext<unknown>,
  mode: "task_free" | "user_free",
): string[] {
  const metadata = context.turn?.request.metadata ?? {};
  const taskRoots = rootStringArray(metadata.taskRoots);
  const configuredUserRoots = rootStringArray(metadata.userRoots);
  const userRoots = mode === "user_free"
    ? (configuredUserRoots.length > 0 ? configuredUserRoots : [homedir()])
    : [];
  const workspace = workspaceRoot(context);
  return [...new Set([
    ...(workspace ? [workspace] : []),
    ...taskRoots,
    ...userRoots,
  ].map((item) => resolve(item)))];
}

function rootStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

async function resolveToolPath(
  context: ToolAdmissionContext<unknown>,
  candidate: string,
  allowMissing = false,
): Promise<string> {
  const root = workspaceRoot(context);
  const normalized = candidate.trim();
  if (!normalized) {
    throw codedError(
      "workspace_path_required",
      "An absolute path is required when the Turn has no workspaceDir.",
    );
  }
  if (!isAbsolute(normalized) && !root) {
    throw codedError(
      "workspace_relative_path_without_root",
      "Relative paths require a workspaceDir; use an absolute path instead.",
    );
  }
  const lexical = resolve(isAbsolute(normalized) ? normalized : resolve(root!, normalized));
  try {
    return await realpath(lexical);
  } catch (error) {
    if (!allowMissing) throw error;
    let ancestor = dirname(lexical);
    while (true) {
      try {
        const canonicalAncestor = await realpath(ancestor);
        return resolve(canonicalAncestor, relative(ancestor, lexical));
      } catch {
        const parent = dirname(ancestor);
        if (parent === ancestor) throw error;
        ancestor = parent;
      }
    }
  }
}

function workspaceRoot(context: ToolAdmissionContext<unknown>): string | undefined {
  const metadata = context.turn?.request.metadata ?? {};
  const candidate = [metadata.workspaceDir, metadata.projectDir, metadata.sessionWorkspaceDir]
    .find((value) => typeof value === "string" && value.trim());
  return typeof candidate === "string" ? resolve(candidate) : undefined;
}

function terminalWorkingDirectory(context: ToolAdmissionContext<TerminalInput>): string {
  const candidate = context.input.cwd || workspaceRoot(context);
  if (!candidate) {
    throw codedError(
      "terminal_cwd_required",
      "terminal_exec requires an absolute cwd when the Turn has no workspaceDir.",
    );
  }
  return candidate;
}

function inheritedObservationSessionId(context: ToolHandlerContext<unknown>): string | undefined {
  const candidate = context.turn?.request.metadata.inheritedObservationSessionId;
  return typeof candidate === "string" && candidate.trim() ? candidate : undefined;
}

function assertObservedIfExisting(
  context: ToolHandlerContext<unknown>,
  observations: WorkspaceObservationStore,
  path: string,
  bytes: Buffer | undefined,
): void {
  if (!bytes) return;
  const sha256 = digest(bytes);
  if (
    !observations.matches(
      context.sessionId,
      path,
      sha256,
      inheritedObservationSessionId(context),
      workspaceRoot(context),
    )
  ) {
    throw codedError(
      "workspace_revision_not_observed",
      `Current file revision ${sha256} has not been observed by this Agent context; read_file first.`,
    );
  }
}

function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function changeResult(
  context: ToolHandlerContext<unknown>,
  path: string,
  before: Buffer | undefined,
  after: Buffer,
  status: "added" | "modified",
  encoding: BufferEncoding,
  changeId: string,
): Record<string, unknown> {
  const beforeText = before?.toString(encoding) ?? "";
  const afterText = after.toString(encoding);
  const diff = createDisplayDiff(beforeText, afterText);
  const change = {
      change_id: changeId,
      path,
      status,
      additions: diff.additions,
      deletions: diff.deletions,
      ...(before ? { before_hash: digest(before) } : {}),
      after_hash: digest(after),
      metadata: {
        ...(before ? { beforeContentBase64: before.toString("base64") } : {}),
        diff: diff.text,
      },
  };
  context.recordWorkspaceChange(change);
  return {
    path,
    sha256: digest(after),
    change,
  };
}

function createDisplayDiff(before: string, after: string): {
  text: string;
  additions: number;
  deletions: number;
} {
  const beforeLines = normalizedTextLines(before);
  const afterLines = normalizedTextLines(after);
  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] ===
      afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const oldChangeEnd = beforeLines.length - suffix;
  const newChangeEnd = afterLines.length - suffix;
  const additions = newChangeEnd - prefix;
  const deletions = oldChangeEnd - prefix;
  if (additions === 0 && deletions === 0) {
    return { text: "", additions: 0, deletions: 0 };
  }
  const context = 3;
  const oldHunkStart = Math.max(0, prefix - context);
  const newHunkStart = Math.max(0, prefix - context);
  const oldHunkEnd = Math.min(beforeLines.length, oldChangeEnd + context);
  const newHunkEnd = Math.min(afterLines.length, newChangeEnd + context);
  const oldCount = oldHunkEnd - oldHunkStart;
  const newCount = newHunkEnd - newHunkStart;
  const oldStart = oldCount === 0 ? oldHunkStart : oldHunkStart + 1;
  const newStart = newCount === 0 ? newHunkStart : newHunkStart + 1;
  const lines = [
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    ...beforeLines.slice(oldHunkStart, prefix).map((line) => ` ${line}`),
    ...beforeLines.slice(prefix, oldChangeEnd).map((line) => `-${line}`),
    ...afterLines.slice(prefix, newChangeEnd).map((line) => `+${line}`),
    ...afterLines.slice(newChangeEnd, newHunkEnd).map((line) => ` ${line}`),
  ];
  return { text: lines.join("\n"), additions, deletions };
}

function normalizedTextLines(value: string): string[] {
  if (!value) return [];
  const lines = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function decodeRead(input: unknown): ReadFileInput {
  const object = objectInput(input);
  return { path: requiredString(object.path, "path"), encoding: encoding(object.encoding) };
}

function decodeWrite(input: unknown): WriteFileInput {
  const object = objectInput(input);
  return {
    path: requiredString(object.path, "path"),
    content: stringValue(object.content, "content"),
    encoding: encoding(object.encoding),
  };
}

function decodeEdit(input: unknown): EditFileInput {
  const object = objectInput(input);
  return {
    path: requiredString(object.path, "path"),
    oldText: requiredString(object.old_text, "old_text", false),
    newText: stringValue(object.new_text, "new_text"),
    replaceAll: booleanValue(object.replace_all, false),
    encoding: encoding(object.encoding),
  };
}

function decodeSearch(input: unknown): SearchInput {
  const object = objectInput(input);
  return {
    query: requiredString(object.query, "query", false),
    path: requiredString(object.path, "path"),
    regex: booleanValue(object.regex, false),
    globs: stringArray(object.globs, "globs"),
  };
}

function decodeTerminal(input: unknown): TerminalInput {
  const object = objectInput(input);
  const yieldTime = object.yield_time_ms;
  if (!Number.isInteger(yieldTime) || Number(yieldTime) < 1) {
    throw new Error("yield_time_ms is required and must be a positive integer.");
  }
  if (Number(yieldTime) > MAX_TERMINAL_YIELD_MS) {
    throw new Error(`yield_time_ms must not exceed ${MAX_TERMINAL_YIELD_MS}.`);
  }
  const shell = object.shell === undefined ? defaultTerminalShell() : String(object.shell);
  if (!availableTerminalShells().includes(shell as TerminalShell)) {
    throw new Error(
      `shell must be one of: ${availableTerminalShells().join(", ")}.`,
    );
  }
  return {
    command: requiredString(object.command, "command", false),
    cwd: typeof object.cwd === "string" ? object.cwd.trim() : "",
    yieldTimeMs: Number(yieldTime),
    shell: shell as TerminalShell,
  };
}

function decodeTerminalSession(input: unknown): TerminalSessionInput {
  const object = objectInput(input);
  return { sessionId: requiredString(object.session_id, "session_id") };
}

function decodeTerminalPoll(input: unknown): TerminalPollInput {
  const object = objectInput(input);
  const yieldTime = object.yield_time_ms;
  if (!Number.isInteger(yieldTime) || Number(yieldTime) < 1) {
    throw new Error("yield_time_ms is required and must be a positive integer.");
  }
  if (Number(yieldTime) > MAX_TERMINAL_YIELD_MS) {
    throw new Error(`yield_time_ms must not exceed ${MAX_TERMINAL_YIELD_MS}.`);
  }
  return {
    sessionId: requiredString(object.session_id, "session_id"),
    yieldTimeMs: Number(yieldTime),
  };
}

function decodeTerminalWrite(input: unknown): TerminalWriteInput {
  const object = objectInput(input);
  return {
    ...decodeTerminalPoll(object),
    chars: stringValue(object.chars, "chars"),
  };
}

function objectInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("tool input must be an object.");
  }
  return input as Record<string, unknown>;
}

function requiredString(value: unknown, name: string, trim = true): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  const output = trim ? value.trim() : value;
  if (!output) throw new Error(`${name} is required.`);
  return output;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  return value;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error("boolean value expected.");
  return value;
}

function stringArray(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${name} must contain non-empty strings.`);
  }
  return value.map((item) => String(item));
}

function encoding(value: unknown): BufferEncoding {
  const candidate = typeof value === "string" && value.trim() ? value.trim() : "utf8";
  if (!Buffer.isEncoding(candidate)) throw new Error(`Unsupported encoding ${candidate}.`);
  return candidate as BufferEncoding;
}

function objectSchema(properties: Record<string, unknown>, required: string[]) {
  return { type: "object", additionalProperties: false, required, properties };
}

async function optionalBytes(path: string): Promise<Buffer | undefined> {
  try { return await readFile(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeIdentity(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isWithin(root: string, path: string): boolean {
  const value = relative(resolve(root), resolve(path));
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

function capability(action: string, path: string): string {
  return `capability:${action}:${createHash("sha256").update(normalizeIdentity(path)).digest("hex")}`;
}

function occurrences(value: string, search: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = value.indexOf(search, offset)) >= 0) {
    count += 1;
    offset += search.length;
  }
  return count;
}

function countLines(value: Buffer): number {
  if (value.length === 0) return 0;
  let count = 1;
  for (const byte of value) {
    if (byte === 10) count += 1;
  }
  return value[value.length - 1] === 10 ? count - 1 : count;
}

async function canonicalPath(path: string): Promise<string> {
  return realpath(resolve(path));
}

interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

type TerminalSessionState = "running" | "exited" | "failed" | "stopped";

interface ManagedTerminalSession {
  sessionId: string;
  ownerSessionId: string;
  command: string;
  cwd: string;
  shell: TerminalShell;
  shellExecutable: string;
  child: ReturnType<typeof spawn>;
  pid: number | null;
  state: TerminalSessionState;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error: string;
  startedAt: number;
  revision: number;
  stopRequested: boolean;
  stdout: Buffer[];
  stderr: Buffer[];
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  waiters: Set<() => void>;
}

class TerminalSessionManager {
  readonly #sessions = new Map<string, ManagedTerminalSession>();

  async start(input: {
    ownerSessionId: string;
    command: string;
    cwd: string;
    yieldTimeMs: number;
    signal?: AbortSignal;
    shell: TerminalShell;
  }): Promise<Record<string, unknown>> {
    const invocation = terminalShellInvocation(input.shell, input.command);
    const child = spawn(invocation.executable, invocation.args, {
      cwd: input.cwd,
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const terminal: ManagedTerminalSession = {
      sessionId: `terminal_${randomUUID()}`,
      ownerSessionId: input.ownerSessionId,
      command: input.command,
      cwd: input.cwd,
      shell: input.shell,
      shellExecutable: invocation.executable,
      child,
      pid: child.pid ?? null,
      state: "running",
      exitCode: null,
      signal: null,
      error: "",
      startedAt: Date.now(),
      revision: 0,
      stopRequested: false,
      stdout: [],
      stderr: [],
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
      waiters: new Set(),
    };
    this.#sessions.set(terminal.sessionId, terminal);
    child.stdout?.on("data", (chunk: Buffer) => {
      appendTerminalOutput(terminal, "stdout", chunk);
      this.#notify(terminal);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      appendTerminalOutput(terminal, "stderr", chunk);
      this.#notify(terminal);
    });
    child.on("error", (error) => {
      terminal.state = "failed";
      terminal.error = error.message;
      this.#notify(terminal);
    });
    child.on("exit", (exitCode, signal) => {
      terminal.state = terminal.stopRequested ? "stopped" : "exited";
      terminal.exitCode = exitCode;
      terminal.signal = signal;
      this.#notify(terminal);
      const releaseStreams = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, 100);
      releaseStreams.unref?.();
    });

    await this.#waitForExit(terminal, input.yieldTimeMs, input.signal);
    const result = this.#consume(terminal, input.yieldTimeMs);
    if (terminal.state !== "running") this.#sessions.delete(terminal.sessionId);
    return result;
  }

  async poll(
    ownerSessionId: string,
    input: TerminalPollInput,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const terminal = this.#owned(ownerSessionId, input.sessionId);
    if (
      terminal.state === "running" &&
      terminal.stdoutBytes === 0 &&
      terminal.stderrBytes === 0
    ) {
      await this.#waitForRevision(terminal, terminal.revision, input.yieldTimeMs, signal);
    }
    const result = this.#consume(terminal, input.yieldTimeMs);
    if (terminal.state !== "running") this.#sessions.delete(terminal.sessionId);
    return result;
  }

  async write(
    ownerSessionId: string,
    input: TerminalWriteInput,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const terminal = this.#owned(ownerSessionId, input.sessionId);
    if (terminal.state !== "running" || !terminal.child.stdin?.writable) {
      throw codedError("terminal_session_not_writable", `Terminal session ${input.sessionId} is not writable.`);
    }
    await new Promise<void>((resolvePromise, reject) => {
      terminal.child.stdin!.write(input.chars, (error) => {
        if (error) reject(error);
        else resolvePromise();
      });
    });
    return this.poll(ownerSessionId, input, signal);
  }

  async stop(ownerSessionId: string, sessionId: string): Promise<Record<string, unknown>> {
    const terminal = this.#owned(ownerSessionId, sessionId);
    terminal.stopRequested = true;
    await terminateProcessTree(terminal);
    if (terminal.state === "running") {
      terminal.state = "stopped";
      this.#notify(terminal);
    }
    const result = this.#consume(terminal, 0);
    this.#sessions.delete(terminal.sessionId);
    terminal.child.stdout?.destroy();
    terminal.child.stderr?.destroy();
    terminal.child.stdin?.destroy();
    return result;
  }

  describe(ownerSessionId: string, sessionId: string) {
    const terminal = this.#owned(ownerSessionId, sessionId);
    return {
      sessionId: terminal.sessionId,
      command: terminal.command,
      pid: terminal.pid,
      state: terminal.state,
    };
  }

  list(ownerSessionId: string): Array<Record<string, unknown>> {
    return [...this.#sessions.values()]
      .filter((terminal) => terminal.ownerSessionId === ownerSessionId)
      .map((terminal) => ({
        terminalSessionId: terminal.sessionId,
        pid: terminal.pid,
        state: terminal.state,
        command: terminal.command,
        cwd: terminal.cwd,
        shell: terminal.shell,
        startedAt: new Date(terminal.startedAt).toISOString(),
        durationMs: Date.now() - terminal.startedAt,
        pendingOutput: terminal.stdoutBytes + terminal.stderrBytes > 0,
      }));
  }

  #owned(ownerSessionId: string, sessionId: string): ManagedTerminalSession {
    const terminal = this.#sessions.get(sessionId);
    if (!terminal || terminal.ownerSessionId !== ownerSessionId) {
      throw codedError("terminal_session_not_found", `Terminal session ${sessionId} is not available in this Runtime session.`);
    }
    return terminal;
  }

  #consume(terminal: ManagedTerminalSession, yieldTimeMs: number): Record<string, unknown> {
    const stdout = decodeProcessOutput(Buffer.concat(terminal.stdout));
    const stderr = decodeProcessOutput(Buffer.concat(terminal.stderr));
    terminal.stdout = [];
    terminal.stderr = [];
    terminal.stdoutBytes = 0;
    terminal.stderrBytes = 0;
    const stdoutTruncated = terminal.stdoutTruncated;
    const stderrTruncated = terminal.stderrTruncated;
    terminal.stdoutTruncated = false;
    terminal.stderrTruncated = false;
    return {
      terminalSessionId: terminal.sessionId,
      pid: terminal.pid,
      state: terminal.state,
      command: terminal.command,
      cwd: terminal.cwd,
      shell: terminal.shell,
      shellExecutable: terminal.shellExecutable,
      yieldTimeMs,
      durationMs: Date.now() - terminal.startedAt,
      exitCode: terminal.exitCode,
      signal: terminal.signal,
      stdout,
      stderr,
      stdoutTruncated,
      stderrTruncated,
      ...(terminal.error ? { error: terminal.error } : {}),
    };
  }

  #notify(terminal: ManagedTerminalSession): void {
    terminal.revision += 1;
    for (const waiter of [...terminal.waiters]) waiter();
  }

  #waitForExit(
    terminal: ManagedTerminalSession,
    yieldTimeMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (terminal.state !== "running") return Promise.resolve();
    return this.#wait(terminal, yieldTimeMs, signal, () => terminal.state !== "running");
  }

  #waitForRevision(
    terminal: ManagedTerminalSession,
    revision: number,
    yieldTimeMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (terminal.revision !== revision || terminal.state !== "running") return Promise.resolve();
    return this.#wait(
      terminal,
      yieldTimeMs,
      signal,
      () => terminal.revision !== revision || terminal.state !== "running",
    );
  }

  #wait(
    terminal: ManagedTerminalSession,
    yieldTimeMs: number,
    signal: AbortSignal | undefined,
    completed: () => boolean,
  ): Promise<void> {
    if (completed()) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    return new Promise((resolvePromise, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        terminal.waiters.delete(onChange);
        signal?.removeEventListener("abort", onAbort);
        resolvePromise();
      };
      const onChange = () => {
        if (completed()) finish();
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        terminal.waiters.delete(onChange);
        signal?.removeEventListener("abort", onAbort);
        reject(abortReason(signal!));
      };
      const timer = setTimeout(finish, yieldTimeMs);
      terminal.waiters.add(onChange);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

function appendTerminalOutput(
  terminal: ManagedTerminalSession,
  channel: "stdout" | "stderr",
  chunk: Buffer,
): void {
  const chunks = terminal[channel];
  const byteKey = channel === "stdout" ? "stdoutBytes" : "stderrBytes";
  const truncatedKey = channel === "stdout" ? "stdoutTruncated" : "stderrTruncated";
  chunks.push(Buffer.from(chunk));
  terminal[byteKey] += chunk.length;
  while (terminal[byteKey] > MAX_TERMINAL_OUTPUT_BYTES && chunks.length > 0) {
    const overflow = terminal[byteKey] - MAX_TERMINAL_OUTPUT_BYTES;
    const first = chunks[0]!;
    if (first.length <= overflow) {
      chunks.shift();
      terminal[byteKey] -= first.length;
    } else {
      chunks[0] = first.subarray(overflow);
      terminal[byteKey] -= overflow;
    }
    terminal[truncatedKey] = true;
  }
}

async function terminateProcessTree(terminal: ManagedTerminalSession): Promise<void> {
  const pid = terminal.pid;
  if (!pid) {
    terminal.child.kill();
    return;
  }
  if (process.platform === "win32") {
    await new Promise<void>((resolvePromise) => {
      const killer = spawn("taskkill.exe", ["/pid", String(pid), "/t", "/f"], {
        windowsHide: true,
      });
      killer.on("error", () => {
        terminal.child.kill();
        resolvePromise();
      });
      killer.on("close", () => resolvePromise());
    });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    terminal.child.kill("SIGTERM");
  }
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  if (terminal.state !== "running") return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    terminal.child.kill("SIGKILL");
  }
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("Terminal wait was cancelled; the terminal session remains available.");
  error.name = "AbortError";
  return error;
}

async function searchFileContent(
  path: string,
  input: SearchInput,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<ProcessResult> {
  const bundled = process.env.CARDBUSH_RG_PATH?.trim();
  const executables = [...new Set([bundled, "rg"].filter((value): value is string => Boolean(value)))];
  for (const executable of executables) {
    try {
      return await runProcess(executable, args, { cwd, signal });
    } catch (error) {
      if (!isUnavailableExecutableError(error)) throw error;
    }
  }
  return searchFileContentWithNode(path, input, signal);
}

function isUnavailableExecutableError(error: unknown): boolean {
  return ["EACCES", "EINVAL", "ENOENT", "ENOEXEC"].includes(
    String((error as NodeJS.ErrnoException)?.code),
  );
}

async function searchFileContentWithNode(
  root: string,
  input: SearchInput,
  signal?: AbortSignal,
): Promise<ProcessResult> {
  const files: string[] = [];
  const maximumFiles = 25_000;
  const maximumOutputBytes = 2 * 1024 * 1024;
  const visit = async (candidate: string): Promise<void> => {
    throwIfAborted(signal);
    let info;
    try {
      info = await lstat(candidate);
    } catch (error) {
      if (["EACCES", "ENOENT", "EPERM"].includes(String((error as NodeJS.ErrnoException).code))) return;
      throw error;
    }
    if (info.isSymbolicLink()) return;
    if (info.isFile()) {
      files.push(candidate);
      if (files.length > maximumFiles) {
        throw new Error(`Node search fallback exceeded ${maximumFiles} files; narrow path or globs.`);
      }
      return;
    }
    if (!info.isDirectory()) return;
    let entries;
    try {
      entries = await readdir(candidate, { withFileTypes: true });
    } catch (error) {
      if (["EACCES", "ENOENT", "EPERM"].includes(String((error as NodeJS.ErrnoException).code))) return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      await visit(resolve(candidate, entry.name));
    }
  };
  await visit(root);

  const rootInfo = await lstat(root);
  const globs = input.globs.map((glob) => ({
    excluded: glob.startsWith("!"),
    expression: globToRegExp(glob.startsWith("!") ? glob.slice(1) : glob),
  }));
  const positiveGlobs = globs.filter((glob) => !glob.excluded);
  const negativeGlobs = globs.filter((glob) => glob.excluded);
  const regex = input.regex ? new RegExp(input.query, "g") : undefined;
  const output: string[] = [];
  let outputBytes = 0;

  for (const file of files) {
    throwIfAborted(signal);
    const relativePath = (rootInfo.isFile() ? file.split(/[\\/]/).at(-1)! : relative(root, file))
      .replaceAll("\\", "/");
    if (positiveGlobs.length > 0 && !positiveGlobs.some((glob) => glob.expression.test(relativePath))) {
      continue;
    }
    if (negativeGlobs.some((glob) => glob.expression.test(relativePath))) continue;
    let bytes;
    try {
      bytes = await readFile(file);
    } catch (error) {
      if (["EACCES", "ENOENT", "EPERM"].includes(String((error as NodeJS.ErrnoException).code))) continue;
      throw error;
    }
    if (bytes.subarray(0, 8_192).includes(0)) continue;
    const lines = bytes.toString("utf8").split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      let column = -1;
      if (regex) {
        regex.lastIndex = 0;
        column = regex.exec(line)?.index ?? -1;
      } else {
        column = line.indexOf(input.query);
      }
      if (column < 0) continue;
      const match = `${file}:${index + 1}:${column + 1}:${line}\n`;
      outputBytes += Buffer.byteLength(match);
      if (outputBytes > maximumOutputBytes) {
        output.push(`[search output truncated at ${maximumOutputBytes} bytes]\n`);
        return {
          exitCode: 0,
          stdout: output.join(""),
          stderr: "",
          timedOut: false,
        };
      }
      output.push(match);
    }
  }
  return {
    exitCode: output.length > 0 ? 0 : 1,
    stdout: output.join(""),
    stderr: "",
    timedOut: false,
  };
}

function globToRegExp(value: string): RegExp {
  const normalized = value.trim().replaceAll("\\", "/");
  let source = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index]!;
    if (character === "*" && normalized[index + 1] === "*") {
      const followedBySlash = normalized[index + 2] === "/";
      source += followedBySlash ? "(?:.*/)?" : ".*";
      index += followedBySlash ? 2 : 1;
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("Tool execution was cancelled.");
  error.name = "AbortError";
  throw error;
}

function availableTerminalShells(): TerminalShell[] {
  return process.platform === "win32"
    ? ["powershell", "cmd"]
    : ["posix"];
}

function defaultTerminalShell(): TerminalShell {
  return process.platform === "win32" ? "powershell" : "posix";
}

function terminalToolDescription(): string {
  const shells = availableTerminalShells().join(", ");
  return [
    "Execute one command in the selected working directory.",
    `Every execution requires yield_time_ms no greater than ${MAX_TERMINAL_YIELD_MS} ms. If the command is still active then, return state=running and a terminalSessionId instead of waiting for process exit.`,
    "Running terminal sessions persist across Agent turns and are stopped only through terminal_stop or natural process exit.",
    `The shell is explicit (${shells}); the default is ${defaultTerminalShell()}.`,
    "Use syntax for the selected shell. Runtime records the shell and never rewrites commands between shell syntaxes.",
  ].join(" ");
}

function terminalShellInvocation(
  shell: TerminalShell,
  command: string,
): { executable: string; args: string[] } {
  if (shell === "powershell") {
    const harness = [
      `& { ${command} }`,
      "$cardbushCommandSucceeded = $?",
      "$cardbushNativeExitCode = $LASTEXITCODE",
      "if ($null -ne $cardbushNativeExitCode -and $cardbushNativeExitCode -ne 0) { exit $cardbushNativeExitCode }",
      "if (-not $cardbushCommandSucceeded) { exit 1 }",
    ].join("; ");
    return {
      executable: "powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", harness],
    };
  }
  if (shell === "cmd") {
    return {
      executable: process.env.ComSpec?.trim() || "cmd.exe",
      args: ["/d", "/s", "/c", command],
    };
  }
  return { executable: "/bin/sh", args: ["-c", command] };
}

function runProcess(
  file: string,
  args: string[],
  options: {
    cwd: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    shell?: boolean;
  },
): Promise<ProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      shell: options.shell ?? false,
      windowsHide: true,
      signal: options.signal,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, options.timeoutMs)
      : undefined;
    child.stdout.on("data", (chunk: Buffer) => { stdoutChunks.push(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderrChunks.push(chunk); });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (timeout) clearTimeout(timeout);
      resolvePromise({
        exitCode,
        stdout: decodeProcessOutput(Buffer.concat(stdoutChunks)),
        stderr: decodeProcessOutput(Buffer.concat(stderrChunks)),
        timedOut,
      });
    });
  });
}

function decodeProcessOutput(bytes: Buffer): string {
  if (bytes.length === 0) return "";
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    if (process.platform === "win32") {
      try {
        return new TextDecoder("gbk", { fatal: true }).decode(bytes);
      } catch {
        // Preserve output even when it is neither valid UTF-8 nor the Windows
        // Simplified Chinese code page used by the local shell.
      }
    }
    return bytes.toString("utf8");
  }
}
