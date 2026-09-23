import { authorizePath, resolveToolPath, workspaceRoot, protectedProjectRoots, normalizeIdentity } from './workspaceAccessPolicy.js';
import { TerminalSessionManager, type TerminalShell } from './terminalSessionManager.js';
// Preserve existing Runtime consumers while the implementations remain independent.
export { authorizePath } from './workspaceAccessPolicy.js';
export { TerminalSessionManager } from './terminalSessionManager.js';
import { decodeCommandOutput as decodeProcessOutput } from "@cardbush/platform";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  writeFile,
} from "node:fs/promises";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

import type {
  ToolAdmissionContext,
  ToolHandlerContext,
  ToolRegistration,
  ToolRegistry,
} from "./toolRegistry.js";
import { protectedTerminalDeletion } from "./terminalCommandSafety.js";
import { routeWorkspaceTool } from './workspaceToolRouting.js';
import { snapshotCommandSandbox, type CommandSandboxConfiguration } from './commandSandboxPolicy.js';
import { terminalInputPermission } from './commandPermission.js';
import { authorizedCommandSandbox, commandSandboxPlan, decodeAdditionalCommandPermissions, type AdditionalCommandPermissions } from './commandSandboxAdmission.js';
import { spawnResourceManagedProcess } from "./processResourceGuard.js";
import { assertInProcessFileSize, readFileBounded, readFileLineRange, type FileLineRange } from "./workspaceFileRead.js";
import { renderTextFields } from "./toolResultText.js";

interface PathInput { path: string }
interface ReadFileInput extends PathInput { encoding: BufferEncoding; range?: FileLineRange }
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
  additionalPermissions?: AdditionalCommandPermissions;
  justification?: string;
}

interface TerminalSessionInput { sessionId: string }
interface TerminalPollInput extends TerminalSessionInput { yieldTimeMs: number }
interface TerminalWriteInput extends TerminalPollInput { chars: string }


const MAX_TERMINAL_YIELD_MS = 30_000;

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

export interface RemoteWorkspaceBridge {
  request(action: 'authorize' | 'execute' | 'directory' | 'terminals', payload: Record<string, unknown>, signal?: AbortSignal): Promise<any>;
}

