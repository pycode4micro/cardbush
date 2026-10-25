import { createHash } from 'node:crypto';
import type { ModelMessage, RuntimeToolError, ToolCall } from '@cardbush/bush-protocol';

const routeErrors = new Set(['tool_route_mismatch', 'tool_requires_direct_call']);
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== '_display_title').sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
function fingerprint(call: Pick<ToolCall, 'name' | 'argumentsText'>, code: string) {
  try {
    let name = call.name, args = JSON.parse(call.argumentsText);
    for (let depth = 0; depth < 8 && name === 'call_tool' && typeof args?.name === 'string' && args.arguments; depth++) {
      name = args.name; args = args.arguments;
    }
    return createHash('sha256').update(JSON.stringify([code, name, canonical(args)])).digest('hex');
  } catch { return; }
}

/** Derived only from failed native route receipts. No retry/forwarding, new
 * permission, rewritten assistant call or separate state store is introduced. */
export function annotateToolRouteRecovery(error: RuntimeToolError, call: ToolCall, messages: ModelMessage[]): void {
  if (!routeErrors.has(error.code)) return;
  const key = fingerprint(call, error.code);
  if (!key) return;
  let attempts = 1;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === 'user') break;
    if (message.role !== 'tool') continue;
    let previous: any;
    try { previous = JSON.parse(message.content).runtimeError; } catch { break; }
    if (!previous || previous.code !== error.code || previous.details?.execution?.effects !== 'none') break;
    let priorCall: Pick<ToolCall, 'name' | 'argumentsText'> | undefined;
    for (let at = index - 1; at >= 0; at--) {
      const candidate = messages[at]!;
      if (candidate.role === 'assistant') {
        priorCall = candidate.toolCalls.find(item => item.id === message.toolCallId);
        if (priorCall || candidate.toolCalls.length) break;
      }
    }
    if (!priorCall || fingerprint(priorCall, previous.code) !== key) break;
    attempts++;
  }
  const corrected = error.details?.corrected_call as { name?: string; arguments?: unknown } | undefined;
  if (attempts > 1 && corrected?.name) {
    const { definition: _definition, ...details } = error.details ?? {};
    error.details = { route_recovery: {
      attempts,
      next_step: { name: 'get_tool_schema', arguments: { name: corrected.name } },
      instruction: 'Stop repeating this rejected envelope. Read the entry-point schema, then submit corrected_call with the preserved arguments. This does not retry or resubmit a target operation.',
    }, ...details };
  }
}
