import { createDisplayDiff } from './workspaceDiff.js';
import { commandShells, defaultCommandShell } from '@cardbush/platform';
import { sshShellOptions } from '@cardbush/bush-protocol';
import { withToolFailureFacts } from './toolFailureFacts.js';
import { applyFilePatch, parseWorkspacePatch, type FilePatch } from './workspacePatch.js';
import { authorizePath, resolveToolPath, workspaceRoot, protectedProjectRoots, isWithin, normalizeIdentity, usesAssistantWorkspaceApproval } from './workspaceAccessPolicy.js';
import { TerminalSessionManager, type TerminalShell } from './terminalSessionManager.js';
// Preserve existing Runtime consumers while the implementations remain independent.
export { authorizePath } from './workspaceAccessPolicy.js';
export { TerminalSessionManager } from './terminalSessionManager.js';
import { createHash, randomUUID } from "node:crypto";
import { bindWorkspaceFileAuthorization, createWorkspaceParent, persistAfterWorkspaceFileAccess, writeWorkspaceFile as writeFile, unlinkWorkspaceFile as unlink } from './workspaceFileAccess.js';
import { readFileSync } from "node:fs";
import { mkdir, realpath, rename, rm, writeFile as writeState } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { projectFileSourceResult } from './fileSourceReceipt.js';
import { dirname, resolve } from "node:path";

