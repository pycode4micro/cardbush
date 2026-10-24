/** Interpreter-reported facts only. Never used to grant access, automatically
 * retry a command, or assert that a command had no effects. */
export interface TerminalShellDiagnostic {
  source: 'powershell';
  phase: 'working_directory' | 'command';
  permissionDenied: boolean;
  category: string;
  exceptionType: string;
}

export class TerminalDiagnosticStream {
  readonly #prefix: Buffer;
  #pending: Buffer = Buffer.alloc(0);
  constructor(token: string, readonly emit: (chunk: Buffer) => void,
    readonly report: (diagnostic: TerminalShellDiagnostic) => void) {
    this.#prefix = Buffer.from(`\x1e${token}:`);
  }
  write(chunk: Buffer): void {
    this.#pending = Buffer.concat([this.#pending, chunk]);
    while (this.#pending.length) {
      const start = this.#pending.indexOf(this.#prefix);
      if (start < 0) {
        let retained = Math.min(this.#pending.length, this.#prefix.length - 1);
        while (retained && !this.#pending.subarray(-retained).equals(this.#prefix.subarray(0, retained))) retained--;
        const safe = this.#pending.length - retained;
        if (safe) { this.emit(this.#pending.subarray(0, safe)); this.#pending = this.#pending.subarray(safe); }
        return;
      }
      if (start > 0) { this.emit(this.#pending.subarray(0, start)); this.#pending = this.#pending.subarray(start); }
      const end = this.#pending.indexOf(31, this.#prefix.length);
      if (end < 0 && this.#pending.length <= 4096) return;
      if (end >= 0 && end <= 4096) {
        try {
          const value = JSON.parse(this.#pending.subarray(this.#prefix.length, end).toString('utf8'));
          if (value.source === 'powershell' && ['working_directory', 'command'].includes(value.phase) &&
              typeof value.permissionDenied === 'boolean' && typeof value.category === 'string' && typeof value.exceptionType === 'string') {
            this.report({ source: 'powershell', phase: value.phase, permissionDenied: value.permissionDenied,
              category: value.category.slice(0, 128), exceptionType: value.exceptionType.slice(0, 256) });
            this.#pending = this.#pending.subarray(end + 1); continue;
          }
        } catch { /* Malformed frames remain ordinary stderr, losslessly. */ }
      }
      this.emit(this.#pending.subarray(0, this.#prefix.length));
      this.#pending = this.#pending.subarray(this.#prefix.length);
    }
  }
  flush(): void {
    if (this.#pending.length) this.emit(this.#pending);
    this.#pending = Buffer.alloc(0);
  }
}
