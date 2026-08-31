import type { PendingInteraction } from '../../types';

/**
 * The Runtime may request permissions for several parallel tool calls in the
 * same event batch. Keep the first visible request in place; the interaction
 * bridge retains the remaining requests and advances them after the user
 * answers or cancels the current one.
 */
export function keepFirstPendingInteraction(
  current: PendingInteraction | null,
  incoming: PendingInteraction,
  activeSessionId: string,
): PendingInteraction | null {
  const activeSession = activeSessionId.trim();
  const incomingSession = incoming.sessionId?.trim() ?? activeSession;
  if (activeSession && incomingSession && incomingSession !== activeSession) {
    return current;
  }
  if (!current || current.id === incoming.id) {
    return incoming;
  }
  const currentSession = current.sessionId?.trim() ?? activeSession;
  if (currentSession === incomingSession) {
    return current;
  }
  return incoming;
}
