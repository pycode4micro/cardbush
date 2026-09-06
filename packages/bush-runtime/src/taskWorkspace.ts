import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, lstat, mkdir, open, readFile, readlink, realpath, rename, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { WorkspaceChange, WorkspaceCheckpoint, WorkspaceDescriptor, WorkspaceReview } from "@cardbush/bush-protocol";
import { GitWorkspaceStore, decodeGitPaths, mapFiles, type GitFileEntry, type GitFileTree } from "./gitWorkspaceStore.js";

const exec = promisify(execFile);
type Entry = GitFileEntry;
type Snapshot = GitFileTree;
type Checkpoint = Omit<WorkspaceCheckpoint, "changes"> & { before: string; after?: string; paths?: string[] };
type Transaction = { root: string; before: string; after: string; paths: string[] };
type State = WorkspaceDescriptor & {
  protocol: "bush.task_workspace.v2";
  baselineId: string;
  latestId: string;
  appliedId: string;
  checkpoints: Checkpoint[];
  pending?: Transaction;
  disposal?: "discard" | "use_direct";
};

function hash(value: string | Buffer) { return createHash("sha256").update(value).digest("hex"); }
function problem(code: string, message: string): Error { return Object.assign(new Error(message), { code }); }
function inside(root: string, path: string) {
  const delta = relative(resolve(root), resolve(path));
  return delta === "" || (delta !== ".." && !delta.startsWith(`..${sep}`) && !isAbsolute(delta));
}
function sameLocation(a: string, b: string) {
  return process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
}
function equal(a?: Entry, b?: Entry) { return a?.hash === b?.hash && a?.kind === b?.kind && a?.mode === b?.mode; }
function changed(a: Snapshot, b: Snapshot) {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(path => !equal(a[path], b[path])).sort();
}

/** Owns Local/Worktree bindings and Git version references, independently of editing Tools. */
export class TaskWorkspaceManager {
  readonly #root: string;
  readonly #operations = new Map<string, Promise<void>>();
  readonly #active = new Map<string, string>();
  readonly #destinations = new Map<string, string>();
  readonly #stores = new Map<string, GitWorkspaceStore>();
  readonly #changeViews = new Map<string, WorkspaceChange[]>();
  readonly #treeIds = new WeakMap<Snapshot, string>();