import {
  localCommandExecutionChannel,
  type ToolAdmissionContext,
  type ToolHandlerContext,
  type ToolRegistration,
  type ToolRegistry,
} from "./toolRegistry.js";
import { protectedTerminalDeletion } from "./terminalCommandSafety.js";
import { routeWorkspaceTool, workspaceFileResources } from './workspaceToolRouting.js';
import { snapshotCommandSandbox, type CommandSandboxConfiguration } from './commandSandboxPolicy.js';
import { terminalInputPermission } from './commandPermission.js';
import { authorizedCommandSandbox, commandSandboxPlan, decodeAdditionalCommandPermissions, type AdditionalCommandPermissions } from './commandSandboxAdmission.js';
import { searchWorkspaceContent, type WorkspaceSearchInput as SearchInput } from './workspaceSearch.js';
import { assertInProcessFileSize, readFileBounded, readFileLineRange, type FileLineRange } from "./workspaceFileRead.js";
import { renderTerminalResult, projectTerminalResult, renderTextFields } from "./toolResultText.js";
import { workspaceEditRecoveryError } from './workspaceEditRecovery.js';
import { workspaceWriteFailure } from './workspaceWriteFailure.js';
import { decodeExclusiveResources, runtimeExclusiveResources } from './exclusiveResources.js';
import { isSkillReadResource } from './skillTools.js';
import { userDirectories } from './userDirectories.js';

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
  writePaths?: Array<{ path: string; expectedSha256: string }>;
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
  #persisting: Promise<void> = Promise.resolve();

  constructor(options: { persistencePath?: string } = {}) {
    this.#persistencePath = options.persistencePath;
    if (this.#persistencePath) this.#load();
  }

  async record(sessionId: string, path: string, sha256: string, projectRoot?: string): Promise<void> {
    const session = this.#observations.get(sessionId) ?? new Map<string, Observation>();
    session.set(normalizeIdentity(path), { sha256, observedAt: new Date().toISOString() });
    this.#observations.set(sessionId, session);
    if (projectRoot) {
      const project = this.#projectObservations.get(normalizeIdentity(projectRoot)) ?? new Map<string, Observation>();
      project.set(normalizeIdentity(path), { sha256, observedAt: new Date().toISOString() });
      this.#projectObservations.set(normalizeIdentity(projectRoot), project);
      if (this.#persistencePath) await persistAfterWorkspaceFileAccess(this, () => this.#persist());
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

  writerRevision(sessionId: string, path: string): string | undefined {
    return this.#observations.get(sessionId)?.get(normalizeIdentity(path))?.sha256;
  }

  forgetWriterRevision(sessionId: string, path: string) {
    this.#observations.get(sessionId)?.delete(normalizeIdentity(path));
  }

  acquireMutation(path: string, sessionId?: string): () => void {
    return runtimeExclusiveResources.acquire(sessionId ?? 'workspace edit', dirname(path), [path], 'workspace_resource_busy',
      { guardUnscoped: true, sessionId });
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

  #persist(): Promise<void> {
    const next = this.#persisting.then(() => this.#write());
    // One failed publication must not poison subsequent writes.
    this.#persisting = next.catch(() => {});
    return next;
  }

  async #write(): Promise<void> {
    const value = Object.fromEntries([...this.#projectObservations].map(([root, entries]) => [
      root,
      Object.fromEntries(entries),
    ]));
    const path = this.#persistencePath!;
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.tmp-${randomUUID()}`;
    try {
      await writeState(temporary, JSON.stringify(value), { encoding: 'utf8', flag: 'wx', mode: 0o600, flush: true });
      for (let attempt = 0; ; attempt++) {
        try { await rename(temporary, path); break; }
        catch (error) {
          // Another concurrent file scope can still pin this directory. Retry
          // only state publication, never the tool or its external effects.
          if (attempt >= 50 || !['EBUSY', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
          await delay(100);
        }
      }
    } finally { await rm(temporary, { force: true }); }
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
    commandSandbox?: CommandSandboxConfiguration; loadCommandSandbox?: () => Promise<CommandSandboxConfiguration>;
    activeWorkspaces?: (excludingSessionId: string) => string[] } = {},
): WorkspaceObservationStore {
  const createChangeId = options.createChangeId ?? (() => `change_${randomUUID()}`);
  const terminals = options.terminals ?? new TerminalSessionManager();
  const searches = new Map<string, Promise<Awaited<ReturnType<typeof searchWorkspaceContent>>>>();
  const commandSandbox = snapshotCommandSandbox(options.commandSandbox);
  const admittedCommands = new WeakMap<TerminalInput, { plan: Awaited<ReturnType<typeof commandSandboxPlan>>; scoped: boolean }>();
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
  const workspaceState = async (context: ToolAdmissionContext<unknown>) => {
    const root = workspaceRoot(context);
    if (!root || root.startsWith('ssh:')) return;
    const canonical = await realpath(root).catch(() => undefined);
    if (!canonical) return;
    const activePeers = () => options.activeWorkspaces?.(context.sessionId) ?? [];
    const peers = new Map(await Promise.all(activePeers().map(async path => [path, await realpath(path).catch(() => undefined)] as const)));
    // A newly admitted peer may have arrived while physical paths were being resolved.
    const shared = activePeers().some(path => {
      if (!peers.has(path)) return true;
      const peer = peers.get(path);
      return !!peer && (isWithin(peer, canonical) || isWithin(canonical, peer));
    });
    return { root: canonical, shared };
  };
  const acquireWrites = (context: ToolAdmissionContext<unknown>, paths: string[]) => {
    return runtimeExclusiveResources.acquire(context.sessionId, dirname(paths[0]!), [], 'workspace_resource_busy',
      { paths, guardUnscoped: true, sessionId: context.sessionId });
  };
  const terminalPlan = async (context: ToolAdmissionContext<TerminalInput>, cwd: string, retainScope = false) => {
    const configuration = await sandboxFor(context.input), workspace = await workspaceState(context);
    if (!retainScope && !workspace?.shared && context.input.writePaths === undefined) {
      return { plan: await commandSandboxPlan(configuration, context, cwd), workspace, files: undefined };
    }
    if (!workspace || !isWithin(workspace.root, cwd)) {
      throw withToolFailureFacts(codedError('terminal_workspace_write_scope_required',
        'Scoped terminal execution requires a local workspace and cwd inside it. No command was started.'), { dispatch: 'not_started', effects: 'none', result: 'known' });
    }
    if (process.platform !== 'win32' && process.platform !== 'linux') {
      throw withToolFailureFacts(codedError('terminal_workspace_isolation_unavailable',
        'This host cannot isolate terminal writes in a shared workspace. Use the built-in file tools or a separate working copy. No command was started.'), { dispatch: 'not_started', effects: 'none', result: 'known' });
    }
    const files = await Promise.all((context.input.writePaths ?? []).map(async file => {
      const path = await resolveToolPath(context, resolve(cwd, file.path), true);
      if (!isWithin(workspace.root, path) || normalizeIdentity(workspace.root) === normalizeIdentity(path)) {
        throw withToolFailureFacts(codedError('terminal_workspace_write_scope_required',
          'Every write_paths entry must be a file inside the selected local workspace. No command was started.'), { dispatch: 'not_started', effects: 'none', result: 'known' });
      }
      return { ...file, path };
    }));
    if (new Set(files.map(file => normalizeIdentity(file.path))).size !== files.length) throw Error('Each terminal write path must be unique.');
    const plan = await commandSandboxPlan(configuration, context, cwd, { root: workspace.root, files: files.map(file => file.path) });
    return { plan, workspace, files };
  };
  function registerIfMissing<T>(targetRegistry: ToolRegistry, registration: ToolRegistration<T>) {
    if (targetRegistry.resolve(registration.definition.name)) return;
    if (['read_file', 'search_file_content'].includes(registration.definition.name)) {
      const authorize = registration.authorize!;
      registration = { ...registration, authorize: async context => {
        const decision = await authorize(context);
        return decision.kind === 'ask' && await isSkillReadResource(targetRegistry, context, (context.input as PathInput).path)
          ? { kind: 'allow' as const } : decision;
      } };
    }
    const guarded = ['read_file', 'write_file', 'edit_file', 'search_file_content'].includes(registration.definition.name)
      ? bindWorkspaceFileAuthorization(registration, commandSandbox.linuxExecutable) : registration;
    const routed = routeWorkspaceTool(guarded, terminals, options.remote, commandSandbox.mode === 'required');
    if (['read_file', 'write_file', 'edit_file'].includes(registration.definition.name)) {
      routed.parallelSafe = true;
      routed.resources = context => workspaceFileResources(context, registration.manifest.mutating);
    }
    if (['terminal_poll', 'terminal_write'].includes(registration.definition.name)) {
      routed.parallelSafe = true;
      routed.resources = context => [{ key: `terminal-output:${context.sessionId}:${(context.input as TerminalSessionInput).sessionId}`, mode: 'write' }];
    }
    if (registration.definition.name === 'terminal_exec' && options.onTerminalStarted) {
      const execute = routed.execute;
      routed.execute = async context => {
        const result = await execute(context) as Record<string, unknown>;
        if (result.state === 'running' && (context.input as TerminalInput).notifyOnExit && context.turn) {
          const taskId = options.onTerminalStarted!(context, result);
          return { ...result, task_id: result.terminalSessionId, completion_notification: Boolean(taskId), ...(taskId ? { completion_task_id: taskId } : {}) };
        }
        return result;
      };
    }
    targetRegistry.register(routed);
  }

  if (!registry.resolve('apply_patch')) registry.register<{ files: FilePatch[] }>(bindWorkspaceFileAuthorization({
    definition: { name: 'apply_patch', description: 'Apply related UTF-8 file changes as one preflighted local-workspace batch. Use *** Begin Patch, *** Add/Update/Delete File: path, optional *** Move to: path, @@ hunks with space/context, -/removed and +/added lines, then *** End Patch. Existing files must first be read at their current revision; contexts must match uniquely. Every path is authorized and every change keeps review/undo evidence. Validation failure writes nothing; I/O failure attempts rollback and reports any surviving changes. SSH workspaces use their existing read_file/write_file/edit_file tools.', inputSchema: objectSchema({ patch: { type: 'string', minLength: 1, maxLength: 2097152 } }, ['patch']) },
    manifest: manifest('filesystem.patch', 'filesystem_change', true), parallelSafe: true,
    decodeInput: value => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'patch') || typeof (value as { patch?: unknown }).patch !== 'string') throw new Error('Provide a patch string.');
      return { files: parseWorkspacePatch((value as { patch: string }).patch) };
    },
    authorize: async context => {
      if ([context.turn?.request.metadata.workspaceDir, context.turn?.request.metadata.projectDir, context.turn?.request.metadata.sessionWorkspaceDir].some(root => typeof root === 'string' && root.startsWith('ssh:'))) throw new Error('Multi-file patch currently requires a local workspace; use the SSH file tools.');
      const requests = [];
      for (const file of context.input.files) for (const path of [file.path, ...(file.moveTo ? [file.moveTo] : [])]) {
        const admission = await authorizePath('write')({ ...context, input: { path } });
        if (admission.kind === 'ask') requests.push(admission.request);
      }
      return requests.length ? { kind: 'ask' as const, request: { reason: 'Apply the related file changes.', actions: ['write'],
        targets: requests.flatMap(request => request.targets), capabilityIds: requests.flatMap(request => request.capabilityIds),
        requiresHuman: requests.some(request => request.requiresHuman),
        outsideParentScope: requests.some(request => request.outsideParentScope) } } : { kind: 'allow' as const };
    },
    resources: async context => Promise.all(context.input.files.flatMap(file => [file.path, ...(file.moveTo ? [file.moveTo] : [])]).map(async path =>
      ({ key: `file:${normalizeIdentity(await resolveToolPath(context, path, true))}`, mode: 'write' as const }))),
    execute: async context => {
      const changes: Array<{ path: string; before?: Buffer; after?: Buffer; versioned: boolean }> = [], applied: typeof changes = [];
      let release: (() => void) | undefined;
      const identities = new Set<string>();
      const stage = async (path: string, before: Buffer | undefined, after: Buffer | undefined) => {
        const identity = normalizeIdentity(path);
        if (identities.has(identity)) throw new Error('Each path may appear only once in a patch, including move targets.');
        identities.add(identity);
        assertObservedIfExisting(context, observations, path, before);
        changes.push({ path, before, after, versioned: await options.ownsFileVersion?.(context.sessionId, path) ?? false });
        if (changes.reduce((size, change) => size + (change.before?.length ?? 0) + (change.after?.length ?? 0), 0) > 32 * 1024 * 1024) throw new Error('Patch staging exceeds 32 MiB. Split this into smaller related batches.');
      };
      const same = (a?: Buffer, b?: Buffer) => a === undefined ? b === undefined : b !== undefined && a.equals(b);
      const write = async (path: string, bytes?: Buffer, create = false) => {
        if (bytes === undefined) await unlink(path);
        else { await createWorkspaceParent(path); await writeFile(path, bytes, create ? { flag: 'wx' } : undefined); }
      };
      const receipt = async (change: typeof changes[number], recordRevision: boolean) => {
        if (recordRevision) {
          if (change.after) await observations.record(context.sessionId, change.path, digest(change.after), workspaceRoot(context));
          else observations.forgetWriterRevision(context.sessionId, change.path);
        }
        return changeResult(context, change.path, change.before, change.after, !change.after ? 'deleted' : change.before ? 'modified' : 'added', 'utf8', createChangeId(), change.versioned);
      };
      try {
        const entries = await Promise.all(context.input.files.map(async file => ({ file,
          path: await resolveToolPath(context, file.path, true),
          target: file.moveTo ? await resolveToolPath(context, file.moveTo, true) : undefined })));
        release = acquireWrites(context, entries.flatMap(({ path, target }) => target ? [path, target] : [path]));
        // Validate all content, paths and revisions before the first filesystem mutation.
        for (const { file, path, target } of entries) {
          context.signal?.throwIfAborted();
          const before = await optionalBytes(path);
          if (file.kind === 'add' ? before !== undefined : before === undefined) throw new Error(`Patch ${file.kind} target ${file.path} has an unexpected existence state.`);
          if (before?.includes(0)) throw new Error('apply_patch requires UTF-8 text without NUL bytes. Use an encoding-aware file tool for this file.');
          const content = before ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(before) : '';
          const after = file.kind === 'delete' ? undefined : Buffer.from(applyFilePatch(file, content), 'utf8');
          if (after) assertInProcessFileSize(after.length);
          if (target) {
            if (await optionalBytes(target)) throw new Error('Move target already exists.');
            await stage(path, before, undefined); await stage(target, undefined, after);
          } else await stage(path, before, after);
        }
        for (const change of changes) {
          context.signal?.throwIfAborted();
          if (!same(await optionalBytes(change.path), change.before))
            throw Object.assign(Error(`File changed during patch preflight: ${change.path}`), { code: 'workspace_revision_conflict', details: { path: change.path } });
          // Include the in-progress write in recovery if its commit receipt is lost.
          applied.push(change); await write(change.path, change.after, change.before === undefined);
        }
        return { applied: true, files: await Promise.all(changes.map(change => receipt(change, true))) };
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'workspace_resource_busy')
          throw withToolFailureFacts(error, { dispatch: 'not_started', effects: 'none', result: 'known' });
        const remaining: string[] = [];
        for (const change of applied.reverse()) {
          try {
            const current = await optionalBytes(change.path);
            if (same(current, change.before)) continue;
            if (!same(current, change.after)) { remaining.push(change.path); continue; }
            await write(change.path, change.before, current === undefined);
          } catch { remaining.push(change.path); }
        }
        // Keep evidence for any partial write or externally changed path; never overwrite it blindly.
        for (const path of remaining) { const change = changes.find(item => item.path === path)!; await receipt({ ...change, after: await optionalBytes(path) }, false); }
        const conflict = error instanceof Error && 'code' in error &&
          ['workspace_revision_conflict', 'workspace_revision_not_observed'].includes(String(error.code)) ? String(error.code) : undefined;
        const failure = Object.assign(new Error(`${error instanceof Error ? error.message : String(error)}${remaining.length ? ' Some paths could not be rolled back; inspect recorded changes before retrying.' : applied.length ? ' All applied changes were rolled back.' : ' No files were changed.'}`), { code: remaining.length ? 'patch_partial_failure' : conflict ?? 'patch_not_applied', details: { remaining_paths: remaining, rolled_back: applied.length > 0 && !remaining.length } });
        // Only preflight proves no mutation was attempted. A rollback may leave
        // directories or other effects, so retain conservative facts after writes.
        throw applied.length ? failure : withToolFailureFacts(failure, { effects: 'none', result: 'known' });
      } finally { release?.(); }
    },
  }, commandSandbox.linuxExecutable));

  if (!registry.resolve('get_user_directories')) registry.register({
    definition: { name: 'get_user_directories', description: 'Resolve the current Runtime host account home, desktop and documents paths using OS metadata, including redirected Windows folders. Use before moving a file to the user desktop; sandbox HOME/USERPROFILE identifies a private task profile. This local metadata lookup grants no file access. Unavailable paths are reported explicitly.', inputSchema: objectSchema({}, []) },
    manifest: manifest('filesystem.read', 'observation', false),
    parallelSafe: true,
    decodeInput: () => ({}),
    authorize: () => ({ kind: 'allow' }),
    execute: context => userDirectories(context.signal),
  });

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
    projectModelResult: projectFileSourceResult,
    authorize: authorizePath("read"),
    execute: async (context: ToolHandlerContext<ReadFileInput>) => {
      const path = await resolveToolPath(context, context.input.path);
      try {
        if (context.input.range) {
          const result = await readFileLineRange(path, context.input.encoding, context.input.range, context.signal);
          await observations.record(context.sessionId, path, result.sha256, workspaceRoot(context));
          return { path, ...result };
        }
        const bytes = await readFileBounded(path, context.signal);
        const sha256 = digest(bytes);
        await observations.record(context.sessionId, path, sha256, workspaceRoot(context));
        return { path, sha256, content: bytes.toString(context.input.encoding) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') observations.forgetWriterRevision(context.sessionId, path);
        throw error;
      }
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
      const release = acquireWrites(context, [path]);
      try {
        assertInProcessFileSize(Buffer.byteLength(context.input.content, context.input.encoding));
        const before = await optionalBytes(path);
        assertObservedIfExisting(context, observations, path, before);
        const versioned = await options.ownsFileVersion?.(context.sessionId, path) ?? false;
        await createWorkspaceParent(path);
        const after = Buffer.from(context.input.content, context.input.encoding);
        await writeFile(path, after);
        const afterHash = digest(after);
        await observations.record(context.sessionId, path, afterHash, workspaceRoot(context));
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
      const release = acquireWrites(context, [path]);
      try {
        const before = await readFileBounded(path, context.signal);
        assertObservedIfExisting(context, observations, path, before);
        const versioned = await options.ownsFileVersion?.(context.sessionId, path) ?? false;
        const source = before.toString(context.input.encoding);
        let oldText = context.input.oldText, rangeOffsets: { start: number; end: number } | undefined;
        if (context.input.range) {
          const range = context.input.range;
          if (digest(before) !== range.sha256) throw workspaceWriteFailure(
            workspaceEditRecoveryError('workspace_revision_mismatch', 'expected_sha256 differs from the current file.'), 'validation_rejected', path);
          const lines = source.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
          if (range.end > lines.length) throw workspaceWriteFailure(
            workspaceEditRecoveryError('edit_line_range_invalid', `File has ${lines.length} lines; the range is outside it.`), 'validation_rejected', path);
          const start = lines.slice(0, range.start - 1).join('').length;
          const end = start + lines.slice(range.start - 1, range.end).join('').length;
          rangeOffsets = { start, end };
          oldText = source.slice(start, end);
        }
        const count = rangeOffsets ? 1 : occurrences(source, oldText);
        if (count === 0) {
          throw workspaceWriteFailure(workspaceEditRecoveryError(
            "edit_old_text_not_found",
            "old_text was not found in the current file revision.",
          ), 'validation_rejected', path);
        }
        if (!context.input.replaceAll && count !== 1) {
          throw workspaceWriteFailure(workspaceEditRecoveryError(
            "edit_old_text_ambiguous",
            `old_text matched ${count} times; the target is ambiguous.`,
          ), 'validation_rejected', path);
        }
        const replacements = context.input.replaceAll ? count : 1;
        assertInProcessFileSize(before.length + replacements * (
          Buffer.byteLength(context.input.newText, context.input.encoding) - Buffer.byteLength(oldText, context.input.encoding)
        ));
        const next = rangeOffsets ? source.slice(0, rangeOffsets.start) + context.input.newText + source.slice(rangeOffsets.end)
          : context.input.replaceAll ? source.replaceAll(oldText, () => context.input.newText)
          : source.replace(oldText, () => context.input.newText);
        assertInProcessFileSize(Buffer.byteLength(next, context.input.encoding));
        const after = Buffer.from(next, context.input.encoding);
        await writeFile(path, after);
        const afterHash = digest(after);
        await observations.record(context.sessionId, path, afterHash, workspaceRoot(context));
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

  const localShells = commandShells(process.platform);
  const terminalShells = options.remote ? [...new Set([...localShells, ...sshShellOptions])] : localShells;
  registerIfMissing(registry, {
    definition: {
      name: "terminal_exec",
      description: terminalToolDescription() + (options.remote ? ' SSH detects the remote OS: omit shell for its default, or use powershell/cmd on Windows and posix on Linux. Windows remote paths accept C:\\Users\\name or /C:/Users/name. All commands use the conversation\'s selected host.' : ''),
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
        write_paths: {
          type: 'array', maxItems: 16, description: 'Exact existing files this command may modify in a local workspace. Read each file first and supply its SHA-256. In a shared workspace, omitting this field makes the project read-only to this terminal. Use an independent working copy for build, format or other commands with unknown output paths.',
          items: objectSchema({ path: { type: 'string', minLength: 1 }, expected_sha256: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' } }, ['path', 'expected_sha256']),
        },
        yield_time_ms: {
          type: "integer",
          minimum: 1,
          maximum: MAX_TERMINAL_YIELD_MS,
          description: `Required maximum wait for this call, not a command timeout. A still-running command returns a terminal session handle and continues running. Maximum ${MAX_TERMINAL_YIELD_MS} ms.`,
        },
        shell: {
          type: "string",
          enum: localShells,
          description: "Choose the interpreter matching the command and environment. powershell is PowerShell 7 (pwsh), powershell5 is Windows PowerShell 5.1 on the local host, cmd is Command Prompt, and posix uses /bin/sh. When omitted, uses the selected environment's default.",
        },
        notify_on_exit: { type: 'boolean', default: true, description: 'After yielding a running command, Runtime delivers one completion notification during this turn and waits before ending it. Do other independent work; do not repeatedly poll. Set false for persistent servers or interactive processes that should outlive the task. Notifications stop when the turn is stopped; the command is not restarted.' },
        additional_permissions: {
          type: 'object', additionalProperties: false,
          description: 'Request extra sandbox access for this command and its descendants only. Requires approval; does not disable isolation. Check partial results before retrying a denied operation; never repeat completed side effects. Direct SSH does not support sandbox extensions.',
          properties: {
            read_roots: { type: 'array', maxItems: 32, items: { type: 'string' }, description: 'Existing absolute directories to read.' },
            write_roots: { type: 'array', maxItems: 32, items: { type: 'string' }, description: 'Existing absolute directories to read and write.' },
            read_files: { type: 'array', maxItems: 32, items: { type: 'string' }, description: 'Existing absolute files to read, without access to siblings.' },
            write_files: { type: 'array', maxItems: 32, items: { type: 'string' }, description: 'Existing absolute files to read and update, without parent-directory create/delete rights.' },
            network: { type: 'boolean', description: 'Request network access; currently all destinations, not a domain allowlist.' },
          },
        },
        justification: { type: 'string', description: 'Why the additional access is needed.' },
      }, ["command", "cwd", "yield_time_ms", "shell"]),
    },
    manifest: manifest("terminal.execute", "process_execution", true),
    executionChannel: localCommandExecutionChannel,
    decodeInput: input => decodeTerminal(input, terminalShells),
    renderModelResult: renderTerminalResult,
    projectModelResult: projectTerminalResult,
    authorize: async (context: ToolAdmissionContext<TerminalInput>) => {
      registry.assertLocalCommandAllowed(context);
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
      const { plan, files } = await terminalPlan(context, cwd);
      admittedCommands.set(context.input, { plan, scoped: files !== undefined });
      return plan.admission;
    },
    execute: async (context: ToolHandlerContext<TerminalInput>) => {
      const cwd = await resolveToolPath(context, terminalWorkingDirectory(context), true);
      const admitted = admittedCommands.get(context.input);
      const { plan, workspace, files } = await terminalPlan(context, cwd, admitted?.scoped);
      if (admitted?.scoped === false && files || !files && (await workspaceState(context))?.shared) throw withToolFailureFacts(
        codedError('terminal_workspace_scope_changed', 'The workspace became shared during admission. Retry as a read-only command or declare write_paths.'),
        { dispatch: 'not_started', effects: 'none', result: 'known' });
      if (JSON.stringify(admitted?.plan.policy) !== JSON.stringify(plan.policy)) {
        throw Object.assign(Error('An authorized command directory or file changed before execution. No command was started.'), { code: 'sandbox_approval_changed' });
      }
      registry.assertLocalCommandAllowed(context);
      return terminals.start({
        ownerSessionId: context.sessionId,
        command: context.input.command,
        cwd,
        yieldTimeMs: context.input.yieldTimeMs,
        foregroundOnly: context.turn?.request.metadata.eventCollector === true,
        signal: context.signal,
        shell: context.input.shell,
        sandbox: authorizedCommandSandbox(plan, context.capabilityIds),
        exclusiveResources: context.input.exclusiveResources,
        ...(!files && workspace ? { unscopedWorkspace: workspace.root } : {}),
        ...(files ? { workspaceWrites: { paths: files.map(file => file.path), validate: async () => {
          for (const file of files) {
            const current = await optionalBytes(file.path);
            assertObservedIfExisting(context, observations, file.path, current);
            if (!current || digest(current) !== file.expectedSha256) throw workspaceWriteFailure(
              Object.assign(Error('A terminal write path changed before launch. Read its current revision.'), {
                code: 'workspace_revision_conflict', details: { path: file.path, expectedSha256: file.expectedSha256, currentSha256: current ? digest(current) : null },
              }), 'validation_rejected', file.path);
          }
        } } } : {}),
      });
    },
  });

  registerIfMissing(registry, {
    definition: {
      name: "terminal_poll",
      description: [
        "Read only new output from terminalSessionId (pass as session_id); yield_time_ms bounds the wait. Empty output is not completion. Continue independent work while state=running; never restart it. Use await for completion-only waits when available.",
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
    projectModelResult: projectTerminalResult,
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
    executionChannel: localCommandExecutionChannel,
    decodeInput: decodeTerminalWrite,
    renderModelResult: renderTerminalResult,
    projectModelResult: projectTerminalResult,
    authorize: (context: ToolAdmissionContext<TerminalWriteInput>) => {
      registry.assertLocalCommandAllowed(context);
      const terminal = terminals.describe(context.sessionId, context.input.sessionId);
      return terminal.sandbox ? { kind: 'allow' as const }
        : terminalInputPermission({ ...context.input, environment: 'local',
          outsideParentScope: usesAssistantWorkspaceApproval(context) && context.parentWorkspaceAuthority?.permissionMode !== 'all_free' });
    },
    execute: (context: ToolHandlerContext<TerminalWriteInput>) => {
      registry.assertLocalCommandAllowed(context);
      return terminals.write(context.sessionId, context.input, context.signal);
    },
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
    projectModelResult: projectTerminalResult,
    authorize: (context: ToolAdmissionContext<TerminalSessionInput>) => {
      const terminal = terminals.describe(context.sessionId, context.input.sessionId);
      if (terminal.state !== 'running') return { kind: 'allow' as const };
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
    projectModelDefinition: (definition, scope) => scope.canRecall ? null : definition,
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

function assertObservedIfExisting(
  context: ToolHandlerContext<unknown>,
  observations: WorkspaceObservationStore,
  path: string,
  bytes: Buffer | undefined,
): void {
  const expected = observations.writerRevision(context.sessionId, path);
  const current = bytes && digest(bytes);
  if (expected !== undefined && expected !== current) {
    const message = 'The file changed since this Agent last observed it. Read the current file and review the change before writing.';
    throw workspaceWriteFailure(Object.assign(Error(message), {
      code: 'workspace_revision_conflict', details: { path, expectedSha256: expected, currentSha256: current ?? null },
    }), 'validation_rejected', path);
  }
  if (current !== undefined && expected === undefined) {
    if (context.toolCall?.name === 'edit_file') {
      throw workspaceWriteFailure(workspaceEditRecoveryError(
        'workspace_revision_not_observed', 'The current file revision has not been read or has changed since it was read.'),
      'validation_rejected', path);
    }
    throw workspaceWriteFailure(codedError(
      "workspace_revision_not_observed",
      `Current file revision ${current} has not been read by this Agent; use read_file first.`,
    ), 'validation_rejected', path);
  }
}

function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function changeResult(
  context: ToolHandlerContext<unknown>,
  path: string,
  before: Buffer | undefined,
  after: Buffer | undefined,
  status: "added" | "modified" | "deleted",
  encoding: BufferEncoding,
  changeId: string,
  versioned: boolean,
): Record<string, unknown> {
  const beforeText = before?.toString(encoding) ?? "";
  const afterText = after?.toString(encoding) ?? '';
  const diff = createDisplayDiff(beforeText, afterText);
  const change = {
      change_id: changeId,
      path,
      status,
      additions: diff.additions,
      deletions: diff.deletions,
      ...(before ? { before_hash: digest(before) } : {}),
      ...(after ? { after_hash: digest(after) } : {}),
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
    ...(change.after_hash ? { sha256: change.after_hash } : {}),
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

function decodeTerminal(input: unknown, shells: readonly TerminalShell[]): TerminalInput {
  const object = objectInput(input);
  const yieldTime = object.yield_time_ms;
  if (!Number.isInteger(yieldTime) || Number(yieldTime) < 1) {
    throw new Error("yield_time_ms is required and must be a positive integer.");
  }
  if (Number(yieldTime) > MAX_TERMINAL_YIELD_MS) {
    throw new Error(`yield_time_ms must not exceed ${MAX_TERMINAL_YIELD_MS}.`);
  }
  const shell = object.shell === undefined ? defaultCommandShell() : String(object.shell);
  if (!shells.includes(shell as TerminalShell)) {
    throw new Error(
      `shell must be one of: ${shells.join(", ")}.`,
    );
  }
  const paths = object.write_paths;
  if (paths !== undefined && (!Array.isArray(paths) || paths.length > 16)) throw Error('write_paths must be an array of at most 16 files.');
  return {
    command: requiredString(object.command, "command", false),
    exclusiveResources: decodeExclusiveResources(object.exclusive_resources),
    notifyOnExit: booleanValue(object.notify_on_exit, true),
    cwd: typeof object.cwd === "string" ? object.cwd.trim() : "",
    yieldTimeMs: Number(yieldTime),
    shell: shell as TerminalShell,
    ...(paths === undefined ? {} : { writePaths: (paths as unknown[]).map(item => {
      const file = objectInput(item), path = requiredString(file.path, 'write_paths.path');
      if (typeof file.expected_sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(file.expected_sha256) ||
          Object.keys(file).some(key => !['path', 'expected_sha256'].includes(key))) throw Error('Each write_paths entry requires path and expected_sha256 from read_file.');
      return { path, expectedSha256: file.expected_sha256.toLowerCase() };
    }) }),
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


function terminalToolDescription(): string {
  return [
    "Run one command in cwd.",
    "Sandbox PATH, HOME and file visibility can differ from the host. Command-not-found, false Test-Path or a venv 'No Python' error does not prove an uninstalled or broken host toolchain. Inspect environmentDiagnostic and sandbox scope; request narrow additional_permissions for required interpreter/tool directories. A host lookup is metadata only and grants no execution access. Do not switch launchers or install replacements to evade isolation.",
    `Required yield_time_ms <= ${MAX_TERMINAL_YIELD_MS} bounds waiting, not execution; use 1000 for long tasks and continue independent work. completion_notification=true delivers completion automatically. Use await with completion_task_id when blocked and available; terminal_poll reads new output by terminalSessionId. Never restart a running command. Prefer search_file_content for content search.`,
    "Sessions survive turns until terminal_stop, exit or a resource limit. Windows task trees share memory/CPU budgets; detached children end with the session. Reduce workload after resource-limit failures; do not bypass limits or repeat unchanged commands.",
    "Never launch user browsers through the terminal: process cleanup can close them. Use open_external_url to keep a page open, Browser Use for control, or return a link if unavailable.",
    "Use the latest runtime_environment terminal.availableShells to choose the matching interpreter. recommendedShell is a preference; choose explicitly when syntax or a dependency requires it. Discovery describes host executables; the command still needs its own authorization and sandbox access. Runtime never rewrites commands.",
  ].join(" ");
}
