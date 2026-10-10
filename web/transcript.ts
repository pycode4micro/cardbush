import type { ChatAttachment, ChatMessage, ChatToolExecution } from '../src/types';
import { projectRuntimeTurnMessages, markRuntimeSupersededMessages } from '../src/backend/runtimeSessionMessageProjection';
import { attachHistoryToolExecutions } from '../src/backend/historyToolAssociation';
import { toolArtifactsFromPayload } from '../src/backend/toolArtifacts';
import { runtimeHistoryToolExecution } from '../src/backend/runtimeHistoryToolExecution';
import { normalizeChatMessagesForDisplay, normalizeActiveTurnTranscriptForDisplay } from '../src/features/chatMessages/transcript/messageProjection';
import { projectRenderableChatMessages } from '../src/features/chatMessages/messageRenderProjection';
import { personalFilePath } from './personalFiles';
import type { Frame, Job, State } from './api';

export type LiveSegment = { id: string; content: string; ordinal: number; sequence?: number; createdAt?: string; finalResponse?: boolean };
export type LiveTurn = { segments: Record<string, LiveSegment>; tools: Record<string, ChatToolExecution> };
export type LiveTranscript = Record<string, LiveTurn>;
export function webToolExecution(record: Parameters<typeof runtimeHistoryToolExecution>[0]) {
  const execution = runtimeHistoryToolExecution(record);
  return { ...execution, artifacts: execution.artifacts?.filter(artifact => personalFilePath(artifact.path) && !['video','audio'].includes(artifact.type)),
    metadata: { ...execution.metadata, displayTitle: execution.metadata.displayTitle || webToolTitle(execution.name) } };
}
const emptyTurn = (): LiveTurn => ({ segments: {}, tools: {} });
const working = (status: string) => status === 'queued' || status === 'running';
const webToolTitle = (name: string) => ({
  inject_image_input: '查看图片', checkpoint_context: '整理上下文',
  mcp__plugin_volcengine_images_images__seedream_capabilities: '查看图片生成功能',
  mcp__plugin_volcengine_images_images__seedream_create_task: '提交图片生成',
  mcp__plugin_volcengine_images_images__seedream_get_task: '查看图片生成进度',
  mcp__plugin_volcengine_images_images__generation_wait_tasks: '等待图片生成',
} as Record<string, string>)[name];

export function webAttachments(items: unknown): ChatAttachment[] {
  if (!Array.isArray(items)) return [];
  return items.flatMap(item => {
    const path = typeof item?.path === 'string' ? personalFilePath(item.path) : null;
    if (!path) return [];
    const type = String(item.mime ?? '').startsWith('image/') || item.type === 'image' ? 'image' : 'document';
    return [{ id: item.id || path, path, name: item.name || path.split('/').at(-1), type, size: item.size } as ChatAttachment];
  });
}

/** Transport adaptation only. Electron owns grouping, history and final-answer presentation. */
export function persistedTranscript(state: State | null): ChatMessage[] {
  if (!state?.snapshot) return [];
  const projected = state.snapshot.turns.flatMap((rawTurn, turnIndex) => {
    const job = state.jobs.find(item => item.turnId === rawTurn.turnId);
    const createdAt = rawTurn.createdAt || job?.createdAt || state.conversation.created_at;
    const messages = rawTurn.messages.filter(item => item.message.visibility !== 'internal' && !item.message.name?.startsWith('subagent_'))
      .map((item, index) => ({ ...item, turnId: rawTurn.turnId, turnSequence: turnIndex, messageIndex: item.messageIndex ?? index,
        createdAt: item.createdAt || createdAt,
        metadata: { ...item.metadata, attachments: webAttachments(item.metadata?.attachments) } }));
    const turn = { ...rawTurn, createdAt, completedAt: rawTurn.completedAt || job?.completedAt || createdAt,
      status: rawTurn.status || job?.status || 'completed', messages };
    const native = projectRuntimeTurnMessages(turn as unknown as Parameters<typeof projectRuntimeTurnMessages>[0], state.conversation.id);
    const tools: ChatToolExecution[] = (state.toolExecutions ?? []).filter(record => record.turnId === rawTurn.turnId).map(webToolExecution);
    for (const item of messages) {
      for (const call of item.message.toolCalls ?? []) {
        if (tools.some(tool => tool.id === call.id)) continue;
        const response = messages.find(candidate => candidate.message.role === 'tool' && candidate.message.toolCallId === call.id);
        // The conversation projection omits tool outputs. Absence is not evidence of failure.
        if (!response) continue;
        let result: unknown = response?.message.content;
        try { result = JSON.parse(String(result)); } catch { /* Plain text is a valid tool result. */ }
        const failed = Boolean(result && typeof result === 'object' && ('isError' in result && result.isError === true || 'error' in result && result.error));
        const state = response ? failed ? 'failed' : 'completed' : turn.status === 'stopped' ? 'cancelled' : 'failed';
        tools.push({ id: call.id, name: call.name, state, summary: call.name, output: response?.message.content ?? '',
          success: state === 'completed', durationMs: 0, createdAt: response?.createdAt || item.createdAt,
          contentOffset: item.message.content.length, contentOffsetExplicit: true, sequence: item.messageIndex,
          turnId: rawTurn.turnId, assistantMessageId: item.messageId,
          artifacts: toolArtifactsFromPayload({ result }).filter(artifact => personalFilePath(artifact.path) && artifact.type !== 'video' && artifact.type !== 'audio'),
          metadata: { displayTitle: webToolTitle(call.name), ...(result !== undefined ? { nativeResult: result } : {}), ...(failed ? { error: result } : {}) } });
      }
    }
    return attachHistoryToolExecutions(native, tools);
  });
  return projectRenderableChatMessages(normalizeChatMessagesForDisplay(markRuntimeSupersededMessages(projected, state.snapshot.supersededMessageIds ?? [])));
}

