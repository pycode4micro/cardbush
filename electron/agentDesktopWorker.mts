import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export interface DesktopWorker {
  readonly failure?: string;
  request(operation: string, input?: unknown): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

/** Private stdio only: no public X11, VNC, CDP or secondary authentication endpoint. */
export class AgentDesktopWorker implements DesktopWorker {
  readonly #child: ChildProcessWithoutNullStreams;
  #pending = new Map<string, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  #buffer = '';
  #failed?: Error;
  #closed = false;
  constructor(profile: string, env: NodeJS.ProcessEnv) {
    const workerEnv = { ...env };
    for (const key of Object.keys(workerEnv)) if (key.startsWith('CARDBUSH_')) delete workerEnv[key];
    this.#child = spawn(env.CARDBUSH_DESKTOP_PYTHON || 'python3', ['-u', fileURLToPath(new URL('../scripts/agent-desktop/worker.py', import.meta.url)), profile], {
      env: workerEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Never log page text, typed input or protocol payloads.
    this.#child.stderr.on('data', () => {});
    this.#child.stdin.on('error', () => this.#fail(new Error('Desktop connection was interrupted.')));
    this.#child.stdout.setEncoding('utf8');
    this.#child.stdout.on('data', (chunk: string) => {
      if (this.#failed) return;
      this.#buffer += chunk;
      if (this.#buffer.length > 16 * 1024 * 1024) { this.#fail(new Error('Desktop response exceeded its limit.')); return; }
      let newline: number;
      while ((newline = this.#buffer.indexOf('\n')) >= 0) {
        const line = this.#buffer.slice(0, newline); this.#buffer = this.#buffer.slice(newline + 1);
        try {
          const result = JSON.parse(line);
          const pending = this.#pending.get(result.id);
          if (!pending) continue;
          clearTimeout(pending.timer); this.#pending.delete(result.id);
          if (result.error) pending.reject(new Error(String(result.error)));
          else if (result.value && typeof result.value === 'object') pending.resolve(result.value);
          else pending.reject(new Error('Invalid desktop response.'));
        } catch { this.#fail(new Error('Invalid desktop protocol.')); }
      }
    });
    this.#child.on('error', () => this.#fail(new Error('Could not start the optional Linux desktop worker.')));
    this.#child.on('exit', () => this.#fail(new Error('Linux desktop worker exited. Restart the Personal Agent to recover.')));
  }
  #fail(error: Error) {
    this.#failed ??= error;
    this.#buffer = '';
    for (const item of this.#pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.#pending.clear();
  }
  get failure() { return this.#failed?.message; }
  request(operation: string, input: unknown = {}): Promise<Record<string, unknown>> {
    if (this.#failed || this.#closed) return Promise.reject(this.#failed || new Error('Desktop is closed.'));
    if (this.#pending.size) return Promise.reject(new Error('Desktop worker requests must be serialized.'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Outcome is uncertain; quarantine this worker. Never replay a click/navigation.
        this.#fail(new Error('Desktop operation timed out; outcome unknown. Restart the Personal Agent before further control.'));
      }, operation === 'initialize' ? 30_000 : 15_000);
      this.#pending.set(id, { resolve, reject, timer });
      this.#child.stdin.write(JSON.stringify({ id, operation, input }) + '\n', error => { if (error) this.#fail(new Error('Desktop connection was interrupted.')); });
    });
  }
  async close() {
    if (this.#closed) return;
    this.#closed = true; this.#fail(new Error('Desktop is stopping.'));
    this.#child.stdin.end();
    if (this.#child.exitCode !== null) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { this.#child.kill('SIGKILL'); resolve(); }, 5000);
      this.#child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}
