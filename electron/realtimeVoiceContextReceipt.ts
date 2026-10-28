import type { VoiceContextMessage } from './realtimeVoiceHistory';

export type RemoteContextItem = { id: string; role: 'user' | 'assistant'; text: string };

export function remoteContextItems(raw: Record<string, unknown>): RemoteContextItem[] | undefined {
  if (!Array.isArray(raw.items) || raw.items.length > 200) return;
  const items: RemoteContextItem[] = [];
  for (const item of raw.items) {
    if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 200 ||
      !['user', 'assistant'].includes(item.role) || !Array.isArray(item.content) || !item.content.length ||
      item.content.some((part: any) => !part || typeof part.text !== 'string')) return;
    items.push({ id: item.id, role: item.role, text: item.content.map((part: any) => part.text).join('') });
  }
  return new Set(items.map(item => item.id)).size === items.length ? items : undefined;
}

/** One complete create receipt, scoped by the caller to its pending batch and
 * current socket. Server-assigned IDs are bound only after ordered full-content
 * verification; text by itself is never used to choose an item for deletion. */
export function matchContextReceipt(expected: VoiceContextMessage[], raw: Record<string, unknown>, serverAssignedIds = false) {
  const items = remoteContextItems(raw);
  if (!items || items.length !== expected.length || !expected.length) return;
  const ordered = serverAssignedIds ? items : expected.map(message => items.find(item => item.id === message.id));
  if (ordered.some((item, index) => !item || item.role !== expected[index].role || item.text !== expected[index].text)) return;
  return ordered as RemoteContextItem[];
}
