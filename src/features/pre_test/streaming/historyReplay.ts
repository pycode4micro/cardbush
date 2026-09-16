import type { RuntimeEvent, SessionSnapshot, ToolExecutionRecord } from '@cardbush/bush-protocol';
import type { ChatMessage, ChatToolExecution } from '../../../types';
import { projectRuntimeTurnMessages } from '../../../backend/runtimeSessionMessageProjection';
import { toolArtifactsFromPayload } from '../../../backend/toolArtifacts';
import type { ReplayFixture } from './streamingReplay';

export interface HistoryReplay extends ReplayFixture {
  id: string;
  title: string;
  source: {
    sessionId: string; turnId: string; startedAt: string; status: string;
    rawEvents: number; deltas: number; segments: number; tools: number;
    guidance: number; subagents: number; hasSnapshot: boolean;
    missingToolRecords: number; missingGuidanceText: number; hiddenInputs: number;
    omittedKinds: Record<string, number>;
  };
}
export interface HistoryReplayCollection { version: 1; generatedAt: string; cases: HistoryReplay[] }
type CommittedTurn = SessionSnapshot['turns'][number];
type ToolEvent = Extract<RuntimeEvent, { kind: 'tool_queued' | 'tool_running' | 'tool_returned' | 'tool_failed' | 'tool_cancelled' }>;

/** Read-only adapter of the same callbacks as runtimeChat.consumeRuntimeEvents.
 * No runtime instance, model call, tool dispatch, or journal writer is imported.
 * Reasoning, plans and approvals are counted as omitted, not invented as text.
 */
