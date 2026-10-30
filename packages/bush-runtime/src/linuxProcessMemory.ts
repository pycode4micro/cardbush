import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

type ProcessIdentity = { pid: number; parent: number; group: number; start: string };

/** Read-only accounting for known process trees. RSS may count shared pages
 * twice, so this stays conservative; it never increases a host memory limit. */
export class LinuxProcessMemory {
  readonly #roots = new Map<string, ProcessIdentity>();
  constructor(readonly proc = '/proc', readonly ownerPid = process.pid) {}
  #identity(pid: number): ProcessIdentity | undefined {
    try {
      const stat = readFileSync(join(this.proc, String(pid), 'stat'), 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      const parent = Number(fields[1]), group = Number(fields[2]), start = fields[19];
      if (!Number.isSafeInteger(parent) || !Number.isSafeInteger(group) || !/^\d+$/.test(start ?? '')) throw Error('Invalid process identity.');
      return { pid, parent, group, start };
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  track(id: string, pid: number) {
    if (this.#roots.has(id)) throw Error('Process admission is already associated with a process.');
    const root = this.#identity(pid); if (!root) return; // Already exited.
    let cursor: ProcessIdentity | undefined = root;
    for (let depth = 0; depth < 64 && cursor; depth++) {
      if (cursor.parent === this.ownerPid) { this.#roots.set(id, root); return; }
      if (cursor.parent <= 1 || cursor.parent === cursor.pid) break;
      cursor = this.#identity(cursor.parent);
    }
    throw Error('Resource accounting only accepts a child of this host.');
  }
  release(id: string) { this.#roots.delete(id); }
  sample(): Array<{ id: string; memoryBytes: number }> | undefined {
    if (!this.#roots.size) return [];
    try {
      const pids = readdirSync(this.proc).filter(name => /^\d+$/.test(name));
      if (pids.length > 32768) return undefined;
      const processes = new Map<number, ProcessIdentity>();
      for (const pid of pids) {
        try { const value = this.#identity(Number(pid)); if (value) processes.set(value.pid, value); }
        catch (error) { if (!['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
      }
      const jobs: Array<{ id: string; memoryBytes: number }> = [];
      const counted = new Set<number>();
      for (const [id, root] of this.#roots) {
        const current = processes.get(root.pid);
        if (!current || current.start !== root.start) continue; // Never credit a reused PID.
        let memoryBytes = 0;
        for (const process of processes.values()) {
          let cursor: ProcessIdentity | undefined = process;
          for (let depth = 0; depth < 64 && cursor; depth++) {
            if (cursor.pid === root.pid || root.group === root.pid && cursor.group === root.group) {
              if (!counted.has(process.pid)) {
                try {
                  const status = readFileSync(join(this.proc, String(process.pid), 'status'), 'utf8');
                  const rss = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
                  // Zombies have no RSS. Other missing measurements fail closed.
                  if (!rss && !/^State:\s+Z/m.test(status)) throw Error('Process memory unavailable.');
                  memoryBytes += rss ? Number(rss[1]) * 1024 : 0;
                  counted.add(process.pid);
                } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
              }
              break;
            }
            if (cursor.parent <= 1 || cursor.parent === cursor.pid) break;
            cursor = processes.get(cursor.parent);
          }
        }
        jobs.push({ id, memoryBytes });
      }
      return jobs;
    } catch { return undefined; } // Retain reservations when measurements are unavailable.
  }
}
