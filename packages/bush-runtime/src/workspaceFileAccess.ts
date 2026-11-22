import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { constants, lstatSync, linkSync, renameSync, unlinkSync, type BigIntStats } from 'node:fs';
import { lstat, mkdir, open, realpath, stat, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { ToolAdmissionContext, ToolAdmissionDecision, ToolRegistration } from './toolRegistry.js';
import { isWithin, normalizeIdentity, resolveToolPath } from './workspaceAccessPolicy.js';
import { WorkspacePathGuard, pathChanged } from './workspacePathGuard.js';
import { withToolFailureFacts } from './toolFailureFacts.js';
import { SandboxFileHandle, verifyWorkspaceFileSandbox, type WorkspaceFileRevision } from './workspaceSandboxFile.js';
import type { ExecutionSandboxStatus } from './executionSandbox.js';
import { deleteSandboxFile } from './workspaceFileDelete.js';
import { workspaceWriteFailure } from './workspaceWriteFailure.js';

interface Target { candidate: string; path: string; ancestor: string; ancestorIdentity: string; identity?: string; directory: boolean }
interface Admission { targets: Target[]; decision: ToolAdmissionDecision }
const active = new AsyncLocalStorage<WorkspaceFileAccess>();
const identity = (info: BigIntStats) => `${info.dev}:${info.ino}`;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const samePath = (a: string, b: string) => normalizeIdentity(a) === normalizeIdentity(b);

async function inspect(path: string) { try { return await lstat(path, { bigint: true }); } catch (error) { if (!missing(error)) throw error; } }
async function capture(context: ToolAdmissionContext, candidate: string, writing: boolean): Promise<Target> {
  const path = await resolveToolPath(context, candidate, writing);
  const info = await inspect(path);
  if (info?.isSymbolicLink() || info?.isFile() && info.nlink !== 1n || info && !info.isFile() && !info.isDirectory()) throw pathChanged();
  let ancestor = info?.isDirectory() ? path : dirname(path);
  let parent = await inspect(ancestor);
  while (!parent) { const next = dirname(ancestor); if (next === ancestor) throw pathChanged(); ancestor = next; parent = await inspect(ancestor); }
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw pathChanged();
  return { candidate, path, ancestor, ancestorIdentity: identity(parent), identity: info && identity(info), directory: info?.isDirectory() ?? false };
}

/** A decoded invocation retains the exact targets examined before approval/queuing. */
export interface WorkspaceFileBinding<T> {
  paths(input: T): string[];
  resolve(input: T, canonical: (path: string) => string): T;
}
export function bindWorkspaceFileAuthorization<T>(registration: ToolRegistration<T>, linuxExecutable = process.env.CARDBUSH_BWRAP_PATH?.trim(), binding?: WorkspaceFileBinding<T>): ToolRegistration<T> {
  const admissions = new WeakMap<object, Admission>();
  const writing = registration.manifest.mutating;
  const singleWrite = registration.definition.name === 'write_file' || registration.definition.name === 'edit_file';
  const candidates = (input: any): string[] => binding ? binding.paths(input) : input.files
    ? input.files.flatMap((file: any) => [file.path, ...(file.moveTo ? [file.moveTo] : [])]) : [input.path];
  const boundInput = (input: any, targets: Target[]) => {
    const path = (candidate: string) => targets.find(target => target.candidate === candidate)!.path;
    if (binding) return binding.resolve(input, path);
    return input.files ? { ...input, files: input.files.map((file: any) => ({ ...file, path: path(file.path), ...(file.moveTo ? { moveTo: path(file.moveTo) } : {}) })) }
      : { ...input, path: path(input.path) };
  };
  return { ...registration,
    authorize: async context => {
      const targets = await Promise.all(candidates(context.input).map(path => capture(context, path, writing)));
      const decision = await registration.authorize!({ ...context, input: boundInput(context.input, targets) });
      admissions.set(context.input as object, { targets, decision });
      return decision;
    },
    execute: async context => {
      const admission = admissions.get(context.input as object);
      if (!admission || admission.decision.kind === 'deny' || admission.decision.kind === 'ask' &&
          !admission.decision.request.capabilityIds.every(id => context.capabilityIds.includes(id))) throw pathChanged();
      if (!admission.targets.length) return registration.execute(context);
      const access = new WorkspaceFileAccess(admission.targets, writing, context.signal, linuxExecutable);
      const path = admission.targets[0]!.path;
      let failed = false;
      try {
        try {
          for (const target of admission.targets) {
            context.signal?.throwIfAborted();
            await access.guard.pin(target.ancestor);
            if (identity(await stat(access.guard.directory(target.ancestor), { bigint: true })) !== target.ancestorIdentity ||
                !samePath(await resolveToolPath(context, target.candidate, writing), target.path)) throw pathChanged();
            const info = target.directory ? await stat(access.guard.directory(target.path), { bigint: true })
              : await inspect(target.ancestor === dirname(target.path) ? access.guard.file(target.path) : target.path);
            if (info?.isSymbolicLink() || info?.isFile() && info.nlink !== 1n) throw pathChanged();
            if ((info && identity(info)) !== target.identity)
              throw writing && !target.directory && (!info || info.isFile()) ? revisionConflict(target.path) : pathChanged();
          }
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          const failure = context.signal?.aborted ? context.signal.reason : code === 'workspace_path_guard_unavailable' ||
            code === 'workspace_revision_conflict' ? error as Error : pathChanged();
          throw withToolFailureFacts(failure, { dispatch: 'not_started', effects: 'none', result: 'known', recovery: 'correct_input' });
        }
        try { await verifyWorkspaceFileSandbox(linuxExecutable); }
        catch (error) { throw withToolFailureFacts(error as Error, { dispatch: 'not_started', effects: 'none', result: 'known', recovery: 'correct_input' }); }
        const result = await active.run(access, () => registration.execute({ ...context, input: boundInput(context.input, admission.targets) }));
        // Specialized tools keep their durable memo/artifact schemas unchanged.
        return !binding && access.sandboxStatus && result && typeof result === 'object' ? { ...result, sandbox: access.sandboxStatus } : result;
      } catch (error) {
        failed = true;
        throw singleWrite ? workspaceWriteFailure(error, access.writeCommitted ? 'after_commit' : 'before_commit', path) : error;
      } finally {
        try { await access.close(); }
        catch (error) {
          if (!failed) throw singleWrite ? workspaceWriteFailure(error, access.writeCommitted ? 'after_commit' : 'before_commit', path) : error;
        }
      }
    },
  };
}

/** Host-authorized operations (undo, saved references) use the same content
 * transport. Callers supply exact recorded paths, never a new permission root.
 * Existing tool scopes cannot be expanded by a nested helper. */
export async function withWorkspaceFileAccess<T>(paths: string[], writing: boolean, operation: () => Promise<T>,
  options: { signal?: AbortSignal; linuxExecutable?: string; rejectRedirects?: boolean; expectedIdentities?: Readonly<Record<string, string>> } = {}): Promise<T> {
  const existing = active.getStore();
  if (existing) { for (const path of paths) existing.allowed(path, writing); return operation(); }
  const context = { input: {}, sessionId: 'host-file-operation' } as ToolAdmissionContext;
  const targets = await Promise.all([...new Set(paths)].map(async path => {
    const target = await capture(context, path, writing);
    if (options.rejectRedirects !== false && !samePath(target.path, resolve(path))) throw pathChanged();
    if (options.expectedIdentities?.[path] !== undefined && target.identity !== options.expectedIdentities[path]) throw pathChanged();
    return target;
  }));
  const linuxExecutable = options.linuxExecutable ?? process.env.CARDBUSH_BWRAP_PATH?.trim();
  const access = new WorkspaceFileAccess(targets, writing, options.signal, linuxExecutable);
  try {
    for (const target of targets) {
      await access.guard.pin(target.ancestor);
      if (identity(await stat(access.guard.directory(target.ancestor), { bigint: true })) !== target.ancestorIdentity) throw pathChanged();
    }
    await verifyWorkspaceFileSandbox(linuxExecutable);
    return await active.run(access, operation);
  } finally { await access.close(); }
}

/** Runtime-owned metadata only: finish workspace access before publishing state.
 * Windows directory pins intentionally prevent rename/link in the pinned parent.
 * This is not a content-access fallback or an extension of the authorized paths. */
export async function persistAfterWorkspaceFileAccess(owner: object, persist: () => Promise<void>): Promise<void> {
  const access = active.getStore();
  if (access) access.afterClose.set(owner, persist);
  else await persist();
}

class WorkspaceFileAccess {
  readonly guard = new WorkspacePathGuard();
  readonly afterClose = new Map<object, () => Promise<void>>();
  sandboxStatus?: Pick<ExecutionSandboxStatus, 'backend' | 'network'>;
  readonly #versions = new Map<string, string | undefined>();
  readonly #hashes = new Map<string, string>();
  constructor(readonly targets: Target[], readonly writing: boolean, readonly signal?: AbortSignal, readonly linuxExecutable?: string) {
    for (const target of targets) this.#versions.set(normalizeIdentity(target.path), target.identity);
  }
  async close() {
    await this.guard.close();
    for (const persist of this.afterClose.values()) await persist();
    this.afterClose.clear();
  }
  allowed(path: string, write = false) {
    if (write && !this.writing || !this.targets.some(target => samePath(path, target.path) || !write && target.directory && isWithin(target.path, path))) throw pathChanged();
    this.guard.check();
  }
  async parent(path: string, create = false): Promise<void> {
    this.allowed(path, create);
    const directory = dirname(path);
    const absent: string[] = [];
    let current = directory;
    while (!await inspect(current)) {
      if (!create || dirname(current) === current) throw Object.assign(new Error('Parent directory does not exist.'), { code: 'ENOENT' });
      absent.push(current); current = dirname(current);
    }
    await this.guard.pin(current);
    for (const child of absent.reverse()) {
      try { await mkdir(this.guard.file(child)); } catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'EEXIST') throw failure; }
      await this.guard.pin(child);
    }
  }
  recordRead(path: string, hash: string) { this.#hashes.set(normalizeIdentity(path), hash); }
  async open(path: string): Promise<SandboxFileHandle> {
    this.allowed(path);
    await this.parent(path);
    const fixed = this.guard.file(path);
    const before = await inspect(fixed);
    const key = normalizeIdentity(path);
    if (before?.isSymbolicLink() || this.#versions.has(key) && (before && identity(before)) !== this.#versions.get(key)) throw pathChanged();
    if (before?.isDirectory()) throw Object.assign(Error('Expected a file, but the path is a directory. Use search_file_content to search it.'), { code: 'EISDIR' });
    if (before && !before.isFile()) throw pathChanged();
    // Never turn a missing-file observation into a later read of a newly
    // introduced file/link. Writes below use exclusive creation instead.
    if (!before) throw Object.assign(new Error('File does not exist.'), { code: 'ENOENT' });
    if (before.nlink !== 1n) throw pathChanged();
    // Resolve the still-pinned object for an exact-file sandbox mount.
    const handle = await SandboxFileHandle.open(await realpath(fixed), identity(before), false, undefined, this.signal, this.linuxExecutable);
    if (handle.process.sandbox) this.sandboxStatus = { backend: handle.process.sandbox.backend, network: handle.process.sandbox.network };
    this.#versions.set(key, identity(before));
    return handle;
  }
  writeCommitted = false;
  async replace(path: string, data: string | Buffer, options?: { encoding?: BufferEncoding; flag?: string; mode?: number }) {
    this.allowed(path, true);
    await this.parent(path, true);
    const fixed = this.guard.file(path), key = normalizeIdentity(path);
    const initial = await inspect(fixed);
    const expected = this.#versions.get(key);
    if ((initial && identity(initial)) !== expected || initial && (!initial.isFile() || initial.nlink !== 1n)) throw revisionConflict(path);
    if (initial && options?.flag === 'wx') throw revisionConflict(path);
    const windows = process.platform === 'win32';
    const stage = join(dirname(path), `.cardbush-write-${randomUUID().replaceAll('-', '')}.tmp`);
    const fixedStage = this.guard.file(stage);
    let staged: BigIntStats | undefined;
    let committed = false, failed = false;
    try {
      this.signal?.throwIfAborted();
      if (windows) {
        await this.guard.windowsNamespace({ op: 'stage', stage }, this.signal);
        staged = await lstat(fixedStage, { bigint: true });
      } else {
        const reservation = await open(fixedStage, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { staged = await reservation.stat({ bigint: true }); }
        finally { await reservation.close(); }
      }
      if (!staged.isFile() || staged.nlink !== 1n) throw pathChanged();
      const handle = await SandboxFileHandle.open(await realpath(fixedStage), identity(staged), true, undefined, this.signal, this.linuxExecutable);
      try {
        if (handle.process.sandbox) this.sandboxStatus = { backend: handle.process.sandbox.backend, network: handle.process.sandbox.network };
        await handle.writeFile(data, { encoding: options?.encoding });
        if (!windows) await handle.chmod(options?.mode ?? (initial ? Number(initial.mode & 0o777n) : 0o600));
        await handle.sync();
      } finally { await handle.close(); }
      // Re-read the authorized target inside the sandbox at the commit boundary.
      // The bytes may have changed while a different file was being staged.
      let verified: WorkspaceFileRevision | undefined;
      if (initial) {
        const current = await inspect(fixed);
        if (!current || !current.isFile() || current.nlink !== 1n || identity(current) !== expected) throw revisionConflict(path);
        const target = await this.open(path);
        try { verified = await target.verifyRevision(this.#hashes.get(key)); }
        finally { await target.close(); }
      }
      this.signal?.throwIfAborted();
      if (windows) {
        await this.guard.windowsNamespace({ op: 'replace', stage, stageIdentity: identity(staged), target: path,
          identity: expected ?? null, mtimeNs: verified?.mtimeNs.toString() ?? null, size: verified?.size.toString() ?? null }, this.signal);
      } else {
        const current = inspectSync(fixed);
        if (verified && (!current || identity(current) !== expected || !current.isFile() || current.nlink !== 1n ||
            current.ctimeNs !== verified.ctimeNs || current.mtimeNs !== verified.mtimeNs || current.size !== verified.size)) throw revisionConflict(path);
        const source = lstatSync(fixedStage, { bigint: true });
        if (identity(source) !== identity(staged) || !source.isFile() || source.nlink !== 1n) throw pathChanged();
        if (verified) renameSync(fixedStage, fixed);
        else {
          // The exclusive publication must fail if the destination appeared.
          try { linkSync(fixedStage, fixed); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw revisionConflict(path); throw error; }
        }
      }
      this.writeCommitted = committed = true;
      if (!windows && !verified) unlinkSync(fixedStage);
      this.#versions.set(key, identity(staged));
      this.#hashes.delete(key);
    } catch (error) {
      failed = true;
      throw workspaceWriteFailure(error, (error as NodeJS.ErrnoException).code === 'workspace_revision_conflict'
        ? 'validation_rejected' : committed ? 'after_commit' : 'before_commit', path);
    } finally {
      if (staged) {
        try {
          const current = await inspect(fixedStage);
          if (current && identity(current) === identity(staged)) await unlink(fixedStage);
        } catch (error) {
          if (!failed) throw workspaceWriteFailure(error, committed ? 'after_commit' : 'before_commit', path);
        }
      }
    }
  }
  async remove(path: string) {
    this.allowed(path, true); await this.parent(path);
    const info = await inspect(this.guard.file(path));
    const key = normalizeIdentity(path);
    if (!info && this.#versions.get(key) === undefined) return;
    if (!info || info.isSymbolicLink() || !info.isFile() || identity(info) !== this.#versions.get(normalizeIdentity(path))) throw pathChanged();
    const hash = this.#hashes.get(key);
    if (!hash) throw Object.assign(Error('Read the current file revision before deleting it.'), { code: 'workspace_revision_conflict' });
    const status = await deleteSandboxFile(path, this.guard.file(path), identity(info), hash, this.signal, this.linuxExecutable);
    if (status) this.sandboxStatus = { backend: status.backend, network: status.network };
    this.#versions.set(key, undefined); this.#hashes.delete(key);
  }
}

export function workspaceAuthorizedIdentity(path: string) {
  return active.getStore()?.targets.find(target => samePath(target.path, path))?.identity;
}
export function workspaceLinuxSandboxExecutable() { return active.getStore()?.linuxExecutable ?? process.env.CARDBUSH_BWRAP_PATH?.trim(); }
export async function openWorkspaceFile(path: string): Promise<FileHandle | SandboxFileHandle> { return active.getStore()?.open(path) ?? open(path, 'r'); }
export function recordWorkspaceRead(path: string, bytesOrHash: Buffer | string) {
  active.getStore()?.recordRead(path, typeof bytesOrHash === 'string' ? bytesOrHash : createHash('sha256').update(bytesOrHash).digest('hex'));
}
export async function createWorkspaceParent(path: string) {
  const access = active.getStore();
  if (access) await access.parent(path, true); else await mkdir(dirname(path), { recursive: true });
}
export async function writeWorkspaceFile(path: string, data: string | Buffer, options?: { encoding?: BufferEncoding; flag?: string; mode?: number }) {
  const access = active.getStore();
  if (!access) throw pathChanged();
  await access.replace(path, data, options);
}
export async function unlinkWorkspaceFile(path: string) {
  const access = active.getStore(); if (!access) throw pathChanged(); await access.remove(path);
}

function revisionConflict(path: string) {
  return workspaceWriteFailure(Object.assign(Error('The destination changed before atomic replacement. Read the current file and retry.'), {
    code: 'workspace_revision_conflict', details: { path },
  }), 'validation_rejected', path);
}

function inspectSync(path: string) {
  try { return lstatSync(path, { bigint: true }); } catch (error) { if (!missing(error)) throw error; }
}
