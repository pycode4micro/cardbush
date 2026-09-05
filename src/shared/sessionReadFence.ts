export interface SessionReadTicket {
  sessionId: string;
  identity: symbol;
}

/** Local read ordering only; never a persisted revision or a model-context fact. */
export class SessionReadFence {
  private readonly latest = new Map<string, symbol>();

  begin(sessionId: string): SessionReadTicket {
    const identity = Symbol(sessionId);
    this.latest.set(sessionId, identity);
    return { sessionId, identity };
  }

  isCurrent(ticket: SessionReadTicket): boolean {
    return this.latest.get(ticket.sessionId) === ticket.identity;
  }

  invalidate(sessionId: string): void {
    this.latest.delete(sessionId);
  }
}

export function canApplySessionSnapshot<T>(
  fence: SessionReadFence,
  ticket: SessionReadTicket,
  baseline: T,
  current: T,
): boolean {
  return fence.isCurrent(ticket) && baseline === current;
}
