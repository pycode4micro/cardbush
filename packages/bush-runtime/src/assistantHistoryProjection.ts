import type { ModelMessage } from '@cardbush/bush-protocol';
import { completeContextUnits } from './contextCompactionScope.js';
import { compactReceipt, instructionRead, recordedToolInvocation } from './recordedToolHandoff.js';
import { conversationHistoryLocator } from './conversationHistory.js';

export function assistantHistoryLocator(generation: string, first: number, last = first) {
  const prefix = 'assistant-' + generation + '.';
  return conversationHistoryLocator(prefix + first, prefix + last);
}

export type ReceiptProjection = { index: number; callId: string; content: string };
const keepOriginal = new Set(['get_tool_schema', 'search_plugins', 'mcp_search', 'read_archived_tool_result',
  'check_habit', 'revise_memory', 'summary_for_user', 'checkpoint_context', 'read_conversation_history']);

/** Keep native roles, user corrections, call arguments and their paired receipts.
 * Only replace an old large receipt if the normal recorded projection saves space. */
export function projectAssistantReceipts(messages: ModelMessage[], through: number, generation: string, keepUnits: number) {
  const updates: ReceiptProjection[] = [];
  let index = through;
  for (const unit of completeContextUnits(messages).slice(0, -keepUnits)) {
    const [message, ...receipts] = unit;
    if (message?.role === 'assistant' && message.toolCalls.length &&
      !receipts.some(m => m.role === 'tool' && m.images?.length) &&
      !message.toolCalls.map(recordedToolInvocation).some(call => instructionRead(call) || keepOriginal.has(call.name))) {
      for (const [offset, receipt] of receipts.entries()) {
        if (receipt.role !== 'tool' || receipt.content.length < 2400) continue;
        const position = index + offset + 1;
        const result = compactReceipt(receipt.content);
        // Keep typed task/version fields at their native positions. Notification
        // deduplication consults the same receipt that the model sees.
        if (typeof result !== 'object' || !result || Array.isArray(result) || '_assistant_history' in result) continue;
        const content = JSON.stringify({ ...result, _assistant_history: {
          locator: assistantHistoryLocator(generation, index, index + unit.length - 1), receipt_index: position } });
        if (content.length < receipt.content.length * 0.8)
          updates.push({ index: position, callId: receipt.toolCallId, content });
      }
    }
    index += unit.length;
  }
  return updates;
}

export type AssistantHistoryEvidence = { index: number; role: 'user' | 'tool'; text: string; excerpt?: true };

function receiptEvidence(message: Extract<ModelMessage, { role: 'tool' }>, tool: string | undefined, limit: number) {
  const identity = { tool, call_id: message.toolCallId };
  const receipt = compactReceipt(message.content);
  const full = JSON.stringify({ ...identity, receipt });
  if (full.length <= limit) return full;
  const reference = { ...identity, reread: 'See original receipt at this index.' };
  // Keep nested task IDs and states even when a sibling field is a long log.
  const fields = JSON.stringify({ ...reference, fields: receipt }, (_, value) => {
    if (typeof value === 'string' && value.length > 128) return undefined;
    if (value && typeof value === 'object' && 'excerpt' in value && 'omitted_chars' in value) return undefined;
    return value;
  });
  return fields.length <= limit ? fields : JSON.stringify(reference);
}

/** Reserve bounded space beside a semantic summary for exact recent user wording
 * and observed receipts. The checkpoint always carries a locator for the full range. */
export function checkpointEvidence(previous: AssistantHistoryEvidence[], messages: ModelMessage[], through: number, budget: number) {
  if (!budget) return [];
  const items = [...previous];
  const tools = new Map<string, string>();
  for (const [offset, message] of messages.entries()) {
    if (message.role === 'assistant') for (const call of message.toolCalls) tools.set(call.id, recordedToolInvocation(call).name);
    if (message.role === 'user' && !message.name && message.visibility !== 'internal') {
      const item: AssistantHistoryEvidence = { role: 'user', index: through + offset, text: message.content };
      if (JSON.stringify(item).length > budget / 2) {
        const side = Math.min(400, Math.floor(budget / 16));
        item.text = message.content.slice(0, side) + ' […] ' + message.content.slice(-Math.max(1, side));
        item.excerpt = true;
      }
      items.push(item);
    }
    if (message.role === 'tool') {
      items.push({ role: 'tool', index: through + offset,
        text: receiptEvidence(message, tools.get(message.toolCallId), Math.min(512, budget / 2)) });
    }
  }
  const retained: AssistantHistoryEvidence[] = [];
  for (const role of ['user', 'tool'] as const) {
    let remaining = Math.floor(budget / 2);
    for (let i = items.length - 1; i >= 0 && remaining > 0; i--) {
      const item = items[i]!;
      if (item.role !== role) continue;
      const size = JSON.stringify(item).length + 1;
      if (size <= remaining) { retained.push(item); remaining -= size; }
    }
  }
  return retained.sort((a, b) => a.index - b.index);
}
