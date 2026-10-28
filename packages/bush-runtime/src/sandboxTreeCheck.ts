import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** A directory grant cannot infer which of a file's aliases were authorized.
 * Reject ambiguous objects, including in hidden/ignored directories. Backends
 * repeat this check at the mount/ACL boundary before starting user code. */
export async function checkSandboxTree(roots: readonly string[], signal?: AbortSignal): Promise<void> {
  const pending = [...roots], seen = new Set<string>();
  while (pending.length) {
    signal?.throwIfAborted();
    const path = pending.pop()!;
    if (seen.has(path)) continue;
    seen.add(path);
    const info = await lstat(path, { bigint: true });
    if (info.isSymbolicLink()) continue;
    if (info.isFile() && info.nlink !== 1n) throw Object.assign(new Error('Sandbox access cannot include a file with multiple hard links.'), { code: 'sandbox_approval_changed' });
    if (info.isDirectory()) for (const name of await readdir(path)) pending.push(join(path, name));
  }
}
