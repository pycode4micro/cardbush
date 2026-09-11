import { AsyncLocalStorage } from 'node:async_hooks';
import { SdkErrorCode, specTypeSchemas, type CallToolResult, type Client, type Transport } from '@modelcontextprotocol/client';

export class McpResultValidationError extends Error {
  readonly code = 'mcp_result_validation_failed';
  constructor(readonly rawResult: unknown, readonly sdkCode: unknown, error: unknown) {
    super(`The MCP server returned a result, but client validation failed. This does not establish whether the server-side operation succeeded or failed. The original result is preserved in rawResult. ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

function isComplete(client: Client, raw: unknown): raw is Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const { resultType } = raw as Record<string, unknown>;
  return client.getNegotiatedProtocolVersion() === '2026-07-28'
    ? resultType === 'complete' : resultType === undefined || resultType === 'complete';
}

/** Accept native tool results without rewriting payloads or enforcing tool outputSchema. */
export function attachMcpResultFallback(client: Client, transport: Transport): void {
  type Capture = { ids: Set<string | number>; received: boolean; raw?: unknown };
  const scope = new AsyncLocalStorage<Capture>();
  const pending = new Map<string | number, Capture>();
  const invoke = client.callTool.bind(client);
  client.callTool = (params, options) => scope.run({ ids: new Set(), received: false }, async () => {
    const capture = scope.getStore()!;
    try {
      const result = await invoke(params, options);
      // The received response is the single result used by execution records and consumers.
      // In particular, keep extension fields that an SDK decoder may otherwise omit.
      // A continuation may finish in an SDK-owned callback outside this capture scope.
      // Its earlier input_required reply must never replace the completed result.
      return capture.received && isComplete(client, capture.raw) ? capture.raw as CallToolResult : result;
    }
    catch (error) {
      const code = (error as { code?: unknown })?.code;
      if (capture.received && !options?.signal?.aborted &&
        [SdkErrorCode.InvalidResult, SdkErrorCode.UnsupportedResultType, -32600, -32602].includes(code as never)) {
        // Keep modern continuation/control responses in the SDK, including failed fulfilment.
        // Only a completed tools/call response can satisfy this invocation.
        if (isComplete(client, capture.raw)) {
          // The SDK's native result type accepts arbitrary structuredContent. Its legacy
          // wire schema and callTool output-schema check are stricter than the host needs.
          // Validate the protocol structure only; return the received value, not parsed.data.
          const checked = await specTypeSchemas.CallToolResult['~standard'].validate(capture.raw);
          options?.signal?.throwIfAborted();
          if (!checked.issues) return capture.raw as CallToolResult;
        }
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
