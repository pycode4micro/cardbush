import type { RuntimeToolError } from './tool.js';
import { terminalToolOutcome } from './terminalControl.js';

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown, limit: number) => typeof value === 'string' ? value.trim().slice(0, limit) : '';

/** Interpret only tool-owned contracts. Business JSON and prose are not error signals.
 * A declared failure still has a native result; it does not authorize a retry. */
export function returnedToolError(name: string, result: unknown, registeredMcp = false): RuntimeToolError | undefined {
  const native = object(result);
  const mcp = name === 'mcp_call' ? object(native?.result)
    : registeredMcp || name.startsWith('mcp__') ? native : undefined;
  if (mcp?.isError === true) {
    const declared = object(object(mcp.structuredContent)?.error);
    const content = Array.isArray(mcp.content) ? mcp.content : [];
    let message = text(declared?.message, 2048);
    if (!message) {
      for (const item of content) {
        const block = object(item);
        if (block?.type === 'text') message = (message + (message ? '\n' : '') + text(block.text, 2048 - message.length)).slice(0, 2048);
        if (message.length >= 2048) break;
      }
    }
    return { kind: 'tool', code: text(declared?.code, 256) || 'mcp_tool_error',
      message: message || 'The MCP tool reported an error.', details: { source: 'mcp', isError: true } };
  }
  if (terminalToolOutcome(name, result) === 'failed') {
    const exitCode = native?.exitCode, signal = native?.signal;
    return { kind: 'tool', code: 'terminal_command_failed',
      message: typeof exitCode === 'number' ? `Command exited with code ${exitCode}.`
        : text(signal, 128) ? `Command ended with signal ${text(signal, 128)}.` : `Command ${text(native?.state, 128) || 'failed'}.`,
      details: { source: 'terminal', ...(typeof exitCode === 'number' ? { exitCode } : {}), ...(typeof signal === 'string' ? { signal: text(signal, 128) } : {}) } };
  }
  return undefined;
}

/** Shared read projection for both legacy native records and compact summaries. */
export function toolExecutionError(record: {
  outcome: string; toolCall: { name: string }; result?: unknown; resultError?: RuntimeToolError; error?: RuntimeToolError;
}): RuntimeToolError | undefined {
  return record.error ?? record.resultError ?? (record.outcome === 'returned' ? returnedToolError(record.toolCall.name, record.result) : undefined);
}