export function historyReplay(events: RuntimeEvent[], records: ToolExecutionRecord[], turn?: CommittedTurn): HistoryReplay {
  if (!events.length) throw new Error('Empty runtime history');
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence);
  const first = ordered[0];
  if (ordered.some(event => event.sessionId !== first.sessionId || event.turnId !== first.turnId)) {
    throw new Error('A replay must contain exactly one session and turn');
  }
  const seen = new Set<string>();
  for (const event of ordered) {
    if (seen.has(event.eventId)) throw new Error('Duplicate event ID in source journal');
    seen.add(event.eventId);
  }
  const canonical = turn ? projectRuntimeTurnMessages(turn, first.sessionId) : undefined;
  const source: HistoryReplay['source'] = {
    sessionId: first.sessionId, turnId: first.turnId, startedAt: first.createdAt, status: 'incomplete',
    rawEvents: ordered.length, deltas: 0, segments: 0, tools: 0, guidance: 0, subagents: 0,
    hasSnapshot: Boolean(turn), missingToolRecords: 0, missingGuidanceText: 0,
    hiddenInputs: turn?.messages.filter(message => message.message.role === 'user' &&
      (message.message.visibility === 'internal' || message.message.name === 'subagent_result')).length ?? 0,
    omittedKinds: {},
  };
  const user = canonical?.find(message => message.role === 'user');
  const initial: ChatMessage[] = user ? [user] : [];
  const firstAssistant = ordered.find(event => 'messageId' in event.payload && event.kind.startsWith('assistant_'));
  const assistantId = firstAssistant && 'messageId' in firstAssistant.payload
    ? String(firstAssistant.payload.messageId) : `replay-placeholder-${first.turnId}`;
  const result: HistoryReplay = {
    id: first.turnId,
    title: user?.content.slice(0, 65) || `事件回放 · ${first.createdAt.slice(0, 16)}`,
    initial, events: [], duration: 0, source,
    identity: { sessionId: first.sessionId, turnId: first.turnId, assistantId },
  };
  const toolRecords = new Map(records.filter(record => record.sessionId === first.sessionId && record.turnId === first.turnId)
    .map(record => [record.toolCall.id, record]));
  for (const event of ordered) {
    // Sequence is authoritative; clamp clock regressions without reordering events.
    const at = Math.max(result.duration, Date.parse(event.createdAt) - Date.parse(first.createdAt));
    result.duration = at;
    const route = { turnId: event.turnId, createdAt: event.createdAt, sequence: event.sequence,
      requestId: event.requestId, eventId: event.eventId };
    switch (event.kind) {
      case 'assistant_segment_delta':
      case 'assistant_segment_completed': {
        const completed = event.kind === 'assistant_segment_completed';
        completed ? source.segments++ : source.deltas++;
        result.events.push({ at, event: { kind: completed ? 'segment' : 'delta',
          content: event.kind === 'assistant_segment_delta' ? event.payload.delta : event.payload.content,
          route: { ...route, messageId: event.payload.messageId, segmentId: event.payload.segmentId,
            segmentOrdinal: event.payload.ordinal } } });
        break;
      }
      case 'tool_queued': case 'tool_running': case 'tool_returned': case 'tool_failed': case 'tool_cancelled': {
        if (event.kind === 'tool_running') {
          source.tools++;
          if (['subagent', 'team_delegate'].includes(event.payload.toolName)) source.subagents++;
        }
        const terminal = event.kind === 'tool_returned' || event.kind === 'tool_failed';
        const record = terminal ? toolRecords.get(event.payload.toolCallId) : undefined;
        if (terminal && !record) source.missingToolRecords++;
        result.events.push({ at, event: { kind: 'tool', execution: historyTool(event, record) } });
        break;
      }
      case 'guidance_applied': {
        source.guidance++;
        const stored = canonical?.find(message => message.id === event.payload.messageId);
        if (!stored) source.missingGuidanceText++;
        result.events.push({ at, event: { kind: 'guidance',
          message: stored ?? { id: event.payload.messageId, messageId: event.payload.messageId,
            turnId: event.turnId, conversationId: event.sessionId, createdAt: event.createdAt,
            role: 'user', status: 'sent', content: '［回放占位：此处已应用引导，原文未保存在现有日志中］',
            metadata: { name: 'turn_guidance', turn_guidance: true, guidance_delivery: 'sent' } },
          update: { ...route, messageId: '', kind: 'loop_transition', reason: 'turn_guidance_applied',
            guidanceMessageId: event.payload.messageId, previousAssistantMessageId: event.payload.previousAssistantMessageId,
            pendingGuidanceCount: event.payload.queueDepth, guidanceRoundIndex: event.payload.afterRound } } });
        break;
      }
      case 'turn_terminal':
        source.status = event.payload.status;
        result.events.push({ at, event: { kind: 'terminal', terminal: { turnId: event.turnId,
          status: event.payload.status, stopped: event.payload.status === 'stopped',
          stopReason: event.payload.reason, stopScenario: event.payload.reason, stopDetails: event.payload.details,
          completedAt: event.createdAt, terminalEventSequence: event.sequence, raw: event } } });
        break;
      default:
        source.omittedKinds[event.kind] = (source.omittedKinds[event.kind] ?? 0) + 1;
    }
  }
  if (canonical) result.events.push({ at: result.duration, event: { kind: 'snapshot', messages: canonical } });
  if (!user) result.title += source.guidance ? ' · 含引导' : source.status === 'stopped' ? ' · Stop' : '';
  return result;
}

function historyTool(event: ToolEvent, record?: ToolExecutionRecord): ChatToolExecution {
  const state: ChatToolExecution['state'] = event.kind === 'tool_returned' ? 'completed'
    : event.kind === 'tool_failed' ? 'failed' : event.kind === 'tool_cancelled' ? 'cancelled'
      : event.kind === 'tool_running' ? 'running' : 'queued';
  const base: ChatToolExecution = {
    id: event.payload.toolCallId, name: event.payload.toolName, state,
    summary: event.payload.display?.summary || event.payload.display?.title || event.payload.toolName,
    output: '', success: event.kind === 'tool_returned', durationMs: 0, createdAt: event.createdAt,
    contentOffset: 0, sequence: event.sequence, turnId: event.turnId,
    assistantMessageId: event.payload.assistantMessageId,
    metadata: { ...('error' in event.payload ? { error: event.payload.error } : {}) },
  };
  if (!record) return base;
  const returned = record.outcome === 'returned';
  const artifacts = returned ? toolArtifactsFromPayload({ result: record.result }) : [];
  return { ...base, state: record.outcome === 'returned' ? 'completed' : record.outcome, success: returned,
    output: returned ? typeof record.result === 'string' ? record.result : JSON.stringify(record.result, null, 2) ?? 'null' : '',
    ...(artifacts.length ? { artifacts } : {}),
    metadata: { actionManifest: record.actionManifest, nativeResult: record.result,
      workspaceChanges: record.workspaceChanges, error: record.error } };
}
