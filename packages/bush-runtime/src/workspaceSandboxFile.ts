import { type BigIntStats, type Stats } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { resolveProcessResourceHost, spawnResourceManagedProcess, type GuardedProcess } from './processResourceGuard.js';
import { verifyFileSandboxBackend, type ExecutionSandboxPolicy } from './executionSandbox.js';
import { workspaceFileWorkerMain } from './workspaceFileWorker.js';
import { processExecutionDeadline } from './processExecutionDeadline.js';

// Auxiliary I/O must queue rather than exhaust the terminal process budget when
// images or evidence files are ingested concurrently. Resource admission still
// runs for every child; this does not retry a rejected backend on the host.
let activeWorkers = 0;
const waitingWorkers: Array<() => void> = [];
function reserveFileWorker(signal?: AbortSignal): Promise<() => void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { const index = waitingWorkers.indexOf(grant); if (index >= 0) waitingWorkers.splice(index, 1); reject(signal!.reason); };
    const grant = () => {
      signal?.removeEventListener('abort', abort); activeWorkers++;
      let released = false;
      resolve(() => { if (released) return; released = true; activeWorkers--; waitingWorkers.shift()?.(); });
    };
    if (activeWorkers < 2) grant();
    else {
      if (waitingWorkers.length >= 256) { reject(Object.assign(Error('The bounded file worker queue is full. Wait for existing operations to finish.'), { code: 'resource_io_capacity_busy' })); return; }
      waitingWorkers.push(grant); signal?.addEventListener('abort', abort, { once: true });
    }
  });
}

export async function verifyWorkspaceFileSandbox(linuxExecutable?: string) {
  await verifyFileSandboxBackend(process.platform === 'win32' ? resolveProcessResourceHost() : undefined, linuxExecutable);
}

