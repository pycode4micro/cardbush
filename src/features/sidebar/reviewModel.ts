import { WORKSPACE_REVIEW_TURN_LIMIT } from '@cardbush/bush-protocol';
import type { ChatMessage } from '../../types';

export type ReviewTurn = { id: string; prompt?: string; createdAt?: string };

/** Includes Turns with no edits, so “previous” never silently skips a conversation Turn. */
export function recentReviewTurns(messages: ChatMessage[]): ReviewTurn[] {
  const turns = new Map<string, ReviewTurn>();
  const visit = (message: ChatMessage) => {
    for (const nested of message.loopHistory ?? []) visit(nested);
    const id = message.turnId?.trim();
    if (!id) return;
    const existing = turns.get(id);
    if (!existing) turns.set(id, { id, createdAt: message.createdAt });
    if (message.role === 'user') turns.get(id)!.prompt = message.content;
  };
  messages.forEach(visit);
  return [...turns.values()].slice(-WORKSPACE_REVIEW_TURN_LIMIT).reverse();
}

export function reviewPathKey(path: string) {
  const value = path.replaceAll('\\', '/').replace(/\/+$/, '');
  return /^[a-z]:(?:\/|$)/i.test(value) || value.startsWith('//') ? value.toLowerCase() : value;
}

export function reviewRelativePath(root: string, path: string): string | null {
  const normalized = path.replaceAll('\\', '/');
  const prefix = root.replaceAll('\\', '/').replace(/\/+$/, '') + '/';
  if (!reviewPathKey(normalized).startsWith(reviewPathKey(prefix) + '/')) return null;
  return normalized.slice(prefix.length);
}
