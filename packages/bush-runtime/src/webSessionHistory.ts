import { BUSH_SESSION_SNAPSHOT_PROTOCOL, type SessionEvent, type SessionSnapshot } from '@cardbush/bush-protocol';

const PAGE_BYTES = 8 * 1024 * 1024;
function fitsPage(value: unknown) {
  const stack = [value]; let bytes = 0, nodes = 0;
  while (stack.length) {
    const item = stack.pop();
    if (typeof item === 'string') bytes += item.length * 6 + 2;
    else if (item && typeof item === 'object') {
      for (const key of Object.keys(item)) {
        bytes += key.length * 6 + 4; stack.push((item as Record<string, unknown>)[key]);
        if (bytes > PAGE_BYTES || stack.length > 100_000) return false;
      }
    } else bytes += 16;
    if (bytes > PAGE_BYTES || ++nodes > 100_000) return false;
  }
  return true;
}

/** Presentation-only paging over the already validated journal. No full-history
 * snapshot, private model replay, or journal mutation crosses the Agent IPC. */
export function webSessionHistory(sessionId: string, events: SessionEvent[], input: { limit: number; before?: string; turnId?: string }) {
  if (!events.length) return { snapshot: null, history: { nextCursor: null }, committedTurnIds: [] };
  const committed = events.filter((event): event is Extract<SessionEvent, { kind: 'turn_committed' }> => event.kind === 'turn_committed');
  const end = input.before ? committed.findIndex(event => event.payload.turnId === input.before) : committed.length;
  if (end < 0) throw Object.assign(new Error('SESSION_HISTORY_CHANGED'), { code: 'SESSION_HISTORY_CHANGED' });
  let start = Math.max(0, end - input.limit);
  let selected = input.turnId
    ? committed.filter(event => event.payload.turnId === input.turnId) : committed.slice(start, end);
  let metadata: Record<string, unknown> | undefined;
  const superseded = new Set<string>(), summaries = new Map<string, string>();
  for (const event of events) {
    if (event.kind === 'session_created' || event.kind === 'session_metadata_updated') metadata = event.payload.metadata;
    if (event.kind === 'messages_superseded') event.payload.messageIds.forEach(id => superseded.add(id));
    if (event.kind === 'turn_committed') event.payload.supersession?.messageIds.forEach(id => superseded.add(id));
    if (event.kind === 'turn_context_summarized') for (const item of event.payload.summaries) if ('summary' in item) summaries.set(item.turnId, item.summary);
  }
  const project = () => ({
    protocol: BUSH_SESSION_SNAPSHOT_PROTOCOL, sessionId, revision: events.length,
    createdAt: events[0]!.createdAt, updatedAt: events.at(-1)!.createdAt,
    ...(metadata ? { metadata } : {}), supersededMessageIds: [...superseded],
    turns: selected.map(({ payload: turn }) => ({
      ...turn, ...(summaries.has(turn.turnId) ? { contextSummary: summaries.get(turn.turnId)! } : {}),
      messages: turn.messages.flatMap(entry => {
        if (!['user', 'assistant'].includes(entry.message.role)) return [];
        const message = { ...entry.message };
        if ('reasoningContent' in message) delete message.reasoningContent;
        if ('providerReplay' in message) delete message.providerReplay;
        // The browser previews the original personal files through metadata.
        // Inline model image bytes are a second, unused copy in that case.
        const attachments = entry.metadata?.attachments;
        if ('images' in message && Array.isArray(attachments) && attachments.some(item =>
          item && typeof item === 'object' && typeof item.path === 'string' && item.path.startsWith('/data/'))) delete message.images;
        return [{ ...entry, message }];
      }),
    })),
  });
  let projected = project();
  while (selected.length > 1 && !fitsPage(projected)) {
    selected = selected.slice(1); start++; projected = project();
  }
  if (!fitsPage(projected)) throw Object.assign(new Error('SESSION_HISTORY_TOO_LARGE'), { code: 'SESSION_HISTORY_TOO_LARGE' });
  const snapshot: SessionSnapshot | null = !events.length ? null : structuredClone(projected);
  return { snapshot, history: { nextCursor: !input.turnId && start > 0 ? selected[0]!.payload.turnId : null },
    committedTurnIds: committed.map(event => event.payload.turnId) };
}
