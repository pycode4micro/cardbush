import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export interface ResourceSample {
  availableMemoryBytes: number;
  availableCommitBytes: number;
  totalMemoryBytes: number;
  jobs: Array<{ id: string; memoryBytes: number }>;
}

/** One small native sampler per governor, alive only while owned jobs exist.
 * It queries known Job Objects, never scans host processes or reads MCP streams. */
export class ProcessResourceObserver {
  #child?: ChildProcessWithoutNullStreams;
  #timer?: ReturnType<typeof setInterval>;
  #warmup?: ReturnType<typeof setTimeout>;
  #ids: string[] = [];
  #buffer = '';
  #pendingAt = 0;
  constructor(readonly group: string, readonly hostPath: () => string, readonly onSample: (sample: ResourceSample) => void) {}

  track(ids: string[]): void {
    this.#ids = ids;
    if (!ids.length) {
      clearInterval(this.#timer); this.#timer = undefined;
      clearTimeout(this.#warmup); this.#warmup = undefined;
      const child = this.#child; this.#child = undefined;
      child?.stdin.end();
      return;
    }
    if (!this.#timer) {
      // Short commands often finish before the first sample is useful. Their
      // kernel caps and startup reservations already protect this interval.
      this.#warmup = setTimeout(() => { this.#warmup = undefined; this.#tick(); }, 500);
      this.#warmup.unref();
      this.#timer = setInterval(() => this.#tick(), 2_000);
      this.#timer.unref();
    }
  }

  relieve(id: string): boolean {
    if (!this.#ids.includes(id) || !this.#child?.stdin.writable) return false;
    this.#child.stdin.write(`relieve\t${id}\n`);
    return true;
  }

  #tick(): void {
    if (!this.#ids.length) return;
    if (!this.#child) {
      try {
        const child = spawn(this.hostPath(), ['--observe', this.group], { windowsHide: true, stdio: 'pipe' });
        this.#child = child; this.#buffer = ''; this.#pendingAt = 0;
        const clear = () => { if (this.#child === child) this.#child = undefined; };
        child.once('error', clear); child.once('exit', clear);
        child.stdin.on('error', clear);
        child.stderr.resume();
        child.stdout.on('data', (chunk: Buffer) => {
          if (this.#child !== child) return;
          this.#buffer += chunk.toString('utf8');
          if (this.#buffer.length > 65_536) { child.kill(); return; }
          let newline: number;
          while ((newline = this.#buffer.indexOf('\n')) >= 0) {
            const line = this.#buffer.slice(0, newline); this.#buffer = this.#buffer.slice(newline + 1);
            try {
              const sample = JSON.parse(line) as ResourceSample;
              if (![sample.availableMemoryBytes, sample.availableCommitBytes, sample.totalMemoryBytes].every(validBytes)
                || !Array.isArray(sample.jobs) || sample.jobs.length > 256
                || sample.jobs.some(job => !/^[a-f0-9-]{36}$/i.test(job.id) || !validBytes(job.memoryBytes))) continue;
              this.#pendingAt = 0; this.onSample({ ...sample, jobs: sample.jobs.filter(job => this.#ids.includes(job.id)) });
            } catch { /* Bad/missing samples never grant more memory. */ }
          }
        });
      } catch { return; }
    }
    if (this.#pendingAt && Date.now() - this.#pendingAt > 5_000) { this.#child.kill(); return; }
    if (this.#pendingAt) return;
    this.#pendingAt = Date.now();
    this.#child.stdin.write(`sample\t${this.#ids.join(',')}\n`);
  }
}

function validBytes(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }
