import { spawnResourceManagedProcess, type ManagedProcessOptions, type ManagedProcessScope } from './processResourceGuard.js';
import { decodeCommandOutput } from '@cardbush/platform';

/** A shared byte budget for both streams. Eviction happens before retaining a chunk. */
export class BoundedProcessOutput {
  readonly #chunks: Array<{ channel: 'stdout' | 'stderr'; data: Buffer }> = [];
  #size = 0;
  truncated = false;
  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('Invalid process output limit.');
  }
  get sizeBytes() { return this.#size; }
  append(channel: 'stdout' | 'stderr', value: Buffer): void {
    if (value.length === 0) return;
    let excess = this.#size + value.length - this.limit;
    if (excess > 0) this.truncated = true;
    while (excess > 0 && this.#chunks.length) {
      const first = this.#chunks[0];
      const removed = Math.min(excess, first.data.length);
      if (removed === first.data.length) this.#chunks.shift();
      else first.data = Buffer.from(first.data.subarray(removed));
      this.#size -= removed;
      excess -= removed;
    }
    const data = Buffer.from(value.subarray(Math.max(0, value.length - this.limit)));
    this.#chunks.push({ channel, data });
    this.#size += data.length;
  }
  text(channel: 'stdout' | 'stderr'): string {
    return decodeCommandOutput(Buffer.concat(this.#chunks.filter(chunk => chunk.channel === channel).map(chunk => chunk.data)));
  }
}

export interface ManagedCommandOptions extends ManagedProcessOptions {
  scope?: ManagedProcessScope;
  input?: string | Buffer;
  timeoutMs?: number;
  maxOutputBytes?: number;
  outputLimit?: 'terminate' | 'truncate';
}

/** Short-lived commands only. Persistent terminals use spawn and their owner's lifetime. */
export async function runResourceManagedCommand(input: ManagedCommandOptions) {
  const output = new BoundedProcessOutput(input.maxOutputBytes ?? 256 * 1024);
  const managed = await (input.scope ? input.scope.spawn(input) : spawnResourceManagedProcess(input));
  return new Promise<{ stdout: string; stderr: string; exitCode: number | null; outputTruncated: boolean }>((resolve, reject) => {
    let failure: Error | undefined;
    const fail = (error: Error) => { failure ??= error; managed.stop(); };
    const timer = input.timeoutMs === undefined ? undefined : setTimeout(() => {
      fail(Object.assign(new Error(`Command timed out after ${input.timeoutMs} ms.`), { code: 'process_timeout' }));
    }, input.timeoutMs);
    for (const channel of ['stdout', 'stderr'] as const) managed.child[channel].on('data', (chunk: Buffer) => {
      if (failure) return;
      output.append(channel, chunk);
      if (output.truncated && input.outputLimit !== 'truncate') {
        fail(Object.assign(new Error(`Process output exceeded ${output.limit} bytes.`), { code: 'process_output_limit' }));
      }
    });
    managed.child.once('error', fail);
    managed.child.stdin.on('error', error => {
      // Commands may intentionally exit without reading all stdin.
      if ((error as NodeJS.ErrnoException).code !== 'EPIPE') fail(error);
    });
    managed.child.once('close', async exitCode => {
      clearTimeout(timer);
      const report = await managed.complete();
      if (input.signal?.aborted) { reject(input.signal.reason); return; }
      if (!failure && report?.code) failure = Object.assign(new Error(report.message), { code: report.code });
      if (failure) { reject(failure); return; }
      resolve({ stdout: output.text('stdout'), stderr: output.text('stderr'), exitCode, outputTruncated: output.truncated });
    });
    managed.child.stdin.end(input.input);
  });
}