export function registerWorkspaceTools(
  registry: ToolRegistry,
  observations: WorkspaceObservationStore = new WorkspaceObservationStore(),
  options: { createChangeId?: () => string; terminals?: TerminalSessionManager;
    ownsFileVersion?: (sessionId: string, path: string) => Promise<boolean>; remote?: RemoteWorkspaceBridge;
    commandSandbox?: CommandSandboxConfiguration; loadCommandSandbox?: () => Promise<CommandSandboxConfiguration> } = {},
): WorkspaceObservationStore {
  const createChangeId = options.createChangeId ?? (() => `change_${randomUUID()}`);
  const terminals = options.terminals ?? new TerminalSessionManager();
  const commandSandbox = snapshotCommandSandbox(options.commandSandbox);
  // One immutable policy per decoded invocation, including time spent awaiting approval.
  const sandboxInvocations = new WeakMap<TerminalInput, Promise<CommandSandboxConfiguration>>();
  const sandboxFor = (input: TerminalInput) => {
    let policy = sandboxInvocations.get(input);
    if (!policy) {
      policy = options.loadCommandSandbox ? options.loadCommandSandbox().then(snapshotCommandSandbox) : Promise.resolve(commandSandbox);
      sandboxInvocations.set(input, policy);
    }
    return policy;
  };
  function registerIfMissing<T>(targetRegistry: ToolRegistry, registration: ToolRegistration<T>) {
    if (!targetRegistry.resolve(registration.definition.name)) targetRegistry.register(routeWorkspaceTool(registration, terminals, options.remote, commandSandbox.mode === 'required'));
  }

  registerIfMissing(registry, {
    definition: {
      name: "read_file",
      description: "Read one file exactly. Prefer start_line and line_count for large files; lines are 1-based, original line endings are preserved, and the SHA-256 revision always covers the entire file. A ranged read returns total_lines and next_start_line; start_line alone reads up to 200 lines. Omit both range arguments for complete content. Use an absolute path when the Turn has no workspace.",
      inputSchema: objectSchema({
        path: { type: "string", minLength: 1 },
        encoding: { type: "string", default: "utf8" },
        start_line: { type: "integer", minimum: 1, description: "First line to read, inclusive. Defaults to 1 when line_count is supplied." },
        line_count: { type: "integer", minimum: 1, description: "Maximum lines to return. Defaults to 200 when start_line is supplied." },
      }, ["path"]),
    },
    manifest: manifest("filesystem.read", "observation", false),
    parallelSafe: true,
    decodeInput: decodeRead,
    renderModelResult: (result) => renderTextFields(result, ["content"]),
    authorize: authorizePath("read"),
    execute: async (context: ToolHandlerContext<ReadFileInput>) => {
      const path = await resolveToolPath(context, context.input.path);
      if (context.input.range) {
        const result = await readFileLineRange(path, context.input.encoding, context.input.range, context.signal);
        observations.record(context.sessionId, path, result.sha256, workspaceRoot(context));
        return { path, ...result };
      }
      const bytes = await readFileBounded(path, context.signal);
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
    renderModelResult: (result) => renderTextFields(result, ["output"]),
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
      const complete = !execution.timedOut && (execution.exitCode === 0 || execution.exitCode === 1);
      return {
        matched: execution.stdout.length > 0,
        output: execution.stdout,
        complete,
        exitCode: execution.exitCode,
        ...(execution.stderr ? { warnings: execution.stderr } : {}),
      };
    },
  });

  registerIfMissing(registry, {
    definition: {
      name: "write_file",
      description: "Create or replace one file. Existing files must have been read at their current SHA-256 revision first. Use an absolute path when the Turn has no workspace. Returns a compact execution receipt; full review and revert evidence is stored separately by Runtime.",
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
        assertInProcessFileSize(Buffer.byteLength(context.input.content, context.input.encoding));
        const before = await optionalBytes(path);
        assertObservedIfExisting(context, observations, path, before);
        const versioned = await options.ownsFileVersion?.(context.sessionId, path) ?? false;
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, context.input.content, { encoding: context.input.encoding });
        const after = await readFileBounded(path, context.signal);
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
          versioned,
        );
      } finally {
        release();
      }
    },
  });

  registerIfMissing(registry, {
    definition: {
      name: "edit_file",
      description: "Replace exact text in one previously read file. Fails if the current file revision was not observed or the old text is absent/ambiguous. Returns a compact execution receipt; full review and revert evidence is stored separately by Runtime.",
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
        const before = await readFileBounded(path, context.signal);
        assertObservedIfExisting(context, observations, path, before);
        const versioned = await options.ownsFileVersion?.(context.sessionId, path) ?? false;
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
        const replacements = context.input.replaceAll ? count : 1;
        assertInProcessFileSize(before.length + replacements * (
          Buffer.byteLength(context.input.newText, context.input.encoding) - Buffer.byteLength(context.input.oldText, context.input.encoding)
        ));
        const next = context.input.replaceAll
          ? source.replaceAll(context.input.oldText, () => context.input.newText)
          : source.replace(context.input.oldText, () => context.input.newText);
        assertInProcessFileSize(Buffer.byteLength(next, context.input.encoding));
        await writeFile(path, next, { encoding: context.input.encoding });
        const after = await readFileBounded(path, context.signal);
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
          versioned,
        );
      } finally {
        release();
      }
    },
  });

  registerIfMissing(registry, {
    definition: {
      name: "terminal_exec",
      description: terminalToolDescription() + (options.remote ? ' For SSH execution use shell="posix"; environment="local" uses this host and its native shell.' : ''),
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
          description: `Required maximum wait for this call, not a command timeout. A still-running command returns a terminal session handle and continues running. Maximum ${MAX_TERMINAL_YIELD_MS} ms.`,
        },
        shell: {
          type: "string",
          enum: options.remote ? ['cmd', 'powershell', 'posix'] : availableTerminalShells(),
          default: defaultTerminalShell(),
          description: "Explicit command interpreter. Runtime never rewrites commands between shell syntaxes.",
        },
        additional_permissions: {
          type: 'object', additionalProperties: false,
          description: 'Request extra sandbox access for this command and its descendants only. Requires approval; does not disable isolation. Check partial results before retrying a denied operation; never repeat completed side effects. Direct SSH does not support sandbox extensions.',
          properties: {
            read_roots: { type: 'array', maxItems: 32, items: { type: 'string' }, description: 'Existing absolute directories to read.' },
            write_roots: { type: 'array', maxItems: 32, items: { type: 'string' }, description: 'Existing absolute directories to read and write.' },
            network: { type: 'boolean', description: 'Request network access; currently all destinations, not a domain allowlist.' },
          },
        },
        justification: { type: 'string', description: 'Why the additional access is needed.' },
      }, ["command", "cwd", "yield_time_ms", "shell"]),
    },
    manifest: manifest("terminal.execute", "process_execution", true),
    decodeInput: input => decodeTerminal(input, Boolean(options.remote)),
    renderModelResult: (result) => renderTextFields(result, ["stdout", "stderr"]),
    authorize: async (context: ToolAdmissionContext<TerminalInput>) => {
      const cwd = await resolveToolPath(context, terminalWorkingDirectory(context), true);
      const lexicalProjectRoots = protectedProjectRoots(context);
      const canonicalProjectRoots = await Promise.all(lexicalProjectRoots.map((root) =>
        resolveToolPath(context, root, true)
      ));
      const protectedDeletion = protectedTerminalDeletion({
        command: context.input.command,
        cwd,
        shell: context.input.shell,
        projectRoots: [...new Set([...lexicalProjectRoots, ...canonicalProjectRoots])],
      });
      if (protectedDeletion) {
        return {
          kind: "deny" as const,
          code: "protected_path_delete_denied",
          message: protectedDeletion.message,
          details: {
            protection: protectedDeletion.protection,
            target: protectedDeletion.target,
          },
        };
      }
      return (await commandSandboxPlan(await sandboxFor(context.input), context, cwd)).admission;
    },
    execute: async (context: ToolHandlerContext<TerminalInput>) => {
      const cwd = await resolveToolPath(context, terminalWorkingDirectory(context), true);
      const plan = await commandSandboxPlan(await sandboxFor(context.input), context, cwd);
      return terminals.start({
        ownerSessionId: context.sessionId,
        command: context.input.command,
        cwd,
        yieldTimeMs: context.input.yieldTimeMs,
        signal: context.signal,
        shell: context.input.shell,
        sandbox: authorizedCommandSandbox(plan, context.capabilityIds),
      });
    },
  });

  registerIfMissing(registry, {
    definition: {
      name: "terminal_poll",
      description: [
        "Wait up to yield_time_ms for new output or a state change from an existing terminal session, including a sleep started by terminal_exec.",
        "Pass the returned terminalSessionId as session_id. If state=running, continue waiting on the same session instead of starting another command; empty output does not mean completion.",
        "Returns only output produced since the preceding terminal result.",
      ].join(" "),
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
    renderModelResult: (result) => renderTextFields(result, ["stdout", "stderr"]),
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
    renderModelResult: (result) => renderTextFields(result, ["stdout", "stderr"]),
    authorize: (context: ToolAdmissionContext<TerminalWriteInput>) => {
      const terminal = terminals.describe(context.sessionId, context.input.sessionId);
      return terminal.sandbox ? { kind: 'allow' as const }
        : terminalInputPermission({ ...context.input, environment: 'local' });
    },
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
    renderModelResult: (result) => renderTextFields(result, ["stdout", "stderr"]),
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
  versioned: boolean,
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
        ...(before && !versioned ? { beforeContentBase64: before.toString("base64") } : {}),
        workspaceVersioned: versioned,
        diff: diff.text,
      },
  };
  context.recordWorkspaceChange(change);
  return {
    path,
    status,
    sha256: change.after_hash,
    change_id: change.change_id,
    additions: change.additions,
    deletions: change.deletions,
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
  const fileEncoding = encoding(object.encoding);
  let range: FileLineRange | undefined;
  if (object.start_line !== undefined || object.line_count !== undefined) {
    const startLine = object.start_line === undefined ? 1 : object.start_line;
    const lineCount = object.line_count === undefined ? 200 : object.line_count;
    if (!Number.isSafeInteger(startLine) || Number(startLine) < 1 ||
        !Number.isSafeInteger(lineCount) || Number(lineCount) < 1 ||
        Number(startLine) > Number.MAX_SAFE_INTEGER - (Number(lineCount) - 1)) {
      throw new Error("start_line and line_count must be positive safe integers with a safe range end.");
    }
    if (["hex", "base64", "base64url"].includes(fileEncoding)) {
      throw new Error("Line ranges require a text encoding, not hex or base64.");
    }
    range = { startLine: Number(startLine), lineCount: Number(lineCount) };
  }
  return { path: requiredString(object.path, "path"), encoding: fileEncoding, ...(range ? { range } : {}) };
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

function decodeTerminal(input: unknown, remoteAvailable = false): TerminalInput {
  const object = objectInput(input);
  const yieldTime = object.yield_time_ms;
  if (!Number.isInteger(yieldTime) || Number(yieldTime) < 1) {
    throw new Error("yield_time_ms is required and must be a positive integer.");
  }
  if (Number(yieldTime) > MAX_TERMINAL_YIELD_MS) {
    throw new Error(`yield_time_ms must not exceed ${MAX_TERMINAL_YIELD_MS}.`);
  }
  const shell = object.shell === undefined ? defaultTerminalShell() : String(object.shell);
  if (!(remoteAvailable ? ['cmd', 'powershell', 'posix'] : availableTerminalShells()).includes(shell as TerminalShell)) {
    throw new Error(
      `shell must be one of: ${availableTerminalShells().join(", ")}.`,
    );
  }
  return {
    command: requiredString(object.command, "command", false),
    cwd: typeof object.cwd === "string" ? object.cwd.trim() : "",
    yieldTimeMs: Number(yieldTime),
    shell: shell as TerminalShell,
    additionalPermissions: decodeAdditionalCommandPermissions(object.additional_permissions),
    justification: typeof object.justification === 'string' ? object.justification.trim().slice(0, 2000) : undefined,
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
  try { return await readFileBounded(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
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

interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
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
  const warnings: string[] = [];
  let warningCount = 0;
  const warn = (error: unknown) => {
    warningCount++;
    if (warnings.length < 32) warnings.push(error instanceof Error ? error.message : String(error));
  };
  const maximumFiles = 25_000;
  const maximumOutputBytes = 2 * 1024 * 1024;
  const visit = async (candidate: string): Promise<void> => {
    throwIfAborted(signal);
    let info;
    try {
      info = await lstat(candidate);
    } catch (error) {
      if (["EACCES", "ENOENT", "EPERM", "EBUSY"].includes(String((error as NodeJS.ErrnoException).code))) { warn(error); return; }
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
      if (["EACCES", "ENOENT", "EPERM", "EBUSY"].includes(String((error as NodeJS.ErrnoException).code))) { warn(error); return; }
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
      bytes = await readFileBounded(file, signal);
    } catch (error) {
      if (["EACCES", "ENOENT", "EPERM", "EBUSY", "file_resource_limit"].includes(String((error as NodeJS.ErrnoException).code))) { warn(error); continue; }
      throw error;
    }
    // Match ripgrep's Unicode BOM behavior: UTF-16 padding is not binary content.
    const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le"
      : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : undefined;
    if (!utf16 && bytes.subarray(0, 8_192).includes(0)) continue;
    let text: string;
    try {
      text = utf16 ? new TextDecoder(utf16, { fatal: true }).decode(bytes) : bytes.toString("utf8").replace(/^\ufeff/, "");
    } catch { continue; }
    if (text.includes("\0")) continue;
    const lines = text.split(/\r\n|\r|\n/);
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
        return {
          exitCode: 2,
          stdout: output.join(""),
          stderr: [...warnings, `Search output truncated at ${maximumOutputBytes} bytes; narrow path or globs.`].join("\n"),
          timedOut: false,
        };
      }
      output.push(match);
    }
  }
  return {
    exitCode: warningCount ? 2 : output.length > 0 ? 0 : 1,
    stdout: output.join(""),
    stderr: warnings.join("\n") + (warningCount > warnings.length ? `\n${warningCount - warnings.length} additional file access errors.` : ""),
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
    `Every execution requires yield_time_ms no greater than ${MAX_TERMINAL_YIELD_MS} ms. This bounds the call's wait, not the command's duration. If state=running, pass the returned terminalSessionId to terminal_poll as session_id to continue waiting; do not restart the command.`,
    process.platform === "win32"
      ? "To delay before rechecking an external task, use shell=powershell with a sleep command, e.g. Start-Sleep -Seconds 30. Reuse an existing running wait session when available."
      : "To delay before rechecking an external task, use shell=posix with a sleep command, e.g. sleep 30. Reuse an existing running wait session when available.",
    "Running sessions persist across Agent turns until terminal_stop, natural exit, or a host resource limit. On Windows the whole task tree shares host memory/CPU budgets; detached descendants end with the session. After a resource-limit failure, reduce the workload instead of bypassing the guard or repeating the same command.",
    `The shell is explicit (${shells}); the default is ${defaultTerminalShell()}.`,
    "Use syntax for the selected shell. Runtime records the shell and never rewrites commands between shell syntaxes.",
  ].join(" ");
}

async function runProcess(
  file: string,
  args: string[],
  options: {
    cwd: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<ProcessResult> {
  throwIfAborted(options.signal);
  const guarded = await spawnResourceManagedProcess({ executable: file, args, cwd: options.cwd });
  return new Promise((resolvePromise, reject) => {
    const child = guarded.child;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let outputLimited = false;
    let stdoutBytes = 0, stderrBytes = 0;
    const maximumOutputBytes = 2 * 1024 * 1024;
    const onAbort = guarded.stop;
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    const timeout = setTimeout(() => {
      timedOut = true;
      guarded.stop();
    }, options.timeoutMs ?? 30_000);
    const append = (chunks: Buffer[], chunk: Buffer, used: number) => {
      const remaining = Math.max(0, maximumOutputBytes - used);
      if (remaining) chunks.push(Buffer.from(chunk.subarray(0, remaining)));
      if (chunk.length > remaining && !outputLimited) { outputLimited = true; guarded.stop(); }
      return used + Math.min(chunk.length, remaining);
    };
    child.stdout.on("data", (chunk: Buffer) => { stdoutBytes = append(stdoutChunks, chunk, stdoutBytes); });
    child.stderr.on("data", (chunk: Buffer) => { stderrBytes = append(stderrChunks, chunk, stderrBytes); });
    child.on("error", error => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", async (exitCode) => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      const report = await guarded.complete();
      if (options.signal?.aborted) {
        try { throwIfAborted(options.signal); } catch (error) { reject(error); }
        return;
      }
      if (report?.code === "resource_spawn_failed") {
        const code = ({ 2: "ENOENT", 3: "ENOENT", 5: "EACCES", 193: "ENOEXEC" } as Record<number, string>)[report.nativeErrorCode ?? 0];
        if (code) { reject(codedError(code, report.message)); return; }
      }
      const warnings = [decodeProcessOutput(Buffer.concat(stderrChunks)),
        outputLimited ? "Search output exceeded 2 MiB and was stopped. Narrow the path or query; these results are incomplete." : "",
        timedOut ? "Search exceeded its 30-second execution budget; these results are incomplete." : "",
        report?.code && !outputLimited && !timedOut ? report.message : "",
      ].filter(Boolean).join("\n");
      resolvePromise({
        exitCode: outputLimited || timedOut || report?.code ? 2 : exitCode,
        stdout: decodeProcessOutput(Buffer.concat(stdoutChunks)),
        stderr: warnings,
        timedOut,
      });
    });
  });
}
