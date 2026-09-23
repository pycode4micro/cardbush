/** Shared by local conversation lists and remote Agent sidebars.
 * Child sessions remain addressable by ID from their parent task details.
 */
export function isVisibleConversationSession(session: { metadata?: Record<string, unknown> }): boolean {
  return session.metadata?.agentRole !== 'child' && session.metadata?.hidden !== true;
}
