export interface ChatEnvelope {
  platform: string;
  sessionId: string;
  userId: string;
  channelId: string;
  text: string;
  files?: string[];
  images?: string[];
  messageId?: string;
  threadId?: string;
  rawEvent: Record<string, unknown>;
}

export interface ChatReply {
  text: string;
  metadata?: Record<string, unknown>;
}

export interface ConversationBackend {
  respond(
    envelope: ChatEnvelope,
    options?: {
      signal?: AbortSignal;
      onPermissionRequest?: (request: BotPermissionRequest) => void | Promise<void>;
    },
  ): Promise<ChatReply>;
  stopSession?(sessionId: string): Promise<void>;
  close?(): Promise<void>;
}

export interface BotPermissionRequest {
  permissionId: string;
  reason: string;
  actions: string[];
  resources: string[];
  requestedCapabilityIds: string[];
}

export interface BotDeliveryRequest {
  sessionId: string;
  paths: string[];
  text?: string;
}

export interface BotDeliveryResult {
  channel: string;
  delivered: string[];
  messageIds: string[];
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
