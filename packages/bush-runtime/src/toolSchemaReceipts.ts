import type { ModelMessage } from '@cardbush/bush-protocol';

export const TOOL_SCHEMA_PROTOCOL = 'bush.tool_schema.v1';

/** Accept complete tool-owned schema receipts, including fully reassembled archives. */
export function* toolSchemaReceipts(messages: ModelMessage[], sessionId: string, discoveryTool: string | readonly string[], protocol: string): Generator<{
  messageIndex: number;
  searchCallId: string;
  output: { protocol: string; sessionId: string; action: 'load'; matches: unknown[]; total?: number; more?: boolean };
}> {
  const discoveryTools = new Set(typeof discoveryTool === 'string' ? [discoveryTool] : discoveryTool);
  const calls = new Map<string, string>();
  const archives = new Map<string, { length: number; chunks: Map<number, string>; invalid?: boolean; emitted?: boolean }>();
  const archiveCalls = new Map<string, string>();
  for (const [messageIndex, message] of messages.entries()) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls) if (discoveryTools.has(call.name) || call.name === 'read_archived_tool_result') calls.set(call.id, call.name);
    } else if (message.role === 'tool') {
      const name = calls.get(message.toolCallId); calls.delete(message.toolCallId);
      let output: any, searchCallId = message.toolCallId;
      if (name && discoveryTools.has(name)) {
        try { output = JSON.parse(message.content); } catch { continue; }
        if (output?.archived === true && typeof output.locator === 'string' && Number.isSafeInteger(output.originalChars) && output.originalChars > 0) {
          archives.set(output.locator, { length: output.originalChars, chunks: new Map() });
          archiveCalls.set(output.locator, message.toolCallId);
          continue;
        }
      } else if (name === 'read_archived_tool_result') {
        const divider = '\n\n[text]\n', boundary = message.content.indexOf(divider);
        if (boundary < 0) continue;
        let chunk;
        try { chunk = JSON.parse(message.content.slice(0, boundary)); } catch { continue; }
        if (!chunk || typeof chunk !== 'object') continue;
        const archive = archives.get(chunk.locator), text = message.content.slice(boundary + divider.length);
        if (!archive || archive.invalid || archive.emitted || !Number.isSafeInteger(chunk.offset) || chunk.offset < 0 || chunk.next_offset !== chunk.offset + text.length || chunk.next_offset > archive.length) continue;
        for (const [offset, part] of archive.chunks) {
          const start = Math.max(offset, chunk.offset), end = Math.min(offset + part.length, chunk.next_offset);
          if (start < end && part.slice(start - offset, end - offset) !== text.slice(start - chunk.offset, end - chunk.offset)) {
            archive.invalid = true;
            break;
          }
        }
        if (archive.invalid) continue;
        if ((archive.chunks.get(chunk.offset)?.length ?? -1) < text.length) archive.chunks.set(chunk.offset, text);
        let combined = '';
        for (const [offset, part] of [...archive.chunks].sort(([a], [b]) => a - b)) {
          if (offset > combined.length) break;
          combined += part.slice(Math.max(0, combined.length - offset));
        }
        if (combined.length !== archive.length) continue;
        try { output = JSON.parse(combined); } catch { continue; }
        searchCallId = archiveCalls.get(chunk.locator)!;
        // An immutable archive contributes its schema at the first complete read.
        // Later duplicate reads must not inject the same large definitions again.
        archive.emitted = true;
      } else continue;
      if (output?.protocol === protocol && output.sessionId === sessionId && output.action === 'load' && Array.isArray(output.matches)) {
        yield { messageIndex, searchCallId, output };
      }
    }
  }
}
