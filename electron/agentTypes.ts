/** Wire-facing types shared by the renderer and service. No host imports. */
import type { RuntimeEvent, ReasoningEffort, RuntimeSessionTurnRequest } from '@cardbush/bush-protocol' with { 'resolution-mode': 'import' };
export const agentApiPath = '/api/agent/v1';
export type AgentEventRequest = { sessionId: string; turnId: string; afterSequence?: number };
export type AgentEventFrame = { type: 'ready'; agentId: string } | { type: 'event'; event: RuntimeEvent }
  | { type: 'heartbeat' } | { type: 'end'; afterSequence: number | null } | { type: 'error'; error: string };
export type AgentSendInput = { conversationStyle?: import('@cardbush/bush-product-agent', { with: { 'resolution-mode': 'import' } }).ConversationStyleSettings; visionEnabled?: boolean; supersession?: RuntimeSessionTurnRequest['supersession']; turnId?: string; files?: string[]; images?: string[]; goalObjective?: string; userMessageMetadata?: Record<string, unknown>; requestId: string; sessionId: string; text: string; modelId: string; permissionMode: 'task_free' | 'user_free' | 'all_free'; language: 'zh' | 'en'; reasoningEffort?: ReasoningEffort; planEnabled?: boolean; disabledSkills?: string[]; subagentPermissionRouting?: 'user' | 'parent' };
export type AgentProject = { id: string; name: string; path: string };
export type AgentJob = {
  id: string; sessionId: string; turnId: string; createdAt: string; startedAt?: string; completedAt?: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted'; error?: string; input: AgentSendInput;
  goalContinuation?: boolean;
  guidance?: { turnId: string; messageId: string; createdAt: string; applied?: boolean };
  delegation?: { parentSessionId: string; parentTurnId: string };
};
export type AgentInfo = { protocol: 'cardbush.agent.v1'; apiVersion: 1; eventStreams: ['sse', 'ndjson']; id: string; name: string; platform: string; capabilities: {
  desktop: false; computerUse: false; browserUi: false; durableQueue: true; eventReplay: true; projects: true; models: true; plugins: true; delegation?: boolean; conversationUi?: boolean; conversationManagement?: boolean; sharedConversation?: boolean; sharedSettings?: boolean;
} };
export const agentOperations = ['info', 'projects.list', 'projects.save', 'projects.remove', 'projects.default',
  'sessions.list', 'sessions.create', 'sessions.get', 'sessions.rename', 'sessions.update', 'sessions.fork', 'sessions.delete', 'sessions.bind',
  'chat.send', 'chat.queue', 'chat.jobs', 'chat.stop', 'chat.events', 'delegation.submit', 'conversation.catalog', 'conversation.extracts', 'files.read', 'files.list', 'files.upload', 'runtime.command', 'product.command',
  'plugins.install', 'plugins.uninstall', 'plugins.connections', 'plugins.connections.save', 'plugins.configure',
  'mcp.list', 'mcp.configure', 'mcp.remove', 'mcp.reconnect', 'instructions.get', 'instructions.save'] as const;
export type AgentOperation = typeof agentOperations[number];
export type AgentSshTunnel = { connectionId: string; remoteHost: string; remotePort: number };
export type AgentConnection = {
  id: string; name: string; transport: 'http'; url: string; migrationIssue?: string;
  hasToken: boolean; agentId?: string; connected: boolean; info?: AgentInfo;
  sshTunnel?: AgentSshTunnel;
  connectionState?: 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
  connectionError?: string;
};
export type AgentConnectionInput = { id?: string; name: string; transport: 'http'; url?: string; token?: string; sshTunnel?: AgentSshTunnel | null };
export interface AgentDesktopApi {
  list(): Promise<AgentConnection[]>;
  save(input: AgentConnectionInput): Promise<AgentConnection[]>;
  remove(id: string): Promise<AgentConnection[]>;
  connect(id: string): Promise<AgentInfo>;
  disconnect(id: string): Promise<void>;
  call(id: string, operation: AgentOperation, input?: Record<string, unknown>): Promise<unknown>;
  watchEvents(id: string, input: AgentEventRequest, listener: (frame: AgentEventFrame) => void): () => void;
  filePreview(id: string, sessionId: string, path: string): Promise<{ id: string; url: string }>;
  releaseFilePreview(id: string): Promise<void>;
}