/** A FileHandle-shaped transport. No content is read or written by the host. */
export class SandboxFileHandle {
  #lines: AsyncIterator<string>;
  #stderr = '';
  #failure?: Error;
  #close?: Promise<void>;
  #offset = 0;
  private constructor(readonly process: GuardedProcess, readonly expectedHash: string | undefined, readonly release: () => void) {
    this.#lines = createInterface({ input: process.child.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
    process.child.stderr.on('data', bytes => { this.#stderr = (this.#stderr + String(bytes)).slice(-4096); });
    process.child.on('error', error => { this.#failure = error; });
    process.child.stdin.on('error', error => { this.#failure = error; });
  }

  static async open(path: string, identity: string, write: boolean, expectedHash?: string, signal?: AbortSignal, linuxExecutable?: string, deleting = false) {
    const release = await reserveFileWorker(signal);
    try {
    const executable = await realpath(process.platform === 'win32' ? resolveProcessResourceHost() : process.execPath);
    const policy: ExecutionSandboxPolicy = { readableRoots: [], writableRoots: [],
      readableFiles: [executable, ...(!write ? [path] : [])], writableFiles: write ? [path] : [],
      ...(deleting ? { deletableFiles: [path] } : {}),
      network: 'disabled', privateWorkingDirectory: true, requireCanonicalRoots: true, expectedIdentities: { [path]: identity }, linuxExecutable };
    const managed = await spawnResourceManagedProcess({ executable,
      args: process.platform === 'win32' ? ['--workspace-file-worker'] : ['--input-type=module', '-e', `(${workspaceFileWorkerMain.toString()})()`],
      cwd: dirname(path), sandbox: policy, signal, lifetime: 'io' });
    const handle = new SandboxFileHandle(managed, expectedHash, release);
    try { await handle.request({ op: 'open', path, identity, write, deleting }); return handle; }
    catch (error) { managed.stop(); await handle.#complete(); throw error; }
    } catch (error) { release(); throw error; }
  }

  async request(input: Record<string, unknown>): Promise<any> {
    let cancelDeadline: (() => void) | undefined;
    try {
      if (this.#failure) throw this.#failure;
      this.process.child.stdin.write(JSON.stringify(input) + '\n');
      const next = await Promise.race([this.#lines.next(), new Promise<never>((_, reject) => {
        cancelDeadline = processExecutionDeadline(this.process, 30_000, error => {
          this.process.stop();
          reject(error.code === 'process_timeout' ? Object.assign(Error('Sandbox file worker timed out.'), { code: 'sandbox_file_timeout' }) : error);
        });
      })]);
      if (next.done) {
        const report = await this.process.complete();
        throw Object.assign(Error(report?.message || this.#stderr || 'Sandbox file worker exited without a result.'), { code: report?.code || 'sandbox_file_worker_failed' });
      }
      if (next.value.length > 128 * 1024) throw Error('Sandbox file response exceeded its budget.');
      const response = JSON.parse(next.value);
      if (response.ok !== true) throw Object.assign(Error(response.message ?? 'Sandbox file operation failed.'), { code: response.code ?? 'sandbox_file_io_failed' });
      return response.result;
    } catch (error) { this.#failure = error as Error; this.process.stop(); throw error; }
    finally { cancelDeadline?.(); }
  }

  async stat(): Promise<Stats>;
  async stat(options: { bigint: true }): Promise<BigIntStats>;
  async stat(options?: { bigint: true }): Promise<Stats | BigIntStats> {
    const value = await this.request({ op: 'stat' });
    const mtimeNs = BigInt(value.mtimeNs);
    return { ...Object.fromEntries(Object.entries(value).map(([key, item]) => [key, options?.bigint ? BigInt(String(item)) : Number(item)])),
      // Epoch nanoseconds exceed Number precision; split before converting, as native Stats does.
      mtimeMs: options?.bigint ? mtimeNs / 1_000_000n : Number(mtimeNs / 1_000_000_000n) * 1000 + Number(mtimeNs % 1_000_000_000n) / 1_000_000,
      isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false } as unknown as Stats | BigIntStats;
  }

  async read(buffer: Buffer, offset: number, length: number, position: number) {
    const bytes = Buffer.from(await this.request({ op: 'read', offset: position, count: Math.min(length, 65536) }), 'base64');
    bytes.copy(buffer, offset); return { buffer, bytesRead: bytes.length };
  }

  async *createReadStream(options: { autoClose?: boolean; signal?: AbortSignal; highWaterMark?: number } = {}) {
    let offset = 0;
    while (true) {
      options.signal?.throwIfAborted();
      const bytes = Buffer.from(await this.request({ op: 'read', offset, count: Math.min(options.highWaterMark ?? 65536, 65536) }), 'base64');
      if (!bytes.length) return;
      offset += bytes.length; yield bytes;
    }
  }

  async truncate(size: number) {
    if (size !== 0) throw Error('Only a full checked replacement is supported.');
    await this.request({ op: 'truncate', sha256: this.expectedHash }); this.#offset = 0;
  }
  async chmod(mode: number) {
    if (process.platform !== 'win32') await this.request({ op: 'chmod', mode });
  }
  async writeFile(data: string | Buffer, options?: { encoding?: BufferEncoding }) {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, options?.encoding);
    for (let offset = 0; offset < bytes.length; offset += 65536) {
      const chunk = bytes.subarray(offset, offset + 65536);
      await this.request({ op: 'write', data: chunk.toString('base64'), offset: this.#offset }); this.#offset += chunk.length;
    }
  }
  close() {
    return this.#close ??= (async () => {
      try { if (!this.#failure) await this.request({ op: 'close' }); }
      finally {
        this.process.child.stdin.end(); if (this.#failure) this.process.stop();
        try {
          const report = await this.#complete();
          if (report?.code && !this.#failure) throw Object.assign(Error(report.message), { code: report.code });
        } finally { this.release(); }
      }
    })();
  }

  #complete() {
    return new Promise<Awaited<ReturnType<GuardedProcess['complete']>>>((resolve, reject) => {
      const cancel = processExecutionDeadline(this.process, 30_000, error => { this.process.stop(); reject(error); });
      this.process.complete().then(value => { cancel(); resolve(value); }, error => { cancel(); reject(error); });
    });
  }
}
