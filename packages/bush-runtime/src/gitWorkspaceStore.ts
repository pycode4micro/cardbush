import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const exec = promisify(execFile);
export type GitFileEntry = { hash: string; mode: number; kind: "file" | "symlink" };
export type GitFileTree = Record<string, GitFileEntry>;
const corrupt = (message: string) => Object.assign(new Error(message), { code: "workspace_journal_corrupt" });

/** Git objects are the only version store. The private index never stages user files. */
export class GitWorkspaceStore {
  readonly root: string;
  readonly directory: string;
  readonly namespace: string;
  #format?: "sha1" | "sha256";

  constructor(root: string, directory: string, sessionId: string) {
    this.root = root;
    this.directory = directory;
    this.namespace = `refs/cardbush/workspaces/${createHash("sha256").update(sessionId).digest("hex")}`;
  }

  async git(args: string[], input?: Buffer | AsyncIterable<Buffer>, env?: NodeJS.ProcessEnv, cwd = this.root, maxBuffer = 128 * 1024 * 1024): Promise<Buffer> {
    const hooks = join(this.directory, "empty-hooks");
    await mkdir(hooks, { recursive: true });
    const environment: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
    for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_LITERAL_PATHSPECS", "GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_ICASE_PATHSPECS"]) delete environment[key];
    Object.assign(environment, env);
    const pending = exec("git", ["--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", `core.hooksPath=${hooks}`, "-C", cwd, ...args], {
      encoding: "buffer", windowsHide: true, maxBuffer, timeout: 120_000, env: environment,
    });
    const writing = pipeline(Readable.from(input === undefined ? [] : Buffer.isBuffer(input) ? [input] : input), pending.child.stdin!)
      .catch(error => { pending.child.kill(); throw error; });
    const results = await Promise.allSettled([pending, writing]);
    const result = results[0];
    if (result.status === "rejected") throw result.reason;
    if (results[1].status === "rejected") throw results[1].reason;
    return result.value.stdout;
  }

  async format() {
    return this.#format ??= (await this.git(["rev-parse", "--show-object-format"])).toString("utf8").trim() as "sha1" | "sha256";
  }

  async blobId(bytes: Buffer) {
    return createHash(await this.format()).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  }

  async hashFiles(root: string, paths: string[]): Promise<string[]> {
    if (!paths.length) return [];
    // --no-filters preserves bytes even with autocrlf, clean filters or working-tree-encoding.
    const input = Buffer.from(paths.map(path => quoteGitPath(resolve(root, path).replaceAll("\\", "/"))).join("\n") + "\n");
    const ids = (await this.git(["hash-object", "--no-filters", "--stdin-paths"], input)).toString("utf8").trim().split("\n");
    if (ids.length !== paths.length || ids.some(id => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(id))) throw corrupt("Git returned an invalid file object list.");
    return ids;
  }

  async storeBlobs(blobs: Map<string, () => Promise<Buffer>>) {
    if (!blobs.size) return;
    const ids = [...blobs.keys()];
    const rows = (await this.git(["cat-file", "--batch-check"], Buffer.from(ids.join("\n") + "\n"))).toString("utf8").trim().split("\n");
    const missing = ids.filter((_, index) => rows[index] === `${ids[index]} missing`);
    const store = this;
    // fast-import packs a batch instead of opening and fsyncing one custom blob per file.
    async function* objects() {
      for (const id of missing) {
        const bytes = await blobs.get(id)!();
        if (await store.blobId(bytes) !== id) throw Object.assign(new Error("A file changed while capturing its Git version."), { code: "workspace_changed_during_checkpoint" });
        yield Buffer.from(`blob\ndata ${bytes.length}\n`);
        yield bytes;
        yield Buffer.from("\n");
      }
      yield Buffer.from("done\n");
    }
    if (missing.length) await this.git(["fast-import", "--quiet", "--done"], objects());
  }

  async save(tree: GitFileTree): Promise<string> {
    const index = join(this.directory, `index-${randomUUID()}`);
    const env = { GIT_INDEX_FILE: index };
    try {
      await this.git(["read-tree", "--empty"], undefined, env);
      const input = Buffer.from(Object.entries(tree).map(([path, entry]) =>
        `${entry.kind === "symlink" ? "120000" : entry.mode & 0o111 ? "100755" : "100644"} ${entry.hash}\t${path}\0`).join(""));
      if (input.length) await this.git(["update-index", "-z", "--index-info"], input, env);
      const id = (await this.git(["write-tree"], undefined, env)).toString("utf8").trim();
      // Reachability is persisted before state.json can reference the tree.
      await this.git(["update-ref", `${this.namespace}/snapshots/${id}`, id]);
      return id;
    } finally {
      await rm(index, { force: true });
      await rm(`${index}.lock`, { force: true });
    }
  }

