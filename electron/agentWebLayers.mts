import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

type Connection = { gateway: string; credential: string };
type Pending = { complete: (value: unknown) => void; fail: () => void };

export class AgentWebLayers {
  #child?: ChildProcessWithoutNullStreams;
  #pending = new Map<number, Pending>();
  #sequence = 0;
  #closed = false;

  constructor(readonly root: string) {}

  #start(connection: Connection) {
    const entry = resolve('deploy/web/plugins/volcengine_images/web_layer_worker.py');
    const child = spawn('/opt/cardbush-python/bin/python', ['-u', entry], {
      env: {
        LANG: 'C.UTF-8',
        PYTHONDONTWRITEBYTECODE: '1',
        ZHAOCAI_PERSONAL_ROOT: join(this.root, 'workspaces'),
        ZHAOCAI_IMAGE_STATE: join(this.root, 'plugin-state', 'images'),
        ZHAOCAI_IMAGE_GATEWAY: connection.gateway,
        ZHAOCAI_IMAGE_TOKEN: connection.credential,
      },
    });
    this.#child = child;
    const exited = () => {
      if (this.#child !== child) return;
      this.#child = undefined;
      for (const request of this.#pending.values()) request.fail();
    };
    child.once('error', exited);
    child.once('close', exited);
    child.stdin.on('error', () => {});
    child.stderr.resume();
    createInterface({ input: child.stdout }).on('line', line => {
      try {
        const { id, value } = JSON.parse(line);
        this.#pending.get(id)?.complete(value);
      } catch {
        child.kill();
      }
    });
    return child;
  }

  async call(input: Record<string, unknown>, connection: Connection) {
    await mkdir(join(this.root, 'workspaces'), { recursive: true });
    if (this.#closed || this.#pending.size >= 8) throw new Error('LAYER_SERVICE_UNAVAILABLE');
    const child = this.#child ?? this.#start(connection);
    const id = ++this.#sequence;
    return await new Promise((resolveValue, reject) => {
      const finish = () => { clearTimeout(timer); this.#pending.delete(id); };
      const fail = () => { finish(); reject(new Error('LAYER_SERVICE_UNAVAILABLE')); };
      const timer = setTimeout(fail, 50_000);
      this.#pending.set(id, { complete: value => { finish(); resolveValue(value); }, fail });
      child.stdin.write(JSON.stringify({ id, input }) + '\n', error => { if (error) fail(); });
    });
  }

  async close() {
    this.#closed = true;
    const child = this.#child;
    if (!child) return;
    const done = once(child, 'close').catch(() => {});
    child.stdin.end();
    const timeout = setTimeout(() => child.kill(), 5000);
    try { await done; } finally { clearTimeout(timeout); }
  }
}
