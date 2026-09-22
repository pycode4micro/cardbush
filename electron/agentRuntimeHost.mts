import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { BUSH_RUNTIME_IPC_PROTOCOL, decodeRuntimeIpcOutboundMessage, type RuntimeIpcOutboundMessage } from '@cardbush/bush-protocol';
import { ElectronRuntimeTransport, type ElectronRuntimeBridge } from '@cardbush/bush-runtime-electron';
import { handleMcpHostRequest, isMcpHostMessage, type McpHostOperation } from './mcpHostBridge.js';

/** Node host for the shared Runtime; never imports or launches Electron. */
export class AgentRuntimeHost implements ElectronRuntimeBridge {
  readonly transport = new ElectronRuntimeTransport(this);
  readonly #listeners = new Set<(message: unknown) => void>();
  readonly #pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  readonly #hostRequests = new Map<string, AbortController>();
  readonly #worker: Worker;
  readonly ready: Promise<RuntimeIpcOutboundMessage>;
  #failure?: Error;
  #closing = false;

  constructor(env: NodeJS.ProcessEnv, handle: (operation: McpHostOperation, payload: unknown, signal: AbortSignal) => Promise<unknown>) {
    this.#worker = new Worker(new URL('./runtimeHostWorker.mjs', import.meta.url), { env, stdout: true, stderr: true });
    // Keep worker diagnostics together on the service's stderr.
    this.#worker.stdout.on('data', chunk => process.stderr.write(chunk));
    this.#worker.stderr.on('data', chunk => process.stderr.write(chunk));
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { const error = new Error('Agent Runtime startup timed out.'); reject(error); this.#fail(error); void this.#worker.terminate(); }, 30_000);
      this.#worker.on('message', (input: unknown) => {
        if (isMcpHostMessage(input)) {
          if (input.type === 'cancel') { this.#hostRequests.get(input.id)?.abort(); return; }
          if (input.type === 'request') {
            const abort = new AbortController();
            this.#hostRequests.set(input.id, abort);
            void handleMcpHostRequest(input, abort.signal, handle).then(result => {
              if (!this.#failure) this.#worker.postMessage(result);
            }).finally(() => this.#hostRequests.delete(input.id));
          }
          return;
        }
        try {
          const message = decodeRuntimeIpcOutboundMessage(input);
          if (message.type === 'ready') { clearTimeout(timer); resolve(message); }
          else if (message.type === 'command_response') {
            this.#pending.get(message.operationId)?.resolve(message);
            this.#pending.delete(message.operationId);
          } else if (message.type === 'stream_frame') {
            for (const listener of this.#listeners) listener(message);
          } else { this.#fail(new Error(message.error.message)); }
        } catch (error) { clearTimeout(timer); reject(error); this.#fail(error as Error); }
      });
      this.#worker.on('error', error => { clearTimeout(timer); reject(error); this.#fail(error instanceof Error ? error : new Error(String(error))); });
      this.#worker.on('exit', code => {
        clearTimeout(timer);
        const error = new Error(`Agent Runtime exited (${code}).`);
        reject(error); this.#fail(error);
      });
    });
  }

  #fail(error: Error) {
    this.#failure = error;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    for (const request of this.#hostRequests.values()) request.abort();
    this.#hostRequests.clear();
    for (const listener of this.#listeners) listener({ protocol: BUSH_RUNTIME_IPC_PROTOCOL, type: 'protocol_error', error: {
      protocol: 'bush.runtime_error.v1', kind: 'transport', code: 'agent_runtime_exited', message: error.message, retryable: false, details: {},
    } });
  }
  async command(message: unknown): Promise<unknown> {
    await this.ready;
    if (this.#failure) throw this.#failure;
    const id = (message as { operationId: string }).operationId;
    if (this.#pending.has(id)) throw new Error('Duplicate Runtime operation ID.');
    return new Promise((resolve, reject) => { this.#pending.set(id, { resolve, reject }); this.#worker.postMessage(message); });
  }
  /** Explicit cancellation reaches admission and execution, but the queue waits
   * for the worker's acknowledgement instead of abandoning its RPC promise. */
  async runOwnedCommand(command: { kind: string; payload: unknown }, signal: AbortSignal): Promise<unknown> {
    await this.ready; signal.throwIfAborted();
    const operationId = randomUUID();
    const response = this.command({ protocol: BUSH_RUNTIME_IPC_PROTOCOL, type: 'command', operationId, command });
    const cancel = () => { void Promise.resolve().then(() => this.cancelOperation({ protocol: BUSH_RUNTIME_IPC_PROTOCOL, type: 'cancel_operation', operationId })).catch(() => undefined); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      if (signal.aborted) cancel();
      const result = decodeRuntimeIpcOutboundMessage(await response);
      if (result.type !== 'command_response') throw new Error('Invalid Agent Runtime command response.');
      if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
      return result.result;
    } finally { signal.removeEventListener('abort', cancel); }
  }
  async startStream(message: unknown) { await this.ready; if (this.#failure) throw this.#failure; this.#worker.postMessage(message); }
  async stopStream(message: unknown) { if (!this.#failure) this.#worker.postMessage(message); }
  async cancelOperation(message: unknown) { if (!this.#failure) this.#worker.postMessage(message); }
  onStreamFrame(listener: (message: unknown) => void) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  async close() {
    if (this.#closing) return;
    this.#closing = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.command({ protocol: BUSH_RUNTIME_IPC_PROTOCOL, type: 'command', operationId: randomUUID(), command: { kind: 'runtime.shutdown', payload: {} } }),
      new Promise(resolve => { timer = setTimeout(resolve, 7_000); }),
    ]).catch(() => undefined);
    clearTimeout(timer);
    await this.#worker.terminate();
  }
}
