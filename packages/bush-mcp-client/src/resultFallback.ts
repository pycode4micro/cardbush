import { AsyncLocalStorage } from 'node:async_hooks';
import { SdkErrorCode, type Client, type Transport } from '@modelcontextprotocol/client';

export class McpResultValidationError extends Error {
  readonly code = 'mcp_result_validation_failed';
  constructor(readonly rawResult: unknown, readonly sdkCode: unknown, error: unknown) {
    super(`The MCP server returned a result, but client validation failed. This does not establish whether the server-side operation succeeded or failed. The original result is preserved in rawResult. ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/** Observe correlated replies without changing their content, envelope or schema. */
export function attachMcpResultFallback(client: Client, transport: Transport): void {
  type Capture = { ids: Set<string | number>; received: boolean; raw?: unknown };
  const scope = new AsyncLocalStorage<Capture>();
  const pending = new Map<string | number, Capture>();
  const invoke = client.callTool.bind(client);
  client.callTool = (params, options) => scope.run({ ids: new Set(), received: false }, async () => {
    const capture = scope.getStore()!;
    try { return await invoke(params, options); }
    catch (error) {
      const code = (error as { code?: unknown })?.code;
      if (capture.received && !options?.signal?.aborted &&
        [SdkErrorCode.InvalidResult, SdkErrorCode.UnsupportedResultType, -32600, -32602].includes(code as never)) {
        throw new McpResultValidationError(capture.raw, code, error);
      }
      throw error;
    } finally { for (const id of capture.ids) pending.delete(id); }
  });
  const send = transport.send.bind(transport), receive = transport.onmessage;
  transport.send = async (message, options) => {
    if ('method' in message && message.method === 'tools/call' && 'id' in message && message.id !== undefined) {
      const capture = scope.getStore();
      if (capture) { pending.set(message.id, capture); capture.ids.add(message.id); }
    }
    try { await send(message, options); }
    catch (error) { if ('id' in message && message.id !== undefined) pending.delete(message.id); throw error; }
  };
  transport.onmessage = (message, extra) => {
    if ('id' in message && message.id !== undefined && !('method' in message)) {
      const capture = pending.get(message.id); pending.delete(message.id);
      if (capture) {
        capture.received = 'result' in message;
        capture.raw = 'result' in message ? structuredClone(message.result) : undefined;
      }
    }
    receive?.(message, extra);
  };
}