  async tree(id: string): Promise<GitFileTree> {
    assertOid(id);
    const bytes = await this.git(["ls-tree", "-rz", "--full-tree", id]);
    const tree: GitFileTree = Object.create(null);
    for (const row of decodeGitPaths(bytes).split("\0").filter(Boolean)) {
      const tab = row.indexOf("\t"), header = row.slice(0, tab).split(" ");
      if (header[1] !== "blob") throw corrupt("Unsupported entry in a Git workspace version.");
      tree[row.slice(tab + 1)] = {
        hash: header[2]!, kind: header[0] === "120000" ? "symlink" : "file",
        mode: process.platform === "win32" ? 0o666 : header[0] === "120000" ? 0o777 : header[0] === "100755" ? 0o755 : 0o644,
      };
    }
    return tree;
  }

  async blobs(ids: string[]): Promise<Map<string, Buffer>> {
    const unique = [...new Set(ids)];
    unique.forEach(assertOid);
    const found = new Map<string, Buffer>();
    if (!unique.length) return found;
    let sizes: number[];
    try {
      const rows = (await this.git(["cat-file", "--batch-check"], Buffer.from(unique.join("\n") + "\n"))).toString("utf8").trim().split("\n");
      sizes = rows.map((row, index) => {
        const [id, type, count] = row.split(" "), size = Number(count);
        if (id !== unique[index] || type !== "blob" || !Number.isSafeInteger(size) || size < 0) throw corrupt("Git workspace content is missing or invalid.");
        return size;
      });
      if (sizes.length !== unique.length) throw corrupt("Incomplete Git object size response.");
    } catch (error) { throw corrupt(`Git workspace content could not be read: ${(error as Error).message}`); }
    // Bound batches; no persistent byte cache can hide object corruption during restore.
    for (let start = 0; start < unique.length; start += 128) {
      const batch = unique.slice(start, start + 128);
      let output: Buffer;
      const bytes = sizes.slice(start, start + batch.length).reduce((sum, size) => sum + size + 128, 0);
      try { output = await this.git(["cat-file", "--batch"], Buffer.from(batch.join("\n") + "\n"), undefined, this.root, Math.max(bytes, 1024)); }
      catch (error) { throw corrupt(`Git workspace content could not be read: ${(error as Error).message}`); }
      let cursor = 0;
      for (const id of batch) {
        const end = output.indexOf(10, cursor);
        const [actual, type, length] = output.subarray(cursor, end).toString("utf8").split(" ");
        const size = Number(length);
        if (end < 0 || actual !== id || type !== "blob" || !Number.isSafeInteger(size) || size < 0) throw corrupt("Git workspace content is missing or invalid.");
        const bytes = Buffer.from(output.subarray(end + 1, end + 1 + size));
        if (bytes.length !== size || await this.blobId(bytes) !== id) throw corrupt("Git workspace content checksum mismatch.");
        found.set(id, bytes);
        cursor = end + size + 2;
      }
    }
    return found;
  }

  async blob(id: string) { return (await this.blobs([id])).get(id)!; }

  async patch(before: string, after: string, path: string) {
    assertOid(before); assertOid(after);
    return (await this.git(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", "--no-indent-heuristic", before, after, "--", path])).toString("utf8");
  }

  async importLegacy(tree: GitFileTree, read: (hash: string) => Promise<Buffer>): Promise<string> {
    const converted: GitFileTree = Object.create(null), blobs = new Map<string, () => Promise<Buffer>>();
    for (const [path, entry] of Object.entries(tree)) {
      const content = await read(entry.hash), id = await this.blobId(content);
      converted[path] = { ...entry, hash: id };
      blobs.set(id, async () => content);
    }
    await this.storeBlobs(blobs);
    return this.save(converted);
  }
}

function assertOid(id: string) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(id)) throw corrupt("Invalid Git workspace object identity.");
}

export function decodeGitPaths(bytes: Buffer) {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes)) throw Object.assign(new Error("Workspace paths must use UTF-8."), { code: "workspace_path_encoding_unsupported" });
  return text;
}

function quoteGitPath(path: string) {
  return '"' + path.replace(/[\\"\x00-\x1f\x7f]/g, char => char === '"' || char === "\\" ? `\\${char}` : `\\${char.charCodeAt(0).toString(8).padStart(3, "0")}`) + '"';
}

export async function mapFiles<T, U>(items: T[], apply: (item: T) => Promise<U>): Promise<U[]> {
  const result = new Array<U>(items.length);
  let next = 0;
  const settled = await Promise.allSettled(Array.from({ length: Math.min(32, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      result[index] = await apply(items[index]!);
    }
  }));
  for (const outcome of settled) if (outcome.status === "rejected") throw outcome.reason;
  return result;
}
