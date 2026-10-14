/** Shared by local conversation lists and remote Agent sidebars.
 * Child sessions remain addressable by ID from their parent task details.
 */
export function isVisibleConversationSession(session: { metadata?: Record<string, unknown>; turns?: unknown[] }): boolean {
  if (session.metadata?.agentRole === 'child' || session.metadata?.hidden === true) return false;
  // Older editors created sessions merely by opening their input. Preserve the
  // session for existing links, but don't list it until an actual send starts.
  const editorSession = session.metadata?.creation_workspace === true || session.metadata?.team_workspace === true;
  return !editorSession || session.metadata?.conversation_started === true || !session.turns || session.turns.length > 0;
}
