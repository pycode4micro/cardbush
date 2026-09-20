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

/** External edits start at their containing folders, without rebuilding drive/home ancestors. */
export function reviewExternalRoots(root: string, paths: string[]) {
  const parents = new Map<string, string>();
  for (const path of paths) {
    if (reviewRelativePath(root, path) !== null) continue;
    const normalized = path.replaceAll('\\', '/');
    if (!/^(?:[a-z]:\/|\/)/i.test(normalized)) continue;
    let parent = normalized.slice(0, normalized.lastIndexOf('/')) || '/';
    if (/^[a-z]:$/i.test(parent)) parent += '/';
    parents.set(reviewPathKey(parent), parent);
  }
  // A folder with direct edits already owns any edited descendants.
  const roots: string[] = [];
  for (const parent of [...parents.values()].sort((a, b) => a.length - b.length)) {
    if (!roots.some(ancestor => reviewRelativePath(ancestor, parent) !== null)) roots.push(parent);
  }
  const segments = roots.map(path => path.replace(/\/+$/, '').split('/'));
  return roots.map((path, index) => {
    const parts = segments[index];
    let length = 1;
    const suffix = (other: string[]) => other.slice(-length).join('/');
    while (length < parts.length && segments.some((other, otherIndex) => otherIndex !== index && suffix(other) === suffix(parts))) length++;
    return { path, name: parts.slice(-length).join('/') || path };
  }).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}
