import { lstat, readdir } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';

export function sandboxHardlinkConflict(root: string, path: string) {
  const relativePath = relative(root, path) || basename(path);
  return Object.assign(new Error(`Sandbox access cannot include a file with multiple hard links: ${JSON.stringify(relativePath)}. No command was started.`), {
    code: 'sandbox_hardlink_conflict', details: { sandboxRoot: root, relativePath },
  });
}

/** A directory grant cannot infer which of a file's aliases were authorized.
 * Reject ambiguous objects, including in hidden/ignored directories. Backends
 * repeat this check at the mount/ACL boundary before starting user code. */
export async function checkSandboxTree(roots: readonly string[], signal?: AbortSignal): Promise<void> {
  const seen = new Set<string>();
  for (const root of roots) {
    const pending = [root];
    while (pending.length) {
      signal?.throwIfAborted();
      const path = pending.pop()!;
      if (seen.has(path)) continue;
      seen.add(path);
      const info = await lstat(path, { bigint: true });
      if (info.isSymbolicLink()) continue;
      if (info.isFile() && info.nlink !== 1n) throw sandboxHardlinkConflict(root, path);
      if (info.isDirectory()) for (const name of await readdir(path)) pending.push(join(path, name));
    }
  }
}
