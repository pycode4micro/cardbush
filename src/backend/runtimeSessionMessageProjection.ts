import type {
  SessionMessage as RuntimeSessionMessage,
  SessionSnapshot as RuntimeSessionSnapshot,
} from '@cardbush/bush-protocol';

import type { ChatAttachment, ChatMessage } from '../types';

type RuntimeCommittedTurn = RuntimeSessionSnapshot['turns'][number];

/**
 * Older committed Turns predate durable UI attachment metadata. Their local
 * file inputs still exist in the internal Turn context (and image inputs on
 * the user message), so recover that presentation data before internal
 * messages are hidden. This is a projection-only compatibility path: it does
 * not mutate the session log or the model-facing transcript.
 */
export function restoreRuntimeTurnAttachmentMetadata(
  turn: RuntimeCommittedTurn,
): RuntimeCommittedTurn {
  let pendingPaths: string[] = [];
  let changed = false;
  const messages = turn.messages.map((message) => {
    if (isLegacyAttachmentContext(message)) {
      pendingPaths = legacyContextAttachmentPaths(message.message.content);
      return message;
    }
    if (message.message.role !== 'user' || message.message.visibility === 'internal') {
      return message;
    }

    const durableAttachments = runtimeMessageAttachments(message.metadata);
    const imagePaths = message.message.images?.map((image) => image.url) ?? [];
    const legacyAttachments = durableAttachments.length > 0
      ? []
      : legacyAttachmentsFromPaths(
          message.messageId,
          [...pendingPaths, ...imagePaths],
        );
    pendingPaths = [];
    if (legacyAttachments.length === 0) return message;

    changed = true;
    return {
      ...message,
      metadata: {
        ...(message.metadata ?? {}),
        attachments: legacyAttachments,
      },
    };
  });
  return changed ? { ...turn, messages } : turn;
}

/**
 * Project one committed Runtime Turn without losing boundaries that are
 * represented by message order. In particular, a named turn_guidance user
 * message seals the preceding assistant reply as user-visible output.
 */
export function projectRuntimeTurnMessages(
  turn: RuntimeCommittedTurn,
  sessionId: string,
): ChatMessage[] {
  let assistantSegmentIndex = 0;
  let segmentStartedAt = turn.createdAt;
  const lastAssistantIndex = findLastAssistantIndex(turn.messages);

  return turn.messages.map((message, index) => {
    const next = turn.messages[index + 1];
    const previous = turn.messages[index - 1];
    const isGuidance = isRuntimeGuidanceMessage(message);
    const isGuidanceBoundary =
      message.message.role === 'assistant' && isRuntimeGuidanceMessage(next);

    if (isGuidance) {
      segmentStartedAt = message.createdAt;
    }
    if (message.message.role === 'assistant') {
      assistantSegmentIndex += 1;
    }

    const projected = projectRuntimeSessionMessage(message, sessionId, turn);
    const metadata: Record<string, unknown> = {
      ...(projected.metadata ?? {}),
    };

    if (isGuidance) {
      metadata.name = 'turn_guidance';
      metadata.turn_guidance = true;
      metadata.guidance_delivery = 'sent';
      metadata.client_message_id = message.messageId;
    }

    if (message.message.role === 'assistant') {
      metadata.assistant_segment_index = assistantSegmentIndex;
      metadata.transcript_kind = isGuidanceBoundary
        ? 'assistant_segment'
        : index === lastAssistantIndex
          ? 'assistant_final'
          : 'assistant_segment';

      if (isGuidanceBoundary && next) {
        metadata.segment_complete = true;
        metadata.segment_boundary = 'turn_guidance';
        metadata.sealed_by_client_message_id = next.messageId;
        metadata.next_assistant_segment_index = assistantSegmentIndex + 1;
      }

      const startedAt = isRuntimeGuidanceMessage(previous)
        ? previous.createdAt
        : segmentStartedAt;
      const completedAt = isGuidanceBoundary
        ? message.createdAt
        : index === lastAssistantIndex
          ? turn.completedAt
          : message.createdAt;
      const durationMs = timestampDuration(startedAt, completedAt);
      metadata.cardbush_turn_started_at = startedAt;
      metadata.cardbush_turn_completed_at = completedAt;
      if (durationMs != null) {
        metadata.cardbush_turn_duration_ms = durationMs;
      }
      segmentStartedAt = completedAt;
    }

    return {
      ...projected,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    };
  });
}

