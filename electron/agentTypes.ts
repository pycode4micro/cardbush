/** Wire-facing types shared by the renderer and service. No host imports. */
import type { RuntimeEvent, ReasoningEffort } from '@cardbush/bush-protocol' with { 'resolution-mode': 'import' };
export const agentApiPath = '/api/agent/v1';
export type AgentEventRequest = { sessionId: string; turnId: string; afterSequence?: number };
export type AgentEventFrame = { type: 'ready'; agentId: string } | { type: 'event'; event: RuntimeEvent }
  | { type: 'heartbeat' } | { type: 'end'; afterSequence: number | null } | { type: 'error'; error: string };
export type AgentSendInput = { requestId: string; sessionId: string; text: string; modelId: string; permissionMode: 'task_free' | 'user_free' | 'all_free'; language: 'zh' | 'en'; reasoningEffort?: ReasoningEffort; planEnabled?: boolean; disabledSkills?: string[]; subagentPermissionRouting?: 'user' | 'parent' };
export type AgentProject = { id: string; name: string; path: string };
export type AgentJob = {
  id: string; sessionId: string; turnId: string; createdAt: string; startedAt?: string; completedAt?: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted'; error?: string; input: AgentSendInput;
  delegation?: { parentSessionId: string; parentTurnId: string };
};
export type AgentInfo = { protocol: 'cardbush.agent.v1'; apiVersion: 1; eventStreams: ['sse', 'ndjson']; id: string; name: string; platform: string; capabilities: {
  desktop: false; computerUse: false; browserUi: false; durableQueue: true; eventReplay: true; projects: true; models: true; plugins: true; delegation?: boolean; conversationUi?: boolean; conversationManagement?: boolean;
} };
export const agentOperations = ['info', 'projects.list', 'projects.save', 'projects.remove', 'projects.default',
  'sessions.list', 'sessions.create', 'sessions.get', 'sessions.rename', 'sessions.update', 'sessions.fork', 'sessions.delete', 'sessions.bind',
  'chat.send', 'chat.jobs', 'chat.stop', 'chat.events', 'delegation.submit', 'conversation.catalog', 'files.read', 'files.list', 'files.upload', 'runtime.command', 'product.command',
  'plugins.install', 'plugins.uninstall', 'plugins.connections', 'plugins.configure',
  'mcp.list', 'mcp.configure', 'mcp.remove', 'mcp.reconnect', 'instructions.get', 'instructions.save'] as const;
export type AgentOperation = typeof agentOperations[number];
export type AgentConnection = {
  id: string; name: string; transport: 'http'; url: string; migrationIssue?: string;
  hasToken: boolean; agentId?: string; connected: boolean; info?: AgentInfo;
};
export type AgentConnectionInput = { id?: string; name: string; transport: 'http'; url: string; token?: string };
export interface AgentDesktopApi {
  list(): Promise<AgentConnection[]>;
  save(input: AgentConnectionInput): Promise<AgentConnection[]>;
  remove(id: string): Promise<AgentConnection[]>;
  connect(id: string): Promise<AgentInfo>;
  disconnect(id: string): Promise<void>;
  call(id: string, operation: AgentOperation, input?: Record<string, unknown>): Promise<unknown>;
  watchEvents(id: string, input: AgentEventRequest, listener: (frame: AgentEventFrame) => void): () => void;
}
