import { AsyncLocalStorage } from 'node:async_hooks';
import { Client, fromJsonSchema, type ClientOptions, type Implementation, type ElicitRequestParams, type ElicitResult } from '@modelcontextprotocol/client';

export async function validateMcpFormResponse(schema: Record<string, unknown>, value: unknown) {
  const result = await fromJsonSchema(schema)['~standard'].validate(value);
  if (result.issues) throw new Error(result.issues.map(issue => issue.message).join('; '));
}

export interface McpCallScope {
  serverId: string; sessionId: string; turnId: string; toolCallId?: string;
  signal?: AbortSignal;
}
export type McpElicitationHandler = (input: McpCallScope & { params: ElicitRequestParams }, signal: AbortSignal) => Promise<ElicitResult>;
type ActiveCall = { client: Client; scope: McpCallScope; deadline: ActiveDeadline };

/** Modern input_required responses carry the original request signal, even across HTTP callback contexts. */
export class ScopedMcpClient extends Client {
  constructor(info: Implementation, options: ClientOptions, private readonly calls: McpInteractiveCalls) { super(info, options); }
  protected override _resolveNonCompleteResult(decoded: Parameters<Client['_resolveNonCompleteResult']>[0], flow: Parameters<Client['_resolveNonCompleteResult']>[1]): Promise<unknown> {
    return this.calls.withOrigin(flow.options?.signal, () => super._resolveNonCompleteResult(decoded, flow));
  }
}

/** Legacy requests have no parent call identifier: serialize that connection to preserve ownership. */
export class McpInteractiveCalls {
  readonly #scope = new AsyncLocalStorage<ActiveCall>();
  readonly #active = new WeakMap<Client, ActiveCall>();
  readonly #queues = new WeakMap<Client, Promise<unknown>>();
  readonly #signals = new WeakMap<AbortSignal, ActiveCall>();
  constructor(private readonly elicit?: McpElicitationHandler) {}
  prepare(client: Client) {
    if (!this.elicit) return;
    client.registerCapabilities({ elicitation: { form: {}, url: {} } });
    client.setRequestHandler('elicitation/create', async (request, context) => {
      const active = this.#scope.getStore() ?? this.#active.get(client);
      if (!active || active.client !== client || active.deadline.signal.aborted) return { action: 'cancel' };
      active.deadline.pause();
      try {
        return await this.elicit!({ ...active.scope, params: request.params }, AbortSignal.any([active.deadline.signal, context.mcpReq.signal]));
      } finally { active.deadline.resume(); }
    });
  }
  withOrigin<T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
    const active = signal && this.#signals.get(signal);
    return active ? this.#scope.run(active, run) : run();
  }
  async run<T>(client: Client, scope: McpCallScope, timeoutMs: number, invoke: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const scoped = !this.elicit || (client instanceof ScopedMcpClient && client.getNegotiatedProtocolVersion() === '2026-07-28');
    const run = async () => {
      scope.signal?.throwIfAborted();
      const deadline = new ActiveDeadline(timeoutMs, scope.signal);
      const active = { client, scope, deadline };
      if (!scoped) this.#active.set(client, active);
      this.#signals.set(deadline.signal, active);
      try { return await this.#scope.run(active, () => invoke(deadline.signal)); }
      catch (error) { if (deadline.controller.signal.aborted && !scope.signal?.aborted) throw deadline.controller.signal.reason; throw error; }
      finally { deadline.close(); this.#signals.delete(deadline.signal); if (this.#active.get(client) === active) this.#active.delete(client); }
    };
    if (scoped) return run();
    const pending = (this.#queues.get(client) ?? Promise.resolve()).then(run);
    this.#queues.set(client, pending.catch(() => undefined));
    return pending;
  }
}

/** Only server execution consumes this budget; waiting for human input does not. */
class ActiveDeadline {
  readonly controller = new AbortController();
  readonly signal: AbortSignal;
  private remaining: number;
  private started = performance.now();
  private waiting = 0;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(ms: number, signal?: AbortSignal) {
    this.remaining = ms;
    this.signal = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal;
    this.schedule();
  }
  pause() { if (this.waiting++ === 0) { this.remaining -= performance.now() - this.started; clearTimeout(this.timer); } }
  resume() { if (--this.waiting === 0) this.schedule(); }
  private schedule() { this.started = performance.now(); this.timer = setTimeout(() => this.controller.abort(Object.assign(new Error('MCP tool execution timed out.'), { code: 'mcp_tool_timeout' })), Math.max(0, this.remaining)); }
  close() { clearTimeout(this.timer); }
}
