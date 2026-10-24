import { createHash } from 'node:crypto';
import { link, mkdtemp, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SandboxFileHandle } from './workspaceSandboxFile.js';
import { WorkspacePathGuard } from './workspacePathGuard.js';

/** Windows can commit deletion by a checked, exclusively writable handle.
 * Linux unlinks a private staged name: atomic rename is the namespace commit,
 * and validation afterwards either accepts that object or restores it without
 * overwriting a concurrent creator. No content is read by the namespace broker. */
export async function deleteSandboxFile(path: string, fixed: string, identity: string, sha256: string,
  signal?: AbortSignal, linuxExecutable?: string) {
  if (process.platform === 'win32') {
    const file = await SandboxFileHandle.open(path, identity, true, sha256, signal, linuxExecutable, true);
    try { await file.request({ op: 'delete', sha256 }); return file.process.sandbox; }
    finally { await file.close(); }
  }
  if (process.platform !== 'linux') throw Object.assign(Error('Checked file deletion is unavailable on this platform.'), { code: 'workspace_atomic_delete_unavailable' });
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'cardbush-delete-')));
  const guard = new WorkspacePathGuard();
  const staged = join(directory, 'object');
  let moved = false, preserve = false;
  try {
    await guard.pin(directory);
    signal?.throwIfAborted();
    try { await rename(fixed, guard.file(staged)); moved = true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EXDEV') throw Object.assign(Error('Checked deletion requires private temporary storage on the same filesystem. No file was deleted; configure the Runtime temporary directory on this filesystem.'), { code: 'workspace_atomic_delete_unavailable' });
      throw error;
    }
    const file = await SandboxFileHandle.open(staged, identity, false, undefined, signal, linuxExecutable);
    let status;
    try {
      const hash = createHash('sha256');
      for await (const bytes of file.createReadStream({ signal })) hash.update(bytes);
      if (hash.digest('hex') !== sha256) throw Object.assign(Error('The file changed before deletion.'), { code: 'workspace_revision_conflict' });
      status = file.process.sandbox;
    } finally { await file.close(); }
    await unlink(guard.file(staged)); moved = false;
    return status;
  } catch (error) {
    if (moved) {
      try {
        // link is exclusive: never replace a newly created original name.
        await link(guard.file(staged), fixed);
        await unlink(guard.file(staged)); moved = false;
      } catch (recovery) {
        preserve = true;
        throw Object.assign(Error(`Deletion was not completed and its object was preserved at ${staged}. ${String(error)} Recovery: ${String(recovery)}`),
          { code: 'workspace_delete_recovery_required', details: { recoveryPath: staged } });
      }
    }
    throw error;
  } finally {
    await guard.close();
    if (!preserve) await rmdir(directory);
  }
}