  constructor(root: string) { this.#root = resolve(root); }

  async descriptor(sessionId: string): Promise<WorkspaceDescriptor | undefined> {
    return this.#exclusive(sessionId, async () => {
      const state = await this.#load(sessionId);
      if (state) await this.#recover(state);
      return state ? this.#descriptor(state) : undefined;
    }, true);
  }

  async create(sessionId: string, source: string, mode: "auto" | "direct" | "worktree"): Promise<WorkspaceDescriptor> {
    return this.#exclusive(sessionId, async () => {
      const prior = await this.#load(sessionId);
      if (prior) {
        if (await realpath(resolve(source)) !== prior.sourceDir) throw problem("workspace_identity_conflict", "This task already belongs to a different project.");
        await this.#recover(prior);
        return this.#descriptor(prior);
      }
      const sourceDir = await realpath(resolve(source));
      const direct = (): WorkspaceDescriptor => ({ mode: "direct", sessionId, sourceDir, workspaceDir: sourceDir, revision: 1, status: "ready", versioning: "none" });
      const local = async (git: boolean, versioningError?: string): Promise<WorkspaceDescriptor> => {
        const state: State = { ...direct(), protocol: "bush.task_workspace.v2", versioning: git ? "git" : "none",
          baselineId: "", latestId: "", appliedId: "", checkpoints: [], versioningError };
        if (git) {
          try {
            state.baselineId = await this.#saveSnapshot(state, await this.#capture(state, sourceDir, {}));
            state.latestId = state.appliedId = state.baselineId;
          } catch (error) {
            state.versioning = "none";
            state.versioningError = (error as Error).message;
          }
          try { state.sourceHead = (await this.#git(sourceDir, ["rev-parse", "--verify", "HEAD"])).toString("utf8").trim(); } catch { /* Unborn Git repositories support Local versions. */ }
        }
        await this.#save(state);
        return this.#descriptor(state);
      };
      let top: string;
      try { top = (await this.#git(sourceDir, ["rev-parse", "--show-toplevel"])).toString("utf8").trim(); }
      catch (error) {
        if (mode !== "worktree" && ((error as NodeJS.ErrnoException).code === "ENOENT" || String((error as Error).message).includes("not a git repository"))) return local(false);
        throw error;
      }
      if (await realpath(top) !== sourceDir) {
        if (mode !== "worktree") return local(false, "Select the Git repository root to enable workspace versions for this project.");
        throw problem("workspace_repository_root_required", "Select the Git repository root to create an independent workspace.");
      }
      if (inside(sourceDir, this.#root)) throw problem("workspace_storage_inside_project", "Workspace storage must be outside the source repository.");
      if (mode !== "worktree") return local(true);
      let sourceHead: string;
      try { sourceHead = (await this.#git(sourceDir, ["rev-parse", "--verify", "HEAD"])).toString("utf8").trim(); }
      catch (error) {
        throw problem("workspace_commit_required", "Create the first Git commit before starting a Worktree task.");
      }
      const stateDir = this.#directory(sessionId);
      const workspaceDir = join(stateDir, "checkout");
      await mkdir(stateDir, { recursive: true });
      const intentPath = join(stateDir, "provisioning.json");
      let intent: State | undefined;
      try { intent = JSON.parse(await readFile(intentPath, "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (intent && (!["bush.task_workspace.v1", "bush.task_workspace.v2"].includes(intent.protocol) || intent.sessionId !== sessionId || intent.sourceDir !== sourceDir || intent.workspaceDir !== workspaceDir)) {
        throw problem("workspace_identity_conflict", "The interrupted workspace setup belongs to a different project.");
      }
      const state: State = intent ? await this.#migrate(intent) : {
        protocol: "bush.task_workspace.v2", ...direct(), mode: "worktree", workspaceDir, versioning: "git",
        sourceHead, baselineId: "", latestId: "", appliedId: "", checkpoints: [],
      };
      const baseline = intent ? await this.#snapshot(state, state.baselineId) : await this.#capture(state, sourceDir, {});
      if (!intent) state.baselineId = state.latestId = state.appliedId = await this.#saveSnapshot(state, baseline);
      let exists = false;
      try { await lstat(workspaceDir); exists = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (exists && !intent) throw problem("workspace_owner_mismatch", `Unowned files already exist at ${workspaceDir}.`);
      if (exists) {
        await this.#assertOwned(state);
        const partial = await this.#capture(state, workspaceDir, baseline);
        if (Object.keys(partial).some(path => !equal(partial[path], baseline[path]))) {
          throw problem("workspace_provisioning_conflict", `The interrupted task copy at ${workspaceDir} was edited. Its files were preserved.`);
        }
      }
      await this.#atomicJson(intentPath, state);
      // Never change the source index or copy through checkout filters. The
      // original working bytes (including non-ignored untracked files) are the baseline.
      if (!exists) await this.#git(sourceDir, ["worktree", "add", "--force", "--detach", "--no-checkout", workspaceDir, state.sourceHead!]);
      try {
        await this.#git(workspaceDir, ["read-tree", state.sourceHead!]);
        const contents = await this.#store(state).blobs(Object.values(baseline).map(entry => entry.hash));
        await mapFiles(Object.entries(baseline), async ([path, entry]) => {
          const current = await this.#readEntry(state, workspaceDir, path);
          if (current && !equal(current, entry)) throw problem("workspace_provisioning_conflict", `${path} changed during task setup; its bytes were preserved.`);
          if (!current) await this.#writeEntry(state, workspaceDir, path, entry, contents.get(entry.hash));
        });
        const actual = await this.#capture(state, workspaceDir, baseline);
        if (changed(baseline, actual).length) throw problem("workspace_copy_mismatch", "The task copy differs from its recorded baseline.");
        await this.#save(state);
        await rm(intentPath, { force: true }).catch(() => undefined);
        return this.#descriptor(state);
      } catch (error) {
        // Only the exact checkout we just registered is eligible for cleanup.
        if (!exists) {
          await this.#assertOwned(state).then(() => this.#git(sourceDir, ["worktree", "remove", "--force", workspaceDir]))
            .then(() => rm(intentPath, { force: true })).catch(() => undefined);
        }
        throw error;
      }
    });
  }

  async beginTurn(sessionId: string, turnId: string): Promise<boolean> {
    return this.#exclusive(sessionId, async () => {
      const state = await this.#load(sessionId);
      if (!state || state.versioning !== "git") return false;
      await this.#recover(state);
      this.#ready(state);
      const last = state.checkpoints.at(-1);
      if (last?.status === "pending" || last?.status === "failed") {
        throw problem("workspace_checkpoint_pending", "The previous workspace checkpoint is incomplete. Refresh its checkpoint before continuing.");
      }
      const before = await this.#capture(state, state.workspaceDir, await this.#snapshot(state, state.latestId));
      const checkpoint: Checkpoint = { turnId, createdAt: new Date().toISOString(), status: "pending", before: await this.#saveSnapshot(state, before) };
      state.checkpoints.push(checkpoint);
      state.revision++;
      await this.#save(state);
      this.#active.set(sessionId, turnId);
      return true;
    });
  }

  async ownsFileVersion(sessionId: string, path: string): Promise<boolean> {
    return this.#exclusive(sessionId, async () => {
      const state = await this.#load(sessionId);
      if (!state || state.versioning !== "git" || !inside(state.workspaceDir, path)) return false;
      const checkpoint = state.checkpoints.at(-1);
      if (!checkpoint || checkpoint.status !== "pending" || this.#active.get(sessionId) !== checkpoint.turnId) return false;
      const local = relative(state.workspaceDir, path).split(sep).join("/");
      if ((await this.#snapshot(state, checkpoint.before))[local]) return true;
      if (checkpoint.paths?.includes(local)) return true;
      try { await this.#git(state.workspaceDir, ["check-ignore", "--quiet", "--", local]); return false; }
      catch (error) {
        if ((error as { code?: number }).code !== 1) throw error;
        checkpoint.paths = [...(checkpoint.paths ?? []), local];
        state.revision++;
        await this.#save(state);
        return true;
      }
    }, true);
  }

  async finishTurn(sessionId: string, turnId: string, runningProcesses = false): Promise<void> {
    // Only this matching Turn may finalize its pending checkpoint.
    return this.#exclusive(sessionId, async () => {
      try {
        const state = await this.#required(sessionId);
        const checkpoint = state.checkpoints.find(item => item.turnId === turnId);
        if (!checkpoint || checkpoint.status !== "pending") return;
        try {
          const after = await this.#capture(state, state.workspaceDir, await this.#snapshot(state, checkpoint.before), checkpoint.paths);
          checkpoint.after = await this.#saveSnapshot(state, after);
          checkpoint.status = "complete";
          checkpoint.capturedAt = new Date().toISOString();
          checkpoint.backgroundProcesses = runningProcesses;
          state.latestId = checkpoint.after;
        } catch (error) {
          checkpoint.status = "failed";
          checkpoint.error = (error as Error).message;
          throw error;
        } finally {
          state.revision++;
          await this.#save(state);
        }
      } finally {
        if (this.#active.get(sessionId) === turnId) this.#active.delete(sessionId);
      }
    }, true);
  }

  async recoverCheckpoint(sessionId: string): Promise<void> {
    return this.#exclusive(sessionId, async () => {
      const state = await this.#required(sessionId);
      await this.#recover(state);
      this.#ready(state);
      const checkpoint = state.checkpoints.at(-1);
      if (!checkpoint || !["pending", "failed"].includes(checkpoint.status)) return;
      checkpoint.after = await this.#saveSnapshot(state, await this.#capture(state, state.workspaceDir, await this.#snapshot(state, checkpoint.before), checkpoint.paths));
      checkpoint.status = "complete";
      checkpoint.capturedAt = new Date().toISOString();
      checkpoint.backgroundProcesses = false;
      delete checkpoint.error;
      state.latestId = checkpoint.after;
      state.revision++;
      await this.#save(state);
    });
  }

  async review(sessionId: string, view: "live" | "history" = "live"): Promise<WorkspaceReview | null> {
    return this.#exclusive(sessionId, async () => {
      const state = await this.#load(sessionId);
      if (!state) return null;
      if (view === "live") await this.#recover(state);
      const checkpoints = await Promise.all(state.checkpoints.map(async checkpoint => ({
        turnId: checkpoint.turnId, createdAt: checkpoint.createdAt, status: checkpoint.status,
        capturedAt: checkpoint.capturedAt, backgroundProcesses: checkpoint.backgroundProcesses,
        ...(checkpoint.error ? { error: checkpoint.error } : {}),
        changes: checkpoint.after ? await this.#changes(state, checkpoint.before, checkpoint.after, checkpoint.turnId) : [],
      })));
      let changes: WorkspaceChange[] = [], error: string | undefined, snapshotId: string | undefined;
      if (view === "live" && state.status === "ready" && state.versioning === "git") {
        try {
          const current = await this.#saveSnapshot(state, await this.#capture(state, state.workspaceDir, await this.#snapshot(state, state.latestId)));
          snapshotId = current;
          changes = await this.#changes(state, state.appliedId, current, "task");
        } catch (caught) { error = (caught as Error).message; }
      }
      return { workspace: this.#descriptor(state), checkpoints, changes, ...(error ? { error } : {}), snapshotId };
    }, true);
  }

  async revert(sessionId: string, turnIds: string[]) {
    return this.#exclusive(sessionId, async () => {
      const state = await this.#required(sessionId);
      await this.#recover(state);
      this.#ready(state);
      let current = await this.#capture(state, state.workspaceDir, await this.#snapshot(state, state.latestId));
      const initial = current;
      const ids: string[] = [];
      const selected: Checkpoint[] = [];
      for (const turnId of [...new Set(turnIds)]) {
        const checkpoint = state.checkpoints.find(item => item.turnId === turnId);
        if (!checkpoint) throw problem("workspace_checkpoint_missing", `No workspace checkpoint exists for Turn ${turnId}.`);
        if (checkpoint.status === "reverted") continue;
        if (checkpoint.status !== "complete" || !checkpoint.after) throw problem("workspace_checkpoint_pending", "An incomplete checkpoint cannot be reverted.");
        const before = await this.#snapshot(state, checkpoint.before), after = await this.#snapshot(state, checkpoint.after);
        current = Object.assign(Object.create(null), current);
        for (const path of changed(before, after)) {
          if (!equal(current[path], after[path])) throw problem("workspace_revision_conflict", `Cannot revert ${path}; it changed after this Turn.`);
          if (before[path]) current[path] = before[path]; else delete current[path];
          ids.push(this.#changeId(state, turnId, path));
        }
        selected.push(checkpoint);
      }
      await this.#transaction(state, state.workspaceDir, initial, current);
      selected.forEach(checkpoint => { checkpoint.status = "reverted"; });
      state.latestId = await this.#saveSnapshot(state, current);
      state.revision++;
      await this.#commitTransaction(state);
      return { sessionId, turnIds, revertedFiles: changed(initial, current).length, revertedChangeIds: ids, revertedAt: new Date().toISOString() };
    });
  }

  async update(sessionId: string, expectedRevision: number, action: "apply" | "discard" | "use_direct" | "init_git", expectedSnapshotId?: string): Promise<WorkspaceDescriptor> {
    return this.#exclusive(sessionId, async () => {
      const state = await this.#required(sessionId);
      await this.#recover(state);
      if (state.revision !== expectedRevision) throw problem("workspace_revision_conflict", "Workspace changed. Refresh its review before applying this action.");
      if (action === "init_git") {
        if (state.mode !== "direct" || state.status !== "ready") throw problem("workspace_mode_locked", "Only a Local task can initialize its project repository.");
        if (state.versioning !== "git") {
          await this.#assertDestination(state.sourceDir);
          if (inside(state.sourceDir, this.#root)) throw problem("workspace_storage_inside_project", "Workspace storage must be outside the source repository.");
          let existingRoot: string | undefined;
          try { existingRoot = (await this.#git(state.sourceDir, ["rev-parse", "--show-toplevel"])).toString("utf8").trim(); }
          catch (error) { if (!String((error as Error).message).includes("not a git repository")) throw error; }
          if (existingRoot && !sameLocation(await realpath(existingRoot), state.sourceDir)) {
            throw problem("workspace_repository_root_required", "This folder already belongs to a parent Git repository. Select that repository root to enable Git versions.");
          }
          if (!existingRoot) await this.#git(state.sourceDir, ["init", "--quiet"]);
          const top = (await this.#git(state.sourceDir, ["rev-parse", "--show-toplevel"])).toString("utf8").trim();
          if (!sameLocation(await realpath(top), state.sourceDir)) throw problem("workspace_repository_root_required", "Select the Git repository root.");
          state.baselineId = await this.#saveSnapshot(state, await this.#capture(state, state.sourceDir, {}));
          state.latestId = state.appliedId = state.baselineId;
          state.versioning = "git";
          delete state.versioningError;
          state.revision++;
          await this.#save(state);
        }
        return this.#descriptor(state);
      }
      this.#ready(state);
      if (state.mode !== "worktree") throw problem("workspace_mode_locked", "Apply and discard operate on Worktree tasks only.");
      const reviewed = await this.#capture(state, state.workspaceDir, await this.#snapshot(state, state.latestId));
      if (!expectedSnapshotId || await this.#saveSnapshot(state, reviewed) !== expectedSnapshotId) {
        throw problem("workspace_review_stale", "Workspace files changed since review. Refresh before applying this action.");
      }
      if (action === "apply") {
        if (state.checkpoints.some(checkpoint => checkpoint.status === "pending" || checkpoint.status === "failed")) {
          throw problem("workspace_checkpoint_pending", "Complete the pending checkpoint before applying changes.");
        }
        const expected = await this.#snapshot(state, state.appliedId);
        const current = reviewed;
        await this.#transaction(state, state.sourceDir, expected, current);
        state.appliedId = await this.#saveSnapshot(state, current);
        state.revision++;
        await this.#commitTransaction(state);
      } else {
        if (action === "use_direct" && state.checkpoints.length) throw problem("workspace_mode_locked", "Workspace mode can only change before the first Turn.");
        if (action === "use_direct") {
          const baseline = await this.#snapshot(state, state.baselineId);
          if (changed(baseline, await this.#capture(state, state.workspaceDir, baseline)).length) throw problem("workspace_has_changes", "The independent workspace has changes; review them before switching modes.");
        }
        await this.#assertOwned(state);
        state.disposal = action;
        await this.#save(state);
        await this.#git(state.sourceDir, ["worktree", "remove", "--force", state.workspaceDir]);
        state.revision++;
        if (action === "use_direct") { state.mode = "direct"; state.workspaceDir = state.sourceDir; }
        else state.status = "discarded";
        delete state.disposal;
        await this.#save(state);
      }
      return this.#descriptor(state);
    });
  }

  async #transaction(state: State, root: string, before: Snapshot, after: Snapshot) {
    this.#lockDestination(state.sessionId, root);
    await this.#assertDestination(root);
    const paths = changed(before, after).sort((a, b) =>
      Number(Boolean(after[a])) - Number(Boolean(after[b])) ||
      (after[a] ? a.split('/').length - b.split('/').length : b.split('/').length - a.split('/').length));
    for (const path of paths) if (!equal(await this.#readEntry(state, root, path), before[path])) {
      throw problem("workspace_revision_conflict", `${path} has changed in the destination. No files were applied.`);
    }
    const versions = await this.#store(state).blobs(paths.flatMap(path => [before[path]?.hash, after[path]?.hash].filter((id): id is string => Boolean(id))));
    state.pending = { root, before: await this.#saveSnapshot(state, before), after: await this.#saveSnapshot(state, after), paths };
    await this.#save(state);
    try {
      for (const path of paths) {
        if (!equal(await this.#readEntry(state, root, path), before[path])) throw problem("workspace_revision_conflict", `${path} changed while preparing the restore.`);
        await this.#writeEntry(state, root, path, after[path], after[path] ? versions.get(after[path].hash) : undefined);
      }
    } catch (error) {
      await this.#recover(state);
      throw error;
    }
  }

  async #commitTransaction(state: State) { delete state.pending; await this.#save(state); }

  async #recover(state: State) {
    if (state.disposal) {
      let exists = true;
      try { await lstat(state.workspaceDir); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") exists = false; else throw error; }
      // A completed removal can be acknowledged after a crash. If the copy
      // still exists, require a fresh review; a read must never remove it.
      if (!exists) {
        if (state.disposal === "use_direct") { state.mode = "direct"; state.workspaceDir = state.sourceDir; }
        else state.status = "discarded";
      }
      delete state.disposal;
      state.revision++;
      await this.#save(state);
    }
    const transaction = state.pending;
    if (!transaction) return;
    this.#lockDestination(state.sessionId, transaction.root);
    if (transaction.root !== state.workspaceDir && transaction.root !== state.sourceDir) throw problem("workspace_journal_corrupt", "Invalid workspace transaction destination.");
    await this.#assertDestination(transaction.root);
    const before = await this.#snapshot(state, transaction.before), after = await this.#snapshot(state, transaction.after);
    const versions = await this.#store(state).blobs(transaction.paths.flatMap(path => before[path] ? [before[path].hash] : []));
    // A crash before the state commit rolls back only bytes we still own.
    for (const path of transaction.paths) {
      const current = await this.#readEntry(state, transaction.root, path);
      if (!equal(current, before[path]) && !equal(current, after[path])) {
        throw problem("workspace_recovery_conflict", `${path} changed outside the pending restore. Preserve it and resolve the conflict before continuing.`);
      }
    }
    for (const path of [...transaction.paths].reverse()) {
      const current = await this.#readEntry(state, transaction.root, path);
      if (equal(current, before[path])) continue;
      if (!equal(current, after[path])) throw problem("workspace_recovery_conflict", `${path} changed during recovery.`);
      await this.#writeEntry(state, transaction.root, path, before[path], before[path] ? versions.get(before[path].hash) : undefined);
    }
    delete state.pending;
    await this.#save(state);
  }

  async #capture(state: State, root: string, known: Snapshot, enrolled: string[] = []): Promise<Snapshot> {
    await this.#assertDestination(root);
    const store = this.#store(state);
    const list = async () => {
      const entries = decodeGitPaths(await this.#git(root, ["ls-files", "--stage", "-z"])).split("\0").filter(Boolean);
      if (entries.some(entry => entry.startsWith("160000 "))) throw problem("workspace_submodule_unsupported", "Git workspace versions do not yet support submodules.");
      const tracked = entries.map(entry => entry.slice(entry.indexOf("\t") + 1));
      const others = decodeGitPaths(await this.#git(root, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
      return [...new Set([...tracked, ...others, ...Object.keys(known), ...enrolled])].sort();
    };
    const paths = await list();
    const describe = async () => mapFiles(paths, async path => {
      const absolute = await this.#filePath(root, path);
      let stat;
      try { stat = await lstat(absolute); }
      catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined; throw error; }
      if (stat.isDirectory()) return undefined;
      if (!stat.isFile() && !stat.isSymbolicLink()) throw problem("workspace_file_type_unsupported", `Cannot version non-file entry ${path}.`);
      return { path, absolute, kind: stat.isSymbolicLink() ? "symlink" as const : "file" as const,
        mode: process.platform === "win32" ? 0o666 : stat.isSymbolicLink() ? 0o777 : stat.mode & 0o111 ? 0o755 : 0o644 };
    });
    const entries = await describe();
    const files = entries.filter(entry => entry?.kind === "file");
    const ids = await store.hashFiles(root, files.map(entry => entry!.path));
    const snapshot: Snapshot = Object.create(null), blobs = new Map<string, () => Promise<Buffer>>();
    const knownObjects = new Set(Object.values(known).map(entry => entry.hash));
    let index = 0;
    for (const entry of entries) {
      if (!entry) continue;
      const read = () => entry.kind === "symlink" ? readlink(entry.absolute, { encoding: "buffer" }) : readFile(entry.absolute);
      const id = entry.kind === "file" ? ids[index++]! : await store.blobId(await read());
      snapshot[entry.path] = { hash: id, kind: entry.kind, mode: entry.mode };
      if (!knownObjects.has(id)) blobs.set(id, read);
    }
    await store.storeBlobs(blobs);
    // Hash bytes in Git in bulk; timestamps never prove that content is unchanged.
    const verified = await store.hashFiles(root, files.map(entry => entry!.path));
    if (ids.some((id, index) => id !== verified[index]) || JSON.stringify(paths) !== JSON.stringify(await list()) ||
        JSON.stringify(entries) !== JSON.stringify(await describe())) {
      throw problem("workspace_changed_during_checkpoint", "Workspace files changed during Git version capture.");
    }
    for (const entry of entries) if (entry?.kind === "symlink" && snapshot[entry.path]!.hash !== await store.blobId(await readlink(entry.absolute, { encoding: "buffer" }))) {
      throw problem("workspace_changed_during_checkpoint", `${entry.path} changed during Git version capture.`);
    }
    return changed(known, snapshot).length ? snapshot : known;
  }

  async #readEntry(state: State, root: string, path: string): Promise<Entry | undefined> {
    const absolute = await this.#filePath(root, path);
    let stat;
    try { stat = await lstat(absolute); } catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined; throw error; }
    if (stat.isDirectory()) return undefined;
    if (!stat.isFile() && !stat.isSymbolicLink()) throw problem("workspace_file_type_unsupported", `Cannot checkpoint non-file entry ${path}.`);
    const content = stat.isSymbolicLink() ? await readlink(absolute, { encoding: "buffer" }) : await readFile(absolute);
    return { hash: await this.#store(state).blobId(content), mode: process.platform === "win32" ? 0o666 : stat.isSymbolicLink() ? 0o777 : stat.mode & 0o111 ? 0o755 : 0o644,
      kind: stat.isSymbolicLink() ? "symlink" : "file" };
  }

  async #filePath(root: string, path: string): Promise<string> {
    if (!path || path.includes("\\") || isAbsolute(path) || path.split("/").some(part => !part || part === ".." || part === "." || part.toLowerCase() === ".git" ||
      (process.platform === "win32" && (/[<>:"|?*]/.test(part) || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))))) {
      throw problem("workspace_path_invalid", `Invalid checkpoint path: ${path}`);
    }
    const absolute = resolve(root, path);
    if (!inside(root, absolute)) throw problem("workspace_path_invalid", "Checkpoint path escapes its workspace.");
    let parent = dirname(absolute);
    while (parent !== resolve(root)) {
      try { if ((await lstat(parent)).isSymbolicLink()) throw problem("workspace_link_parent", `Checkpoint path traverses a directory link: ${path}`); }
      catch (error) { if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
      parent = dirname(parent);
    }
    return absolute;
  }

  async #writeEntry(state: State, root: string, path: string, entry?: Entry, savedContent?: Buffer) {
    const absolute = await this.#filePath(root, path);
    if (!entry) {
      await rm(absolute, { force: true });
      // Git records files, not empty directories. Prune only empty ancestors
      // so a reverted directory can become a file again.
      let parent = dirname(absolute);
      while (parent !== resolve(root)) {
        try { await rmdir(parent); }
        catch (error) {
          if (["ENOTEMPTY", "EEXIST", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) break;
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        parent = dirname(parent);
      }
      return;
    }
    const content = savedContent ?? await this.#readBlob(state, entry.hash);
    await mkdir(dirname(absolute), { recursive: true });
    try { if ((await lstat(absolute)).isDirectory()) await rmdir(absolute); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (entry.kind === "symlink") {
      await rm(absolute, { force: true });
      await symlink(content, absolute);
    } else {
      const temp = `${absolute}.cardbush-${randomUUID()}.tmp`;
      try {
        await writeFile(temp, content, { flag: "wx", mode: entry.mode });
        if (process.platform !== "win32") await chmod(temp, entry.mode);
        await rename(temp, absolute);
      } finally { await rm(temp, { force: true }); }
    }
  }

  async #changes(state: State, beforeId: string, afterId: string, turnId: string): Promise<WorkspaceChange[]> {
    if (beforeId === afterId) return [];
    const key = JSON.stringify([state.sessionId, state.workspaceDir, beforeId, afterId]);
    const project = (changes: WorkspaceChange[]) => structuredClone(changes.map(change => ({ ...change,
      change_id: this.#changeId(state, turnId, relative(state.workspaceDir, change.path).split(sep).join("/")),
    })));
    const cached = this.#changeViews.get(key);
    if (cached) return project(cached);
    const before = await this.#snapshot(state, beforeId), after = await this.#snapshot(state, afterId);
    const paths = changed(before, after);
    const store = this.#store(state);
    const contents = await store.blobs(paths.flatMap(path => [before[path]?.hash, after[path]?.hash].filter((id): id is string => Boolean(id))));
    const changes = await mapFiles(paths, async path => {
      const left = before[path] ? contents.get(before[path].hash)! : Buffer.alloc(0);
      const right = after[path] ? contents.get(after[path].hash)! : Buffer.alloc(0);
      const binary = left.includes(0) || right.includes(0) || !Buffer.from(left.toString("utf8")).equals(left) || !Buffer.from(right.toString("utf8")).equals(right);
      const large = left.length + right.length > 128 * 1024;
      const display: { text: string; additions?: number; deletions?: number } = binary || large ? {
        text: `${binary ? "Binary" : "Large"} file changed (${left.length} → ${right.length} bytes); byte-exact checkpoint available.`,
      } : { text: await store.patch(beforeId, afterId, path) };
      if (!binary && !large) {
        display.additions = display.deletions = 0;
        let hunk = false;
        for (const line of display.text.split("\n")) {
          if (line.startsWith("diff --git ")) hunk = false;
          else if (line.startsWith("@@ ")) hunk = true;
          else if (hunk && line.startsWith("+")) display.additions++;
          else if (hunk && line.startsWith("-")) display.deletions++;
        }
      }
      return {
        change_id: this.#changeId(state, turnId, path), path: join(state.workspaceDir, path),
        status: !before[path] ? "added" : !after[path] ? "deleted" : "modified",
        ...(before[path] ? { before_hash: hash(left) } : {}), ...(after[path] ? { after_hash: hash(right) } : {}),
        ...("additions" in display ? { additions: display.additions, deletions: display.deletions } : {}),
        metadata: { diff: display.text, binary, diffOmitted: binary || large, workspaceCheckpoint: true,
          beforeObjectId: before[path]?.hash, afterObjectId: after[path]?.hash,
          beforeMode: before[path]?.mode, afterMode: after[path]?.mode, beforeKind: before[path]?.kind, afterKind: after[path]?.kind },
      };
    });
    if (this.#changeViews.size >= 128) this.#changeViews.delete(this.#changeViews.keys().next().value!);
    this.#changeViews.set(key, changes as WorkspaceChange[]);
    return project(changes as WorkspaceChange[]);
  }

  #changeId(state: State, turnId: string, path: string) { return `workspace_${hash(JSON.stringify([state.sessionId, turnId, path]))}`; }
  #descriptor(state: State): WorkspaceDescriptor {
    const { mode, sessionId, sourceDir, workspaceDir, revision, status, baselineId, sourceHead, versioning, versioningError } = state;
    return { mode, sessionId, sourceDir, workspaceDir, revision, status, baselineId: baselineId || undefined, sourceHead, versioning, versioningError };
  }
  #directory(sessionId: string) { return join(this.#root, "tasks", hash(sessionId)); }
  async #load(sessionId: string): Promise<State | undefined> {
    const path = join(this.#directory(sessionId), "state.json");
    let state: State;
    try { state = JSON.parse(await readFile(path, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    if (!["bush.task_workspace.v1", "bush.task_workspace.v2"].includes(state.protocol) || state.sessionId !== sessionId || !isAbsolute(state.sourceDir) ||
      (state.mode === "direct" && !sameLocation(state.workspaceDir, state.sourceDir)) ||
      (state.mode === "worktree" && !sameLocation(state.workspaceDir, join(this.#directory(sessionId), "checkout")))) {
      throw problem("workspace_journal_corrupt", "Workspace identity does not match its persisted owner.");
    }
    if (state.protocol !== "bush.task_workspace.v2") {
      await this.#migrate(state);
      await this.#save(state);
    }
    return state;
  }
  async #required(sessionId: string) {
    const state = await this.#load(sessionId);
    if (!state) throw problem("workspace_missing", "This task has no managed workspace.");
    return state;
  }
  #ready(state: State) {
    if (state.versioning !== "git" || state.status !== "ready") throw problem("workspace_not_ready", "This task has no active Git workspace.");
  }
  async #assertDestination(root: string) {
    let valid = false;
    try { valid = (await lstat(root)).isDirectory() && sameLocation(await realpath(root), root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!valid) throw problem("workspace_destination_changed", "The workspace destination moved or became a link. Restore its original location before applying changes.");
  }
  async #assertOwned(state: State) {
    const expected = join(this.#directory(state.sessionId), "checkout");
    if (!sameLocation(state.workspaceDir, expected) || !inside(this.#root, expected)) throw problem("workspace_owner_mismatch", "Refusing to remove a workspace not owned by this task.");
    await this.#assertDestination(expected);
    const root = (await this.#git(expected, ["rev-parse", "--show-toplevel"])).toString("utf8").trim();
    if (await realpath(root) !== await realpath(expected)) throw problem("workspace_owner_mismatch", "Workspace Git identity changed.");
    const commonDir = async (path: string) => realpath((await this.#git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).toString("utf8").trim());
    if (await commonDir(expected) !== await commonDir(state.sourceDir)) throw problem("workspace_owner_mismatch", "The task copy no longer belongs to its source Git repository.");
  }
  async #save(state: State) { await this.#atomicJson(join(this.#directory(state.sessionId), "state.json"), state); }
  #store(state: State) {
    let store = this.#stores.get(state.sessionId);
    if (!store) {
      store = new GitWorkspaceStore(state.sourceDir, this.#directory(state.sessionId), state.sessionId);
      this.#stores.set(state.sessionId, store);
    }
    return store;
  }
  async #saveSnapshot(state: State, snapshot: Snapshot) {
    let id = this.#treeIds.get(snapshot);
    if (!id) { id = await this.#store(state).save(snapshot); this.#treeIds.set(snapshot, id); }
    return id;
  }
  async #snapshot(state: State, id: string): Promise<Snapshot> {
    const tree = await this.#store(state).tree(id);
    this.#treeIds.set(tree, id);
    return tree;
  }
  async #readBlob(state: State, id: string) { return this.#store(state).blob(id); }

  async #migrate(state: State): Promise<State> {
    if (state.protocol === "bush.task_workspace.v2") return state;
    const store = this.#store(state), migrated = new Map<string, string>();
    const read = async (id: string) => {
      if (!/^[a-f0-9]{64}$/.test(id)) throw problem("workspace_journal_corrupt", "Invalid legacy blob identity.");
      const bytes = await readFile(join(this.#root, "blobs", id));
      if (hash(bytes) !== id) throw problem("workspace_journal_corrupt", "Legacy workspace content checksum mismatch.");
      return bytes;
    };
    const convert = async (id: string) => {
      if (migrated.has(id)) return migrated.get(id)!;
      if (!/^[a-f0-9]{64}$/.test(id)) throw problem("workspace_journal_corrupt", "Invalid legacy snapshot identity.");
      const tree = JSON.parse(await readFile(join(this.#root, "snapshots", `${id}.json`), "utf8"));
      if (hash(JSON.stringify(tree)) !== id) throw problem("workspace_journal_corrupt", "Legacy workspace manifest checksum mismatch.");
      const oid = await store.importLegacy(tree, read);
      migrated.set(id, oid);
      return oid;
    };
    state.baselineId = await convert(state.baselineId);
    state.latestId = await convert(state.latestId);
    state.appliedId = await convert(state.appliedId);
    for (const checkpoint of state.checkpoints) {
      checkpoint.before = await convert(checkpoint.before);
      if (checkpoint.after) checkpoint.after = await convert(checkpoint.after);
    }
    if (state.pending) {
      state.pending.before = await store.importLegacy(state.pending.before as unknown as Snapshot, read);
      state.pending.after = await store.importLegacy(state.pending.after as unknown as Snapshot, read);
    }
    state.protocol = "bush.task_workspace.v2";
    state.versioning = "git";
    // Retain legacy files so an interrupted migration cannot strand recovery points.
    return state;
  }
  async #atomicJson(path: string, value: unknown) {
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${randomUUID()}.tmp`;
    const handle = await open(temp, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
    try { await rename(temp, path); } finally { await rm(temp, { force: true }); }
  }
  async #git(root: string, args: string[]): Promise<Buffer> {
    const hooks = join(this.#root, "empty-hooks");
    await mkdir(hooks, { recursive: true });
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
    for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_LITERAL_PATHSPECS", "GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_ICASE_PATHSPECS"]) delete env[key];
    // check-ignore consumes literal filenames and rejects Git's pathspec-magic flag.
    const result = await exec("git", [...(args[0] === "check-ignore" ? [] : ["--literal-pathspecs"]), "-c", "core.fsmonitor=false", "-c", `core.hooksPath=${hooks}`, "-C", root, ...args], {
      encoding: "buffer", windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 30_000, env,
    });
    return result.stdout;
  }
  async #exclusive<T>(sessionId: string, operation: () => Promise<T>, allowActive = false): Promise<T> {
    const previous = this.#operations.get(sessionId);
    let release!: () => void;
    const promise = new Promise<void>(resolvePromise => { release = resolvePromise; });
    this.#operations.set(sessionId, promise);
    await previous;
    try {
      if (!allowActive && this.#active.has(sessionId)) throw problem("workspace_busy", "A workspace Turn is still active.");
      return await operation();
    } finally {
      for (const [root, owner] of this.#destinations) if (owner === sessionId) this.#destinations.delete(root);
      release();
      if (this.#operations.get(sessionId) === promise) this.#operations.delete(sessionId);
    }
  }
  #lockDestination(sessionId: string, root: string) {
    const key = process.platform === "win32" ? resolve(root).toLowerCase() : resolve(root);
    const owner = this.#destinations.get(key);
    if (owner && owner !== sessionId) throw problem("workspace_busy", "Another workspace is applying changes to this destination.");
    this.#destinations.set(key, sessionId);
  }
}