export function projectRuntimeSessionMessage(
  message: RuntimeSessionMessage,
  sessionId: string,
  turn?: RuntimeCommittedTurn,
): ChatMessage {
  const role =
    message.message.role === 'developer' ? 'system' : message.message.role;
  const metadata: Record<string, unknown> = {};
  if (message.message.role === 'assistant') {
    metadata.toolCalls = message.message.toolCalls;
  } else if (message.message.role === 'tool') {
    metadata.toolCallId = message.message.toolCallId;
  } else if (message.message.name) {
    metadata.name = message.message.name;
  }
  const attachments = runtimeMessageAttachments(message.metadata);
  return {
    id: message.messageId,
    messageId: message.messageId,
    role,
    content: message.message.content,
    conversationId: sessionId,
    turnId: message.turnId,
    createdAt: message.createdAt,
    ...(role === 'assistant' && turn ? { status: turn.status } : {}),
    turnSequence: message.turnSequence,
    messageIndex: message.messageIndex,
    ...(attachments.length > 0
      ? { attachments }
      : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

function runtimeMessageAttachments(
  metadata: Record<string, unknown> | undefined,
): ChatAttachment[] {
  if (!Array.isArray(metadata?.attachments)) return [];
  return metadata.attachments.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
    const item = candidate as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    const type = typeof item.type === 'string' ? item.type : '';
    if (
      !id ||
      !name ||
      !['image', 'video', 'audio', 'document', 'folder'].includes(type)
    ) return [];
    return [{
      id,
      name,
      type: type as ChatAttachment['type'],
      ...(typeof item.path === 'string' && item.path.trim()
        ? { path: item.path.trim() }
        : {}),
      ...(typeof item.size === 'number' && Number.isFinite(item.size) && item.size >= 0
        ? { size: item.size }
        : {}),
    }];
  });
}

function isLegacyAttachmentContext(message: RuntimeSessionMessage): boolean {
  return message.message.role === 'user' && (
    message.message.name === 'turn_runtime_context' ||
    message.message.name === 'runtime_context'
  );
}

function legacyContextAttachmentPaths(content: string): string[] {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === 'Attached files:');
  if (start < 0) return [];
  const paths: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const value = line.trim();
    if (!value) continue;
    if (
      value.startsWith('</') ||
      /^(?:Attached images|Filesystem locations|Local date|Workspace|Project instructions):$/.test(value)
    ) break;
    paths.push(value);
  }
  return paths;
}

function legacyAttachmentsFromPaths(
  messageId: string,
  paths: string[],
): ChatAttachment[] {
  const seen = new Set<string>();
  return paths.flatMap((rawPath, index) => {
    const path = legacyAttachmentPath(rawPath);
    if (!path || /^data:/i.test(path)) return [];
    const normalized = path.toLocaleLowerCase();
    if (seen.has(normalized)) return [];
    seen.add(normalized);
    return [{
      id: `legacy-attachment-${messageId}-${index}`,
      name: legacyAttachmentName(path),
      type: legacyAttachmentType(path),
      path,
    }];
  });
}

function legacyAttachmentPath(value: string): string {
  const path = value.trim();
  if (!/^file:\/\//i.test(path)) return path;
  try {
    const decoded = decodeURIComponent(path.replace(/^file:\/\//i, ''));
    const windowsPath = decoded.replace(/^\/([A-Za-z]:)/, '$1');
    return /^[A-Za-z]:/.test(windowsPath)
      ? windowsPath
      : `/${windowsPath.replace(/^\/+/, '')}`;
  } catch {
    return path;
  }
}

function legacyAttachmentName(path: string): string {
  const withoutQuery = path.split(/[?#]/, 1)[0] ?? path;
  const name = withoutQuery.split(/[\\/]/).at(-1)?.trim();
  return name || path;
}

function legacyAttachmentType(path: string): ChatAttachment['type'] {
  const extension = (path.match(/\.([A-Za-z0-9]+)(?:[?#].*)?$/)?.[1] ?? '').toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'heic'].includes(extension)) {
    return 'image';
  }
  if (['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v'].includes(extension)) return 'video';
  if (['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus'].includes(extension)) return 'audio';
  return 'document';
}

function isRuntimeGuidanceMessage(message?: RuntimeSessionMessage): boolean {
  return message?.message.role === 'user' && message.message.name === 'turn_guidance';
}

function findLastAssistantIndex(messages: RuntimeSessionMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].message.role === 'assistant') {
      return index;
    }
  }
  return -1;
}

function timestampDuration(startedAt: string, completedAt: string): number | undefined {
  const started = Date.parse(startedAt);
  const completed = Date.parse(completedAt);
  return Number.isFinite(started) && Number.isFinite(completed) && completed >= started
    ? completed - started
    : undefined;
}
