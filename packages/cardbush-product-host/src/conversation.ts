export interface ChatEnvelope {
  platform: string;
  sessionId: string;
  userId: string;
  channelId: string;
  text: string;
  messageId?: string;
  threadId?: string;
  rawEvent: Record<string, unknown>;
}

export interface ChatReply {
  text: string;
  metadata?: Record<string, unknown>;
}

export interface ConversationBackend {
  respond(envelope: ChatEnvelope, signal?: AbortSignal): Promise<ChatReply>;
  stopSession?(sessionId: string): Promise<void>;
  close?(): Promise<void>;
}

export function identityIsAllowed(input: {
  userId: string;
  channelId: string;
  allowedUserIds: readonly string[];
  allowedChannelIds: readonly string[];
}): boolean {
  return (
    (input.allowedUserIds.length === 0 || input.allowedUserIds.includes(input.userId)) &&
    (input.allowedChannelIds.length === 0 || input.allowedChannelIds.includes(input.channelId))
  );
}