export function writeLiveSegment(live: LiveTranscript, turnId: string, messageId: string, content: string, replace = false): LiveTranscript {
  const turn = live[turnId] ?? emptyTurn(), prior = turn.segments[messageId];
  const segment = { ...prior, id: messageId, ordinal: prior?.ordinal ?? Object.keys(turn.segments).length,
    content: (replace ? '' : prior?.content ?? '') + content };
  return { ...live, [turnId]: { ...turn, segments: { ...turn.segments, [messageId]: segment } } };
}

export function applyTranscriptEvent(live: LiveTranscript, event: NonNullable<Frame['event']>): LiveTranscript {
  const turnId = event.turnId, turn = live[turnId] ?? emptyTurn(), payload = event.payload;
  if (event.kind.startsWith('assistant_segment_')) {
    const id = payload.messageId || payload.segmentId;
    if (!id) return live;
    const previous = turn.segments[id];
    return { ...live, [turnId]: { ...turn, segments: { ...turn.segments, [id]: {
      id, content: previous?.content ?? '', ordinal: payload.ordinal ?? previous?.ordinal ?? Object.keys(turn.segments).length,
      sequence: previous?.sequence ?? event.sequence,
      createdAt: previous?.createdAt || event.createdAt, finalResponse: payload.finalResponse ?? previous?.finalResponse,
    } } } };
  }
  const states: Record<string, ChatToolExecution['state']> = { tool_queued: 'queued', tool_running: 'running', tool_returned: 'completed', tool_failed: 'failed', tool_cancelled: 'cancelled' };
  if (!states[event.kind] || !payload.toolCallId || !payload.toolName) return live;
  const previous = turn.tools[payload.toolCallId];
  const lastSegment = Object.values(turn.segments).sort((a, b) => a.ordinal - b.ordinal).at(-1);
  const assistantMessageId = payload.assistantMessageId || previous?.assistantMessageId || lastSegment?.id || `tools:${turnId}`;
  const display = payload.display as { title?: string; titles?: unknown } | undefined;
  const execution: ChatToolExecution = { id: payload.toolCallId, name: payload.toolName, state: states[event.kind],
    summary: display?.title || payload.error?.message || payload.toolName, output: payload.error?.message || '',
    success: event.kind === 'tool_returned', durationMs: 0, createdAt: previous?.createdAt || event.createdAt || '',
    contentOffset: previous?.contentOffset ?? turn.segments[assistantMessageId]?.content.length ?? 0, contentOffsetExplicit: true,
    assistantMessageId, turnId, sequence: previous?.sequence ?? event.sequence,
    metadata: { ...previous?.metadata, displayTitle: display?.title || webToolTitle(payload.toolName), displayTitles: display?.titles, error: payload.error } };
  return { ...live, [turnId]: { ...turn, tools: { ...turn.tools, [execution.id]: execution } } };
}

export function pendingTranscript(sessionId: string, job: Job, live?: LiveTurn): ChatMessage[] {
  const turn = live ?? emptyTurn();
  const segments = Object.values(turn.segments).sort((a,b) => a.ordinal - b.ordinal);
  const ids = new Set(segments.map(item => item.id));
  const messages: ChatMessage[] = [{ id: `user:${job.id}`, role: 'user', content: job.text, turnId: job.turnId,
    conversationId: sessionId, createdAt: job.createdAt, attachments: webAttachments(job.attachments) }];
  // A tool-only round is still part of the transcript, even before any text arrives.
  for (const tool of Object.values(turn.tools)) if (tool.assistantMessageId && !ids.has(tool.assistantMessageId)) {
    ids.add(tool.assistantMessageId); segments.push({ id: tool.assistantMessageId, content: '', ordinal: tool.sequence ?? 0, sequence: tool.sequence, createdAt: tool.createdAt });
  }
  if (!segments.length && job.status !== 'queued') segments.push({ id: `reply:${job.turnId}`, content: '', ordinal: 0 });
  segments.sort((a, b) => (a.sequence ?? a.ordinal) - (b.sequence ?? b.ordinal));
  segments.forEach((segment, index) => messages.push({ id: segment.id, role: 'assistant', content: segment.content, turnId: job.turnId,
    conversationId: sessionId, createdAt: segment.createdAt || job.createdAt, status: job.status,
    metadata: { assistant_segment_index: index + 1, transcript_kind: segment.finalResponse || !working(job.status) && index === segments.length - 1 ? 'assistant_final' : 'assistant_segment',
      status: job.status, stopped: job.status === 'stopped', cardbush_turn_started_at: job.createdAt, cardbush_turn_completed_at: job.completedAt } }));
  const attached = attachHistoryToolExecutions(messages, Object.values(turn.tools));
  const projected = working(job.status) ? normalizeActiveTurnTranscriptForDisplay(attached, job.turnId) : normalizeChatMessagesForDisplay(attached);
  return projectRenderableChatMessages(projected);
}
