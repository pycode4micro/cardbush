import { createDisplayDiff } from './workspaceDiff.js';
import { authorizePath, resolveToolPath, workspaceRoot, protectedProjectRoots, normalizeIdentity } from './workspaceAccessPolicy.js';
import { TerminalSessionManager, type TerminalShell } from './terminalSessionManager.js';
// Preserve existing Runtime consumers while the implementations remain independent.
export { authorizePath } from './workspaceAccessPolicy.js';
export { TerminalSessionManager } from './terminalSessionManager.js';
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  writeFile,
} from "node:fs/promises";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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
import { searchWorkspaceContent, type WorkspaceSearchInput as SearchInput } from './workspaceSearch.js';
import { assertInProcessFileSize, readFileBounded, readFileLineRange, type FileLineRange } from "./workspaceFileRead.js";
import { renderTerminalResult, renderTextFields } from "./toolResultText.js";
import { workspaceEditRecoveryError } from './workspaceEditRecovery.js';
import { decodeExclusiveResources, runtimeExclusiveResources } from './exclusiveResources.js';

interface PathInput { path: string }
interface ReadFileInput extends PathInput { encoding: BufferEncoding; range?: FileLineRange }
interface WriteFileInput extends PathInput { content: string; encoding: BufferEncoding }
interface EditFileInput extends PathInput {
  oldText: string;
  range?: { start: number; end: number; sha256: string };
  newText: string;
  replaceAll: boolean;
  encoding: BufferEncoding;
}
interface TerminalInput {
  exclusiveResources: string[];
  notifyOnExit: boolean;
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
    return runtimeExclusiveResources.acquire('workspace edit', dirname(path), [path], 'workspace_resource_busy');
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
    onTerminalStarted?: (context: ToolHandlerContext<any>, result: Record<string, unknown>) => string | undefined;
    ownsFileVersion?: (sessionId: string, path: string) => Promise<boolean>; remote?: RemoteWorkspaceBridge;
    commandSandbox?: CommandSandboxConfiguration; loadCommandSandbox?: () => Promise<CommandSandboxConfiguration> } = {},
): WorkspaceObservationStore {
  const createChangeId = options.createChangeId ?? (() => `change_${randomUUID()}`);
  const terminals = options.terminals ?? new TerminalSessionManager();
  const searches = new Map<string, Promise<Awaited<ReturnType<typeof searchWorkspaceContent>>>>();
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
    if (targetRegistry.resolve(registration.definition.name)) return;
    const routed = routeWorkspaceTool(registration, terminals, options.remote, commandSandbox.mode === 'required');
    if (registration.definition.name === 'terminal_exec' && options.onTerminalStarted) {
      const execute = routed.execute;
      routed.execute = async context => {
        const result = await execute(context) as Record<string, unknown>;
        if (result.state === 'running' && (context.input as TerminalInput).notifyOnExit && context.turn) {
          const taskId = options.onTerminalStarted!(context, result);
          return { ...result, completion_notification: Boolean(taskId), ...(taskId ? { completion_task_id: taskId,
            next_step: 'Continue independent work now. Completion arrives automatically; wait only when it blocks the next step.' } : {}) };
        }
        return result;
      };
    }
    targetRegistry.register(routed);
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
      description: "Prefer this bounded search over recursive shell grep for local file content. Start with a narrow path and globs; use output_mode=files to locate files before reading relevant lines. Dependency/cache directories are pruned before traversal unless include_dependencies=true. Defaults: 100 lines/files, 64 KiB, 10 seconds. Partial results set complete=false with a limitReason; do not interpret them as no other matches. Identical in-flight searches in this turn share one execution. Matching lines use path:line:column:text; context lines use path-line-text, without duplicate overlapping context.",
      inputSchema: objectSchema({
        query: { type: "string", minLength: 1 },
        path: { type: "string", minLength: 1 },
        regex: { type: "boolean", default: false },
        globs: { type: "array", items: { type: "string" }, default: [] },
        context_before: { type: "integer", minimum: 0, maximum: 100, default: 0 },
        context_after: { type: "integer", minimum: 0, maximum: 100, default: 0 },
        output_mode: { type: 'string', enum: ['lines', 'files'], default: 'lines' },
        max_results: { type: 'integer', minimum: 1, maximum: 10000, default: 100, description: 'Maximum returned lines (including context) or file paths.' },
        max_output_bytes: { type: 'integer', minimum: 1024, maximum: 2097152, default: 65536 },
        timeout_ms: { type: 'integer', minimum: 100, maximum: 60000, default: 10000 },
        include_dependencies: { type: 'boolean', default: false },
      }, ["query", "path"]),
    },
    manifest: manifest("filesystem.search", "observation", false),
    parallelSafe: true,
    decodeInput: decodeSearch,
    renderModelResult: (result) => renderTextFields(result, ["output"]),
    authorize: authorizePath("read"),
    execute: async (context: ToolHandlerContext<SearchInput>) => {
      const path = await resolveToolPath(context, context.input.path);
      const key = JSON.stringify([context.sessionId, context.turnId, { ...context.input, path: normalizeIdentity(path) }]);
      const running = searches.get(key);
      if (running) return { ...await running, reused: true };
      const execution = searchWorkspaceContent(path, context.input, workspaceRoot(context) ?? dirname(path), context.signal);
      searches.set(key, execution);
      try { return await execution; }
      finally { searches.delete(key); }
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
      description: "Edit one previously read file. Use old_text for exact unique replacement, or start_line/end_line (1-based inclusive) with expected_sha256 from read_file to replace complete lines, including their line endings, with new_text. Do not combine modes. Stale revisions and ambiguous matches fail without writing. After a match failure, inspect with read_file and use a unique match or version-checked line range instead of repeating the same edit. Full review/revert evidence is stored by Runtime.",
      inputSchema: objectSchema({
        path: { type: "string", minLength: 1 },
        old_text: { type: "string", minLength: 1 },
        start_line: { type: "integer", minimum: 1 },
        end_line: { type: "integer", minimum: 1 },
        expected_sha256: { type: "string", pattern: "^[a-fA-F0-9]{64}$" },
        new_text: { type: "string" },
        replace_all: { type: "boolean", default: false },
        encoding: { type: "string", default: "utf8" },
      }, ["path", "new_text"]),
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
        let oldText = context.input.oldText, rangeOffsets: { start: number; end: number } | undefined;
        if (context.input.range) {
          const range = context.input.range;
          if (digest(before) !== range.sha256) throw workspaceEditRecoveryError('workspace_revision_mismatch', 'expected_sha256 differs from the current file.');
          const lines = source.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
          if (range.end > lines.length) throw workspaceEditRecoveryError('edit_line_range_invalid', `File has ${lines.length} lines; the range is outside it.`);
          const start = lines.slice(0, range.start - 1).join('').length;
          const end = start + lines.slice(range.start - 1, range.end).join('').length;
          rangeOffsets = { start, end };
          oldText = source.slice(start, end);
        }
        const count = rangeOffsets ? 1 : occurrences(source, oldText);
        if (count === 0) {
          throw workspaceEditRecoveryError(
            "edit_old_text_not_found",
            "old_text was not found in the current file revision.",
          );
        }
        if (!context.input.replaceAll && count !== 1) {
          throw workspaceEditRecoveryError(
            "edit_old_text_ambiguous",
            `old_text matched ${count} times; the target is ambiguous.`,
          );
        }
        const replacements = context.input.replaceAll ? count : 1;
        assertInProcessFileSize(before.length + replacements * (
          Buffer.byteLength(context.input.newText, context.input.encoding) - Buffer.byteLength(oldText, context.input.encoding)
        ));
        const next = rangeOffsets ? source.slice(0, rangeOffsets.start) + context.input.newText + source.slice(rangeOffsets.end)
          : context.input.replaceAll ? source.replaceAll(oldText, () => context.input.newText)
          : source.replace(oldText, () => context.input.newText);
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
        exclusive_resources: {
          type: 'array', maxItems: 16, items: { type: 'string', minLength: 1, maxLength: 4096 },
          description: 'Cooperative exclusive resources on this Runtime host. For parallel builds/tests, declare the same absolute project/output path (directories include descendants); for GPU or browser profiles use the same host:gpu or host:browser-profile label. Relative paths resolve against cwd. Leases last until the process tree exits, including after this call returns. A conflict returns terminal_resource_busy without starting the command; coordinate with the owning task before retrying. Does not grant permissions or lock external processes. Direct SSH is unsupported; use a CardBush Agent there.',
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
        notify_on_exit: { type: 'boolean', default: true, description: 'After yielding a running command, Runtime delivers one completion notification during this turn and waits before ending it. Do other independent work; do not repeatedly poll. Set false for persistent servers or interactive processes that should outlive the task. Notifications stop when the turn is stopped; the command is not restarted.' },
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
    renderModelResult: renderTerminalResult,
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
        exclusiveResources: context.input.exclusiveResources,
      });
    },
  });

  registerIfMissing(registry, {
    definition: {
      name: "terminal_poll",
      description: [
        "Read new output or wait up to yield_time_ms for a state change from an existing terminal session. For completion-only waits with completion_notification=true, use manage_tool_calls instead.",
        "Pass the returned terminalSessionId as session_id. If state=running, do independent work before waiting on the same session; do not restart the command. Empty output does not mean completion.",
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
    renderModelResult: renderTerminalResult,
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
    renderModelResult: renderTerminalResult,
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
    renderModelResult: renderTerminalResult,
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
    if (context.toolCall?.name === 'edit_file') {
      throw workspaceEditRecoveryError('workspace_revision_not_observed', 'The current file revision has not been read or has changed since it was read.');
    }
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
  let range: EditFileInput['range'];
  if (object.start_line !== undefined || object.end_line !== undefined || object.expected_sha256 !== undefined) {
    if (object.old_text !== undefined || object.replace_all !== undefined) throw new Error('Do not combine line ranges with old_text or replace_all.');
    if (!Number.isSafeInteger(object.start_line) || Number(object.start_line) < 1 || !Number.isSafeInteger(object.end_line) || Number(object.end_line) < Number(object.start_line) || typeof object.expected_sha256 !== 'string' || !/^[a-f\d]{64}$/i.test(object.expected_sha256)) throw new Error('Line edits require start_line <= end_line and expected_sha256 from read_file.');
    if (['hex', 'base64', 'base64url'].includes(encoding(object.encoding))) throw new Error('Line ranges require a text encoding.');
    range = { start: Number(object.start_line), end: Number(object.end_line), sha256: object.expected_sha256.toLowerCase() };
  }
  return {
    path: requiredString(object.path, "path"),
    oldText: range ? '' : requiredString(object.old_text, "old_text", false),
    ...(range ? { range } : {}),
    newText: stringValue(object.new_text, "new_text"),
    replaceAll: booleanValue(object.replace_all, false),
    encoding: encoding(object.encoding),
  };
}

function decodeSearch(input: unknown): SearchInput {
  const object = objectInput(input);
  const contextLines = (value: unknown) => {
    if (value === undefined) return 0;
    if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 100) throw new Error('Search context must be an integer between 0 and 100.');
    return Number(value);
  };
  const budget = (name: string, fallback: number, min: number, max: number) => {
    const value = object[name] ?? fallback;
    if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) throw new Error(`${name} must be an integer between ${min} and ${max}.`);
    return Number(value);
  };
  if (object.output_mode !== undefined && !['lines', 'files'].includes(String(object.output_mode))) throw new Error('output_mode must be lines or files.');
  return {
    query: requiredString(object.query, "query", false),
    path: requiredString(object.path, "path"),
    regex: booleanValue(object.regex, false),
    globs: stringArray(object.globs, "globs"),
    contextBefore: contextLines(object.context_before),
    contextAfter: contextLines(object.context_after),
    outputMode: object.output_mode === 'files' ? 'files' : 'lines',
    maxResults: budget('max_results', 100, 1, 10000),
    maxOutputBytes: budget('max_output_bytes', 65536, 1024, 2097152),
    timeoutMs: budget('timeout_ms', 10000, 100, 60000),
    includeDependencies: booleanValue(object.include_dependencies, false),
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
    exclusiveResources: decodeExclusiveResources(object.exclusive_resources),
    notifyOnExit: booleanValue(object.notify_on_exit, true),
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
    `Every execution requires yield_time_ms no greater than ${MAX_TERMINAL_YIELD_MS} ms. This bounds the call's wait, not the command's duration. Use a short yield (e.g. 1000 ms) for long tasks so you can continue independent work. If completion_notification=true, continue independent work; use manage_tool_calls action=wait with completion_task_id only when its result blocks progress and no independent work remains. Results arrive automatically without polling. Otherwise use terminal_poll with the returned terminalSessionId when new output is needed. Never restart a running command. Use search_file_content for local content searches instead of recursive shell traversal.`,
    process.platform === "win32"
      ? "To delay before rechecking an external task, use shell=powershell with a sleep command, e.g. Start-Sleep -Seconds 30. Reuse an existing running wait session when available."
      : "To delay before rechecking an external task, use shell=posix with a sleep command, e.g. sleep 30. Reuse an existing running wait session when available.",
    "Running sessions persist across Agent turns until terminal_stop, natural exit, or a host resource limit. On Windows the whole task tree shares host memory/CPU budgets; detached descendants end with the session. After a resource-limit failure, reduce the workload instead of bypassing the guard or repeating the same command.",
    "Do not launch a browser for the user through this terminal (including Start-Process or shell start): a newly created browser can be killed when the command exits. Use open_external_url when available for a webpage the user wants to keep open; use Browser Use for page control. If neither is available, return the link instead of bypassing process cleanup.",
    `The shell is explicit (${shells}); the default is ${defaultTerminalShell()}.`,
    "Use syntax for the selected shell. Runtime records the shell and never rewrites commands between shell syntaxes.",
  ].join(" ");
}
