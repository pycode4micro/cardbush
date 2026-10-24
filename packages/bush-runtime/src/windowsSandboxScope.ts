import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export interface WindowsSandboxScopeReference { policyPath: string; processId: number }
interface Entry {
  key: string; roots: string[]; users: number; dead: boolean; closing: boolean; reusable: boolean;
  timer?: NodeJS.Timeout; lastUsed: number;
  ready: Promise<{ reference: WindowsSandboxScopeReference; child: ChildProcessWithoutNullStreams; done: Promise<void> }>;
}

/** Host-only ACL leases. Reuse a capability, never a command's AppContainer identity.
 * Exact canonical read/write scopes are keyed separately; a command receives only
 * its admitted capability. Private directories and network stay command-local.
 */
export class WindowsSandboxScopePool {
  readonly #entries = new Map<string, Entry>();
  readonly #live = new Set<Entry>();
  readonly #retiring = new Set<Promise<void>>();
  readonly #cleanups = new Set<Promise<void>>();
  readonly #errors: unknown[] = [];
  #closed = false;
  constructor(readonly idleMs = 60_000, readonly maxIdleScopes = 8) {}

  async acquire(host: string, readableRoots: string[], writableRoots: string[]) {
    if (this.#closed) throw Error('Sandbox scope pool is closed.');
    const read = [...readableRoots].sort(), write = [...writableRoots].sort();
    const key = JSON.stringify([host, read, write]);
    let entry = this.#entries.get(key);
    if (!entry || entry.dead || entry.closing || !entry.reusable) {
      entry = { key, roots: [...read, ...write], users: 0, dead: false, closing: false, reusable: true, lastUsed: Date.now(), ready: undefined! };
      this.#entries.set(key, entry);
      this.#live.add(entry);
      entry.ready = this.#start(host, read, write, entry);
    }
    const current = entry;
    current.users++;
    clearTimeout(current.timer);
    let released = false;
    const release = () => {
      if (released) return;
      released = true; current.users--; current.lastUsed = Date.now();
      if (!current.users && !current.closing && !current.dead) {
        if (!current.reusable) { this.#retire(current); return; }
        current.timer = setTimeout(() => this.#retire(current), this.idleMs);
        current.timer.unref();
        const idle = [...this.#entries.values()].filter(e => !e.users).sort((a, b) => a.lastUsed - b.lastUsed);
        for (const old of idle.slice(0, Math.max(0, idle.length - this.maxIdleScopes))) this.#retire(old);
      }
    };
    try {
      const { reference } = await current.ready;
      if (current.dead || current.closing) throw Error('Sandbox directory authorization stopped before command admission.');
      return { reference, release, invalidate: () => { current.reusable = false; } };
    } catch (error) { release(); this.#retire(current); throw error; }
  }

  async releaseWithin(root: string): Promise<void> {
    for (const entry of this.#live) {
      if (entry.roots.some(path => within(root, path) || within(path, root))) {
        if (entry.users) throw Error('Cannot release sandbox authorization while a command is active.');
        this.#retire(entry);
      }
    }
    await this.#drain();
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const entry of this.#live) {
      if (entry.users) throw Error('Stop sandbox commands before closing their authorization pool.');
      this.#retire(entry);
    }
    await this.#drain();
  }

  async #drain() {
    await Promise.all([...this.#retiring]);
    await Promise.allSettled([...this.#cleanups]);
    if (this.#errors.length) throw new AggregateError(this.#errors.splice(0), 'Sandbox authorization cleanup failed.');
  }

  #retire(entry: Entry) {
    if (entry.closing) return;
    entry.closing = true; clearTimeout(entry.timer);
    if (this.#entries.get(entry.key) === entry) this.#entries.delete(entry.key);
    const pending = entry.ready.then(async ({ child, done }) => {
      child.ref();
      for (const stream of [child.stdin, child.stdout, child.stderr]) (stream as unknown as { ref?: () => void }).ref?.();
      if (!entry.dead) child.stdin.end('close\n');
      await done;
    }).catch(error => { this.#errors.push(error); }).finally(() => this.#retiring.delete(pending));
    this.#retiring.add(pending);
  }

  async #start(host: string, readableRoots: string[], writableRoots: string[], entry: Entry) {
    const temporary = await realpath(tmpdir());
    const directory = await realpath(await mkdtemp(join(temporary, 'cardbush-scope-')));
    const policyPath = join(directory, 'policy.json');
    let launched = false;
    try {
      if ([...readableRoots, ...writableRoots].some(root => within(root, directory))) throw Error('Sandbox authorization state is inside a granted directory.');
      await writeFile(policyPath, JSON.stringify({ version: 1, ownerPid: process.pid,
        capability: `CardBush.Scope.${randomUUID().replaceAll('-', '')}`, readableRoots, writableRoots }), { flag: 'wx', mode: 0o600 });
      // Native setup happens asynchronously. The command supervisor waits for its
      // ready receipt while terminal_exec can already return a tracked handle.
      // libuv puts ordinary Windows children in its kill-on-parent-exit job.
      // The trusted revoker must outlive that job long enough to undo ACLs;
      // its pinned owner handle/EOF, rather than user commands, owns this lifetime.
      const child = spawn(host, ['--sandbox-scope', policyPath], { detached: true, windowsHide: true, stdio: 'pipe' });
      launched = true;
      let diagnostics = '';
      child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-4096); });
      child.stdout.resume();
      child.stdin.on('error', () => { /* Exit/receipt determines cleanup, not a racing pipe close. */ });
      const exited = new Promise<void>(resolve => { child.once('exit', () => resolve()); child.once('error', () => resolve()); });
      const done = exited.then(async () => {
        this.#cleanups.add(done);
        this.#live.delete(entry);
        entry.dead = true;
        if (this.#entries.get(entry.key) === entry) this.#entries.delete(entry.key);
        clearTimeout(entry.timer);
        let cleaned = false;
        try { cleaned = JSON.parse(await readFile(policyPath + '.finished', 'utf8')).cleaned === true; } catch { /* Repair interrupted native cleanup. */ }
        if (!cleaned) {
          try { await execFileAsync(host, ['--sandbox-scope-cleanup', policyPath], { windowsHide: true, timeout: 120_000, maxBuffer: 4096 }); }
          catch { throw Error(`Sandbox authorization cleanup failed. Recovery journal: ${policyPath}. ${diagnostics}`); }
        }
        if (dirname(directory).toLowerCase() !== temporary.toLowerCase() || !basename(directory).startsWith('cardbush-scope-')) throw Error('Unexpected sandbox authorization directory.');
        await rm(directory, { recursive: true, force: true });
      }).finally(() => this.#cleanups.delete(done));
      // An idle cache must not keep Runtime alive; the native owner handle and
      // stdin EOF still revoke ACLs if Runtime exits without a graceful close.
      child.unref();
      for (const stream of [child.stdin, child.stdout, child.stderr]) (stream as unknown as { unref?: () => void }).unref?.();
      void done.catch(error => { if (!entry.closing) this.#errors.push(error); });
      if (!child.pid) { await done; throw Error('Sandbox authorization supervisor could not start.'); }
      return { reference: { policyPath, processId: child.pid }, child, done };
    } catch (error) {
      entry.dead = true;
      this.#live.delete(entry);
      if (this.#entries.get(entry.key) === entry) this.#entries.delete(entry.key);
      if (!launched && dirname(directory).toLowerCase() === temporary.toLowerCase() && basename(directory).startsWith('cardbush-scope-')) {
        await rm(directory, { recursive: true, force: true });
      }
      // A native cleanup failure deliberately retains its journal.
      throw error;
    }
  }
}

function within(root: string, path: string): boolean {
  const value = relative(root, path);
  return !value || (value !== '..' && !value.startsWith('..\\') && !isAbsolute(value));
}

/** PowerShell probes parent directories when initializing C:\\, even when the
 * process cwd itself is authorized. A provider drive rooted at that cwd avoids
 * granting traversal/listing on any parent. Bootstrap errors stop before user code.
 */
export function sandboxPowerShellArgs(executable: string, args: string[]): string[] {
  if (!/^(?:powershell|pwsh)\.exe$/i.test(basename(executable))) return args;
  const command = args.findIndex(arg => /^-command$/i.test(arg));
  if (command < 0 || command !== args.length - 2) return args;
  const bootstrap = [
    'try {',
    '  $cardbushWorkingDirectory = [Environment]::CurrentDirectory',
    '  if ((Get-Location).ProviderPath.TrimEnd([char]92) -ine $cardbushWorkingDirectory.TrimEnd([char]92)) {',
    "    New-PSDrive -Name CardBushWorkspace -PSProvider FileSystem -Root $cardbushWorkingDirectory -Scope Global -ErrorAction Stop | Out-Null",
    "    Set-Location -LiteralPath 'CardBushWorkspace:\\' -ErrorAction Stop",
    '  }',
    '  if ((Get-Location).ProviderPath.TrimEnd([char]92) -ine $cardbushWorkingDirectory.TrimEnd([char]92)) { throw "Sandbox working directory mismatch" }',
    '} catch { [Console]::Error.WriteLine("Sandbox working directory initialization failed: " + $_.Exception.Message); exit 1 }',
  ].join('\n');
  return [...args.slice(0, -1), bootstrap + '\n' + args.at(-1)];
}
