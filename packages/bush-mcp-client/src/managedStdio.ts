import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { ReadBuffer, serializeMessage, type JSONRPCMessage, type Transport } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, type StdioServerParameters } from '@modelcontextprotocol/client/stdio';
import { ManagedProcessScope, reserveProcessResources, type ProcessResourceLease, type GuardedProcess } from '@cardbush/bush-runtime/processes';

/** Keep the SDK's filtered inheritance, plus the Windows command/runtime essentials. */
export function stdioEnvironment(overrides: Record<string, string> = {}): Record<string, string> {
  const inherited = getDefaultEnvironment();
  if (process.platform !== 'win32') return { ...inherited, ...overrides };
  for (const name of ['PATHEXT', 'COMSPEC', 'WINDIR', 'TMP', 'PROGRAMDATA', 'ALLUSERSPROFILE']) {
    const value = process.env[name];
    if (value !== undefined && !value.startsWith('()')) inherited[name] = value;
  }
  // Windows names are case-insensitive; Node otherwise picks one of Path/PATH before spawn.
  const env: Record<string, string> = {};
  for (const source of [inherited, overrides]) {
    for (const [name, value] of Object.entries(source)) env[name.toUpperCase()] = value;
  }
  return env;
}

export class McpProcessError extends Error {
  constructor(message: string, readonly code: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'McpProcessError';
  }
}

/** Owns the server's entire process tree, including services spawned during tool calls. */
export class ManagedStdioClientTransport implements Transport {
  onclose?: Transport['onclose'];
  onerror?: Transport['onerror'];
  onmessage?: Transport['onmessage'];
  readonly stderr = new PassThrough();
  readonly #scope = new ManagedProcessScope();
  readonly #buffer: ReadBuffer;
  readonly #startup = new AbortController();
  readonly #stderrDecoder = new StringDecoder('utf8');
  #stderrTail = '';
  #process?: GuardedProcess;
  #starting?: Promise<void>;
  #closing?: Promise<void>;
  #closed = false;
  #notified = false;
  #lease?: ProcessResourceLease;
  #preparing?: Promise<void>;

  constructor(readonly parameters: StdioServerParameters, readonly shutdownGraceMs = 1_000) {
    this.#buffer = new ReadBuffer({ maxBufferSize: parameters.maxBufferSize });
  }

  /** Admission belongs before retiring an old service and outside handshake timeouts. */
  get resourceId(): string | undefined { return this.#process?.resourceId ?? this.#lease?.id; }

  prepare(signal?: AbortSignal, replace?: string): Promise<void> {
    if (this.#lease) return Promise.resolve();
    if (this.#closed) return Promise.reject(new Error('MCP transport is closed.'));
    return this.#preparing ??= (async () => {
      const combined = signal ? AbortSignal.any([signal, this.#startup.signal]) : this.#startup.signal;
      const lease = await reserveProcessResources('service', combined, replace);
      if (combined.aborted || this.#closed) { lease.release(); combined.throwIfAborted(); throw new Error('MCP transport is closed.'); }
      this.#lease = lease;
    })();
  }

  start(): Promise<void> {
    if (this.#starting || this.#closed) return Promise.reject(new Error('MCP transport is already started or closed.'));
    return this.#starting = this.#start();
  }

  async #start(): Promise<void> {
    const env = stdioEnvironment(this.parameters.env);
    let executable = this.parameters.command, args = this.parameters.args ?? [];
    if (process.platform === 'win32') {
      if (env.ELECTRON_RUN_AS_NODE !== undefined) env.CARDBUSH_MCP_ORIGINAL_NODE_MODE = env.ELECTRON_RUN_AS_NODE;
      env.ELECTRON_RUN_AS_NODE = '1';
      executable = process.execPath;
      args = [fileURLToPath(new URL('./stdioProcessEntry.js', import.meta.url)), this.parameters.command, ...args];
    }
    try {
      await this.prepare();
      const resourceLease = this.#lease!; this.#lease = undefined;
      const managed = await this.#scope.spawn({ executable, args, env, cwd: this.parameters.cwd ?? process.cwd(),
        signal: this.#startup.signal, lifetime: 'service', resourceLease });
      this.#process = managed;
      const child = managed.child;
      child.on('error', error => this.onerror?.(new McpProcessError(error.message,
        (error as NodeJS.ErrnoException).code ?? 'MCP_PROCESS_START_FAILED', { cause: error })));
      child.stdin.on('error', error => { if (!this.#closed) this.onerror?.(error); });
      child.stdout.on('error', error => this.onerror?.(error));
      child.stderr.pipe(this.stderr);
      child.stderr.on('data', (chunk: Buffer) => {
        this.#stderrTail = (this.#stderrTail + this.#stderrDecoder.write(chunk)).slice(-8_192);
      });
      child.stdout.on('data', (chunk: Buffer) => {
        try { this.#buffer.append(chunk); }
        catch (error) { this.onerror?.(asError(error)); void this.close(); return; }
        while (true) {
          try {
            const message = this.#buffer.readMessage();
            if (message === null) break;
            this.onmessage?.(message);
          } catch (error) { this.onerror?.(asError(error)); }
        }
      });
      child.once('close', (code, signal) => {
        void managed.complete().then(report => {
          this.#stderrTail = (this.#stderrTail + this.#stderrDecoder.end()).slice(-8_192);
          if (!this.#closed) {
            const reason = report?.code ? report.message
              : `MCP process exited ${signal ? `with signal ${signal}` : `with code ${code ?? 'unknown'}`}.`;
            this.onerror?.(new McpProcessError(this.#stderrTail.trim() ? `${reason}\n${this.#stderrTail.trim()}` : reason,
              report?.code || 'MCP_PROCESS_EXITED'));
          }
          this.#finish();
        });
      });
      if (this.#closed) { managed.stop(); await managed.complete(); throw new Error('MCP startup was cancelled.'); }
      // The protocol handshake, not a process PID, determines readiness.
      if (!child.pid) await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    } catch (error) {
      this.#startup.abort();
      this.#lease?.release(); this.#lease = undefined;
      await this.#scope.close();
      this.#finish();
      throw error;
    }
  }

  send(message: JSONRPCMessage): Promise<void> {
    const child = this.#process?.child;
    if (this.#closed || !child?.stdin.writable) return Promise.reject(new Error('MCP service is not connected.'));
    return new Promise((resolve, reject) => child.stdin.write(serializeMessage(message), error => error ? reject(error) : resolve()));
  }

  /** Idempotent: a timed-out SDK close must still await actual tree termination. */
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    return this.#closing = (async () => {
      const managed = this.#process;
      if (managed) {
        // Standard MCP shutdown begins with EOF; allow the server to flush/stop its services.
        managed.child.stdin.end();
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([managed.complete(), new Promise<void>(resolve => { timer = setTimeout(resolve, this.shutdownGraceMs); })]);
        clearTimeout(timer);
      }
      this.#startup.abort();
      await this.#preparing?.catch(() => undefined);
      this.#lease?.release(); this.#lease = undefined;
      await this.#scope.close();
      await this.#starting?.catch(() => undefined);
      this.#finish();
    })();
  }

  #finish(): void {
    this.#closed = true;
    this.#buffer.clear();
    if (!this.#notified) { this.#notified = true; this.onclose?.(); }
  }
}

function asError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }
