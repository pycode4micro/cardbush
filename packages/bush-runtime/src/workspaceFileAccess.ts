import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdir, open, realpath, stat, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { ToolAdmissionContext, ToolAdmissionDecision, ToolRegistration } from './toolRegistry.js';
import { isWithin, normalizeIdentity, resolveToolPath } from './workspaceAccessPolicy.js';
import { WorkspacePathGuard, pathChanged } from './workspacePathGuard.js';
import { withToolFailureFacts } from './toolFailureFacts.js';
import { SandboxFileHandle, verifyWorkspaceFileSandbox } from './workspaceSandboxFile.js';
import type { ExecutionSandboxStatus } from './executionSandbox.js';
import { deleteSandboxFile } from './workspaceFileDelete.js';

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
  if (info?.isSymbolicLink() || info && !info.isFile() && !info.isDirectory()) throw pathChanged();
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
      try {
        try {
          for (const target of admission.targets) {
            context.signal?.throwIfAborted();
            await access.guard.pin(target.ancestor);
            if (identity(await stat(access.guard.directory(target.ancestor), { bigint: true })) !== target.ancestorIdentity ||
                !samePath(await resolveToolPath(context, target.candidate, writing), target.path)) throw pathChanged();
            const info = target.directory ? await stat(access.guard.directory(target.path), { bigint: true })
              : await inspect(target.ancestor === dirname(target.path) ? access.guard.file(target.path) : target.path);
            if ((info && identity(info)) !== target.identity || info?.isSymbolicLink()) throw pathChanged();
          }
        } catch (error) {
          const unavailable = (error as NodeJS.ErrnoException).code === 'workspace_path_guard_unavailable';
          const failure = context.signal?.aborted ? context.signal.reason : unavailable ? error as Error : pathChanged();
          throw withToolFailureFacts(failure, { dispatch: 'not_started', effects: 'none', result: 'known', recovery: 'correct_input' });
        }
        try { await verifyWorkspaceFileSandbox(linuxExecutable); }
        catch (error) { throw withToolFailureFacts(error as Error, { dispatch: 'not_started', effects: 'none', result: 'known', recovery: 'correct_input' }); }
        const result = await active.run(access, () => registration.execute({ ...context, input: boundInput(context.input, admission.targets) }));
        // Specialized tools keep their durable memo/artifact schemas unchanged.
        return !binding && access.sandboxStatus && result && typeof result === 'object' ? { ...result, sandbox: access.sandboxStatus } : result;
      } finally { await access.guard.close(); }
    },
  };
}

/** Host-authorized operations (undo, saved references) use the same content
 * transport. Callers supply exact recorded paths, never a new permission root.
 * Existing tool scopes cannot be expanded by a nested helper. */
export async function withWorkspaceFileAccess<T>(paths: string[], writing: boolean, operation: () => Promise<T>,
  options: { signal?: AbortSignal; linuxExecutable?: string; rejectRedirects?: boolean } = {}): Promise<T> {
  const existing = active.getStore();
  if (existing) { for (const path of paths) existing.allowed(path, writing); return operation(); }
  const context = { input: {}, sessionId: 'host-file-operation' } as ToolAdmissionContext;
  const targets = await Promise.all([...new Set(paths)].map(async path => {
    const target = await capture(context, path, writing);
    if (options.rejectRedirects !== false && !samePath(target.path, resolve(path))) throw pathChanged();
    return target;
  }));
  const access = new WorkspaceFileAccess(targets, writing, options.signal, options.linuxExecutable);
  try {
    for (const target of targets) {
      await access.guard.pin(target.ancestor);
      if (identity(await stat(access.guard.directory(target.ancestor), { bigint: true })) !== target.ancestorIdentity) throw pathChanged();
    }
    await verifyWorkspaceFileSandbox(options.linuxExecutable);
    return await active.run(access, operation);
  } finally { await access.guard.close(); }
}

class WorkspaceFileAccess {
  readonly guard = new WorkspacePathGuard();
  sandboxStatus?: Pick<ExecutionSandboxStatus, 'backend' | 'network'>;
  readonly #versions = new Map<string, string | undefined>();
  readonly #hashes = new Map<string, string>();
  constructor(readonly targets: Target[], readonly writing: boolean, readonly signal?: AbortSignal, readonly linuxExecutable?: string) {
    for (const target of targets) this.#versions.set(normalizeIdentity(target.path), target.identity);
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
  async open(path: string, write = false, exclusive = false): Promise<SandboxFileHandle> {
    this.allowed(path, write);
    await this.parent(path, write);
    const fixed = this.guard.file(path);
    const before = await inspect(fixed);
    const key = normalizeIdentity(path);
    if (before?.isSymbolicLink() || this.#versions.has(key) && (before && identity(before)) !== this.#versions.get(key)) throw pathChanged();
    if (before?.isDirectory()) throw Object.assign(Error('Expected a file, but the path is a directory. Use search_file_content to search it.'), { code: 'EISDIR' });
    if (before && !before.isFile()) throw pathChanged();
    // Never turn a missing-file observation into a later read of a newly
    // introduced file/link. Writes below use exclusive creation instead.
    if (!before && !write) throw Object.assign(new Error('File does not exist.'), { code: 'ENOENT' });
    if (before && exclusive) throw Object.assign(Error('File already exists.'), { code: 'EEXIST' });
    let actual = before;
    // Namespace broker: reserve only this exact name, without opening sibling
    // access in the sandbox. It never reads, truncates or writes file content.
    let reserved = false;
    if (!actual) {
      const placeholder = await open(fixed, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
        | (process.platform === 'linux' ? constants.O_NOFOLLOW : 0), 0o600);
      try { actual = await placeholder.stat({ bigint: true }); reserved = true; }
      finally { await placeholder.close(); }
    }
    try {
      if (!actual.isFile() || write && actual.nlink !== 1n) throw pathChanged();
      // Linux descriptor-relative names can differ after an authorized directory
      // is renamed; resolve the still-pinned object for the sandbox mount.
      const handle = await SandboxFileHandle.open(await realpath(fixed), identity(actual), write, write && !reserved ? this.#hashes.get(key) : undefined, this.signal, this.linuxExecutable);
      if (handle.process.sandbox) this.sandboxStatus = { backend: handle.process.sandbox.backend, network: handle.process.sandbox.network };
      this.#versions.set(key, identity(actual));
      return handle;
    } catch (error) {
      const current = reserved ? await inspect(fixed) : undefined;
      if (current && identity(current) === identity(actual)) await unlink(fixed);
      throw error;
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
  const handle = await access.open(path, true, options?.flag === 'wx');
  try {
    // Never truncate an unchecked pathname. The validated handle remains the target.
    await handle.truncate(0);
    await handle.writeFile(data, { encoding: options?.encoding });
    if (options?.mode !== undefined) await handle.chmod(options.mode);
  } finally { await handle.close(); }
}
export async function unlinkWorkspaceFile(path: string) {
  const access = active.getStore(); if (!access) throw pathChanged(); await access.remove(path);
}
