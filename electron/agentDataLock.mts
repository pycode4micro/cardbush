import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { link, open, readFile, rm, stat, writeFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

const active = new Set<string>();
const instance = randomUUID();
type Owner = { version: 1; pid: number; instance: string; start?: string; namespace?: string };
function failure(code: string) { return Object.assign(new Error(code), { code }); }
async function optional(path: string) {
  return readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return ''; throw error; });
}
async function identity(pid: number) {
  if (process.platform !== 'linux') return {};
  const value = await optional(`/proc/${pid}/stat`);
  const start = value ? value.slice(value.lastIndexOf(')') + 2).split(' ')[19] : undefined;
  const namespace = await stat(`/proc/${pid}/ns/pid`).then(s => `${s.dev}:${s.ino}`).catch(() => undefined);
  return { start, namespace };
}
async function kernelLock(handle: FileHandle) {
  // flock(2) belongs to the inherited open-file description. The parent keeps
  // that description open after flock exits; SIGKILL also releases ownership.
  await new Promise<void>((resolve, reject) => {
    const child = spawn('/usr/bin/flock', ['-n', '-E', '73', '3'], {
      stdio: ['ignore', 'ignore', 'ignore', handle.fd], windowsHide: true,
    });
    const timer = setTimeout(() => { child.kill(); reject(failure('AGENT_LOCK_PROBE_TIMEOUT')); }, 3000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(failure(code === 73 ? 'AGENT_DATA_DIRECTORY_BUSY' : 'AGENT_KERNEL_LOCK_FAILED'));
    });
  });
}

async function publishLock(path: string) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    // Publish a complete numeric owner atomically. A crash between open('wx')
    // and writeFile must never leave an empty agent.lock that blocks recovery.
    await handle.writeFile(String(process.pid));
    await link(temporary, path);
    return handle;
  } catch (error) { await handle.close(); throw error; }
  finally { await rm(temporary, { force: true }); }
}

/** Keep agent.lock's numeric format for local-host discovery and older clients.
 * The persistent kernel-lock inode must never be unlinked while readers race. */
export async function acquireAgentDataLock(root: string): Promise<() => Promise<void>> {
  const key = process.platform === 'win32' ? root.toLowerCase() : root;
  if (active.has(key)) throw failure('AGENT_DATA_DIRECTORY_BUSY');
  active.add(key);
  const path = join(root, 'agent.lock'), metadataPath = join(root, 'agent.lock.owner.json');
  let guard: FileHandle | undefined, lock: FileHandle | undefined, mine: Owner | undefined;
  try {
    if (process.platform === 'linux') {
      guard = await open(join(root, 'agent.lock.kernel'), 'a+', 0o600);
      await kernelLock(guard);
    }
    try { lock = await publishLock(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(await readFile(path, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw failure('AGENT_LOCK_INVALID');
      let owner: Owner | undefined;
      try { owner = JSON.parse(await optional(metadataPath)) as Owner; } catch { /* Older numeric lock. */ }
      let live = false;
      try { process.kill(pid, 0); live = true; }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') throw cause; }
      const current = live ? await identity(pid) : {};
      // Kernel ownership excludes another upgraded Agent even across PID
      // namespaces. Legacy owners remain protected unless demonstrably stale.
      const staleOwner = owner?.version === 1 && owner.pid === pid && Boolean(guard ||
        owner.start && current.start && owner.start !== current.start ||
        owner.namespace && current.namespace && owner.namespace !== current.namespace);
      if (live && pid !== process.pid && !staleOwner) throw failure('AGENT_DATA_DIRECTORY_BUSY');
      await rm(path);
      lock = await publishLock(path);
    }
    mine = { version: 1, pid: process.pid, instance, ...await identity(process.pid) };
    await writeFile(metadataPath, JSON.stringify(mine), { mode: 0o600 });
    const ownedFile = await lock.stat();
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try {
        // Never unlink a successor's metadata after an external replacement.
        const current = await stat(path).catch(() => undefined);
        if (current?.ino === ownedFile.ino && current?.dev === ownedFile.dev) {
          await rm(path, { force: true });
          const owner = await optional(metadataPath);
          if (owner === JSON.stringify(mine)) await rm(metadataPath, { force: true });
        }
      } finally { await lock?.close(); await guard?.close(); active.delete(key); }
    };
  } catch (error) {
    if (lock) { await lock.close(); await rm(path, { force: true }); }
    await guard?.close(); active.delete(key); throw error;
  }
}
