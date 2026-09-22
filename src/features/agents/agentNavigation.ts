export const OPEN_AGENT_CONVERSATION = 'cardbush:open-agent-conversation';
export type AgentConversationTarget = { connectionId: string; sessionId: string };
export function openAgentConversation(target: AgentConversationTarget) {
  window.dispatchEvent(new CustomEvent(OPEN_AGENT_CONVERSATION, { detail: target }));
}
