import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { resolveProcessResourceHost } from './processResourceGuard.js';

export const pathChanged = () => Object.assign(new Error('The authorized file or directory changed. No redirected target is authorized; inspect the current path and retry.'), { code: 'workspace_authorization_changed' });

/** Keep directory identities stable through actual I/O, not just another realpath check. */
export class WorkspacePathGuard {
  readonly #directories = new Map<string, FileHandle | undefined>();
  #child?: ChildProcessWithoutNullStreams;
  #lines?: AsyncIterator<string>;
  #closed?: Promise<void>;
  #error = '';
  #queue: Promise<unknown> = Promise.resolve();

  async pin(path: string): Promise<void> {
    const work = this.#queue.then(() => this.#pin(resolve(path)));
    this.#queue = work.catch(() => {});
    return work;
  }

  async #pin(path: string): Promise<void> {
    if (this.#directories.has(path)) { this.check(); return; }
    if (process.platform === 'win32') {
      if (!this.#child) {
        // Fixed metadata-only helper: no model command, ACL edits or user code.
        const child = this.#child = spawn(resolveProcessResourceHost(), ['--workspace-path-guard', String(process.pid)], { windowsHide: true, stdio: 'pipe' });
        this.#closed = new Promise(resolve => child.once('close', () => resolve()));
        child.on('error', error => { this.#error = error.message; });
        child.stdin.on('error', error => { this.#error = error.message; });
        child.stderr.on('data', bytes => { this.#error = (this.#error + String(bytes)).slice(-4096); });
        this.#lines = createInterface({ input: child.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
        try {
          if ((await this.#reply()).workspacePathGuardVersion !== 1) throw pathChanged();
        } catch {
          throw Object.assign(new Error('The native file-access guard is unavailable. Rebuild or reinstall the matching Runtime; no file operation was started.'), { code: 'workspace_path_guard_unavailable' });
        }
      }
      this.check();
      this.#child.stdin.write(JSON.stringify(path) + '\n');
      if ((await this.#reply()).pinned !== true) throw pathChanged();
      this.#directories.set(path, undefined);
    } else if (process.platform === 'linux') {
      const parent = dirname(path);
      if (parent !== path) await this.#pin(parent);
      const handle = await open(parent === path ? path : join(this.directory(parent), basename(path)),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      if (!(await handle.stat()).isDirectory()) { await handle.close(); throw pathChanged(); }
      this.#directories.set(path, handle);
    } else {
      throw Object.assign(new Error('Race-safe local file access is unavailable on this platform.'), { code: 'workspace_path_guard_unavailable' });
    }
  }

  async #reply(): Promise<Record<string, unknown>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const line = await Promise.race([this.#lines!.next(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(pathChanged()), 10_000);
      })]);
      if (line.done || line.value.length > 4096) throw pathChanged();
      return JSON.parse(line.value);
    } finally { clearTimeout(timer); }
  }

  check() {
    if (this.#child && (this.#child.exitCode !== null || this.#child.signalCode !== null || this.#error)) throw pathChanged();
  }

  directory(path: string): string {
    this.check();
    path = resolve(path);
    if (!this.#directories.has(path)) throw pathChanged();
    return process.platform === 'linux' ? `/proc/self/fd/${this.#directories.get(path)!.fd}` : path;
  }

  file(path: string): string {
    if (parse(path).root === path) return this.directory(path);
    return join(this.directory(dirname(path)), basename(path));
  }

  async close() {
    await this.#queue;
    if (this.#child) {
      this.#child.stdin.end();
      const timer = setTimeout(() => this.#child!.kill(), 2000);
      try { await this.#closed; } finally { clearTimeout(timer); }
    }
    for (const handle of [...this.#directories.values()].reverse()) await handle?.close();
  }
}
