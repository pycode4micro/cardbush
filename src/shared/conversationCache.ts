/** Drop least recently visited idle transcripts, never live or pending work. */
export function trimConversationCache<T>(
  current: Record<string, T>, visits: Map<string, number>, protectedIds: Set<string>, idleLimit = 24,
): Record<string, T> {
  const idle = Object.keys(current).filter(id => !protectedIds.has(id))
    .sort((a, b) => (visits.get(b) ?? 0) - (visits.get(a) ?? 0));
  if (idle.length <= idleLimit) return current;
  const next = { ...current };
  for (const id of idle.slice(idleLimit)) { delete next[id]; visits.delete(id); }
  return next;
}
