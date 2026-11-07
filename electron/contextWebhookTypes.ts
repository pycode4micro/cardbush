import type { AssistantProfile, BotConnectionStatus, RuntimeSessionTurnRequest } from '@cardbush/bush-protocol' with { 'resolution-mode': 'import' };

export type WebhookBinding = {
  kind: 'conversation' | 'assistant'; sessionId: string; title: string;
  parent: RuntimeSessionTurnRequest; profile?: AssistantProfile; generation?: number;
} | { kind: 'friends'; sessionId: string; title: string };
export type ContextWebhookConfig = {
  id?: string; name: string; enabled: boolean; url: string;
  headers: Record<string, string>; parameters: Record<string, unknown>; body: unknown;
  incoming: { messageId: string; text: string; senderId: string; conversationId: string };
};
export type ContextWebhookConnection = ContextWebhookConfig & {
  id: string; sessionId: string; kind: WebhookBinding['kind']; token: string; endpoint: string;
  status: BotConnectionStatus;
  pending: number; lastReceivedAt?: string; lastDeliveredAt?: string; lastError?: string;
};
export type ContextWebhookSnapshot = {
  listening: boolean; host: string; port: number; error?: string; connections: ContextWebhookConnection[];
  pairings: Array<{ requestId: string; name: string; replyUrl: string }>;
};
export type ContextWebhookApi = {
  command(input: { action: string; [key: string]: unknown }): Promise<unknown>;
};
