import type { ChatMessage } from '../../types';

export function isContextGuidance(message: ChatMessage) {
  const metadata = message.metadata ?? {};
  return metadata.turn_guidance === true || metadata.turnGuidance === true ||
    String(metadata.name ?? '').trim() === 'turn_guidance';
}

/** Index metadata once per transcript update; hovering never scans later turns. */
export function indexContextTurns(messages: ChatMessage[]) {
  const turns: ChatMessage[] = [];
  const positions = new Map<string, number>();
  const byMessage = new Map<string, ChatMessage>();
  const byTurn = new Map<string, ChatMessage[]>();
  const ranges = new Map<string, { start: number; end: number }>();
  let range: { start: number; end: number } | undefined;
  messages.forEach((message, index) => {
    byMessage.set(message.id, message);
    if (message.messageId) byMessage.set(message.messageId, message);
    const turnId = message.turnId?.trim();
    if (turnId) {
      const group = byTurn.get(turnId);
      if (group) group.push(message); else byTurn.set(turnId, [message]);
    }
    if (message.role !== 'user' || isContextGuidance(message)) return;
    if (range) range.end = index;
    range = { start: index, end: messages.length };
    ranges.set(message.id, range);
    positions.set(message.id, turns.length);
    turns.push(message);
  });
  return {
    turns, positions, byMessage,
    messagesFor(id: string) {
      const message = byMessage.get(id);
      const turnId = message?.turnId?.trim();
      if (turnId) return byTurn.get(turnId) ?? [];
      const range = message && ranges.get(message.id);
      return range ? messages.slice(range.start, range.end) : [];
    },
  };
}

/** Only contiguous rows near the native scroll viewport are mounted. */
export function contextTickWindow(count: number, capacity: number, offset: number, step: number) {
  const first = Math.min(Math.max(0, count - capacity), Math.max(0, Math.floor(offset / Math.max(1, step))));
  return { first, start: Math.max(0, first - 1), end: Math.min(count, first + capacity + 2) };
}
