import { useEffect, useMemo, useRef, useState } from 'react';
import { Files } from 'lucide-react';
import type { RuntimeEvent, SessionSnapshot, WorkspaceReview } from '@cardbush/bush-protocol';
import type { AgentJob } from '../../../electron/agentTypes';
import type { AppLanguage, ChatMessage, ChatToolExecution } from '../../types';
import { projectRuntimeTurnMessages, restoreRuntimeTurnAttachmentMetadata } from '../../backend/runtimeSessionMessageProjection';
import { attachHistoryToolExecutions } from '../../backend/historyToolAssociation';
import { runtimeHistoryToolExecution } from '../../backend/api';
import { coverWorkspaceToolExecution, markRevertedWorkspaceToolExecution, workspaceCheckpointExecutions } from '../../backend/workspaceReview';
import { normalizeChatMessagesForDisplay, normalizeActiveTurnTranscriptForDisplay } from '../chatMessages/transcript/messageProjection';
import { MessageBubble, MessageFileReferenceScope } from '../chatMessages/MessageBubble';
import { ConversationChangeDialog } from '../sidebar/ChatSidebar';
import { recentReviewTurns } from '../sidebar/reviewModel';
import { emptyReviewComments, type ReviewComment, type ReviewCommentState } from '../sidebar/reviewCommentModel';
import { changeReportsFromMessages, type ConversationChangeReport } from '../tools/toolChangeReports';
import { WorkspaceChangeStateContext } from '../tools/WorkspaceChangeStateContext';
import { agentRuntimeClient, type AgentCall } from './AgentConversationUi';

export type AgentVisibleJob = Omit<AgentJob, 'input'> & { text: string; modelId: string };
const noAction = async () => {};
const emptyStates = new Map<string, boolean>();

/** One projection of the server journal, rendered by the ordinary desktop components. */
export function AgentTranscript({ call, scope, sessionId, snapshot, jobs, events, activeTurnId = '', busy, language, onRefresh, onComposeReviewComments }: {
  call: AgentCall; scope: string; sessionId: string; snapshot: SessionSnapshot | null; jobs: AgentVisibleJob[];
  events: RuntimeEvent[]; activeTurnId?: string; busy: boolean; language: AppLanguage; onRefresh: () => void; onComposeReviewComments: (comments: ReviewComment[]) => void;
}) {
  const client = useMemo(() => agentRuntimeClient(call), [call]);
  const [records, setRecords] = useState<ChatToolExecution[]>([]);
  const [workspaceReview, setWorkspaceReview] = useState<WorkspaceReview | null>(null);
  const [error, setError] = useState('');
  const [review, setReview] = useState<{ path: string; turnId?: string }>();
  const [reverting, setReverting] = useState('');
  const [revision, setRevision] = useState(0);
  const [comments, setComments] = useState<ReviewCommentState>(emptyReviewComments);
  const historyCache = useRef(new Map<string, { stamp: string; records: ChatToolExecution[] }>());
  const workspaceCache = useRef<{ stamp: string; review: WorkspaceReview | null } | undefined>(undefined);
  const signature = [...(snapshot?.turns.map(turn => turn.turnId) ?? []), activeTurnId].filter(Boolean).join('|');
  const terminalEvents = events.filter(event => ['tool_returned', 'tool_failed', 'tool_cancelled'].includes(event.kind)).length;
  useEffect(() => {
    let alive = true;
    const turns = [...new Set(signature.split('|').filter(Boolean))];
    const managed = snapshot?.metadata?.runtimeWorkspace as { versioning?: string; mode?: string } | undefined;
    const workspaceStamp = `${snapshot?.revision ?? 0}:${revision}`;
    void Promise.all([
      Promise.all(turns.map(async turnId => {
        const stamp = turnId === activeTurnId ? `active:${terminalEvents}` : `done:${snapshot?.turns.find(turn => turn.turnId === turnId)?.completedAt ?? ''}`;
        const cached = historyCache.current.get(turnId);
        if (cached?.stamp === stamp) return cached.records;
        const records = (await client.listTurnToolExecutionSummaries({ sessionId, turnId })).map(runtimeHistoryToolExecution);
        if (alive) historyCache.current.set(turnId, { stamp, records });
        return records;
      })),
      managed?.versioning === 'git' || managed?.mode === 'worktree'
        ? workspaceCache.current?.stamp === workspaceStamp ? Promise.resolve(workspaceCache.current.review) : client.getWorkspace(sessionId, undefined, 'history')
        : Promise.resolve(null),
    ]).then(([groups, workspace]) => { if (alive) { setRecords(groups.flat()); setWorkspaceReview(workspace); workspaceCache.current = { stamp: workspaceStamp, review: workspace }; setError(''); } })
      .catch(error => { if (alive) setError(String(error.message ?? error)); });
    return () => { alive = false; };
  }, [client, sessionId, signature, snapshot, terminalEvents, revision, activeTurnId]);
  const messages = useMemo(() => {
    const superseded = new Set(snapshot?.supersededMessageIds ?? []);
    const committed = (snapshot?.turns ?? []).flatMap(turn => projectRuntimeTurnMessages(restoreRuntimeTurnAttachmentMetadata(turn), sessionId))
      .filter(message => !superseded.has(message.id));
    const pending: ChatMessage[] = [];
    for (const job of jobs) {
      if (snapshot?.turns.some(turn => turn.turnId === job.turnId)) continue;
      pending.push({ id: `pending:${job.id}`, conversationId: sessionId, turnId: job.turnId, role: 'user', content: job.text, createdAt: job.createdAt });
    }
    const live: ChatMessage[] = [];
    if (activeTurnId && !snapshot?.turns.some(turn => turn.turnId === activeTurnId)) {
      const job = jobs.find(job => job.turnId === activeTurnId);
      const segments = new Map<string, ChatMessage>();
      for (const event of events) {
        if (event.kind !== 'assistant_segment_delta' && event.kind !== 'assistant_segment_completed') continue;
        const key = event.payload.segmentId;
        const previous = segments.get(key);
        segments.set(key, { ...previous, id: key, conversationId: sessionId, turnId: activeTurnId, role: 'assistant', createdAt: previous?.createdAt ?? event.createdAt,
          content: event.kind === 'assistant_segment_delta' ? (previous?.content ?? '') + event.payload.delta : event.payload.content,
          metadata: { transcript_kind: 'assistant_segment', assistant_segment_index: previous?.metadata?.assistant_segment_index ?? segments.size + 1,
            cardbush_turn_started_at: job?.startedAt ?? events[0]?.createdAt ?? job?.createdAt } });
      }
      live.push(...segments.values());
      if (!live.length) live.push({ id: `active:${activeTurnId}`, conversationId: sessionId, turnId: activeTurnId, role: 'assistant', content: '', createdAt: job?.startedAt ?? job?.createdAt,
        metadata: { transcript_kind: 'assistant_final', cardbush_turn_started_at: job?.startedAt ?? job?.createdAt } });
    }
    const executions = new Map(records.map(item => [`${item.turnId}:${item.id}`, coverWorkspaceToolExecution(markRevertedWorkspaceToolExecution(item, snapshot?.metadata), workspaceReview)]));
    for (const item of workspaceCheckpointExecutions(workspaceReview)) executions.set(`${item.turnId}:${item.id}`, item);
    for (const event of events) {
      if (!['tool_queued', 'tool_running', 'tool_returned', 'tool_failed', 'tool_cancelled'].includes(event.kind)) continue;
      const payload = event.payload as { toolCallId: string; toolName: string; error?: { message: string } };
      const key = `${activeTurnId}:${payload.toolCallId}`;
      if (['completed', 'failed', 'cancelled'].includes(executions.get(key)?.state ?? '')) continue;
      executions.set(key, { id: payload.toolCallId, name: payload.toolName, turnId: activeTurnId, sequence: event.sequence,
        state: event.kind === 'tool_returned' ? 'completed' : event.kind === 'tool_failed' ? 'failed' : event.kind === 'tool_cancelled' ? 'cancelled' : 'running',
        summary: payload.error?.message || payload.toolName, output: '', success: event.kind === 'tool_returned', durationMs: 0, createdAt: event.createdAt, contentOffset: 0, metadata: { nativeResultDeferred: true } });
    }
    return normalizeActiveTurnTranscriptForDisplay(normalizeChatMessagesForDisplay(attachHistoryToolExecutions([...committed, ...pending, ...live], [...executions.values()])), activeTurnId);
  }, [snapshot, jobs, events, activeTurnId, records, workspaceReview, sessionId]);
  const reports = useMemo(() => changeReportsFromMessages(messages), [messages]);
  const activeMessageId = messages.filter(message => message.role === 'assistant' && message.turnId === activeTurnId).at(-1)?.id ?? '';
  const workspace = snapshot?.metadata?.runtimeWorkspace as { workspaceDir?: string } | undefined;
  const revert = async (report: ConversationChangeReport) => {
    if (!report.turnId || busy || reverting) return;
    setReverting(report.id); setError('');
    try {
      const input = { sessionId, turnIds: [report.turnId] };
      if (report.reverted) await client.restoreWorkspaceChanges(input); else await client.revertWorkspaceChanges(input);
      onRefresh(); setRevision(value => value + 1);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setReverting(''); }
  };
  return <WorkspaceChangeStateContext.Provider value={{ states: emptyStates, busy: busy || Boolean(reverting) }}><MessageFileReferenceScope workspaceRoot={workspace?.workspaceDir}>
    {reports.length > 0 && <button className="agent-review-button" onClick={() => setReview({ path: '' })}><Files size={15}/>{language === 'zh' ? '审查改动' : 'Review changes'}</button>}
    {messages.map(message => <MessageBubble key={message.renderKey ?? message.id} message={message} language={language} sending={busy} activeTurnId={activeTurnId} activeAssistantMessageId={activeMessageId}
      readOnlyActions canRevertWorkspace={!busy && !reverting} onRegenerate={noAction} onEditUserMessage={noAction} onRetryGuidance={noAction}
      onRevertChangeReport={revert} onOpenChangeReview={path => setReview({ path: path ?? '', turnId: message.turnId })} onOpenScene={() => {}}/>)}
    {error && !review && <p className="agents-error" role="alert">{error}</p>}
    {review && <ConversationChangeDialog key={`${scope}:${review.turnId ?? ''}`} language={language}
      conversation={{ id: sessionId, title: String(snapshot?.metadata?.title ?? ''), updatedAt: snapshot?.updatedAt ?? '', preview: '', metadata: snapshot?.metadata }}
      reports={reports} turns={recentReviewTurns(messages)} initialFilePath={review.path} initialTurnId={review.turnId}
      reviewComments={comments} onReviewCommentsChange={setComments} onComposeReviewComments={items => { onComposeReviewComments(items); setReview(undefined); }}
      notice={error} revertingChangeId={reverting} revertedChangeIds={new Set(reports.filter(report => report.reverted).map(report => report.id))}
      revertAvailable={!busy} onClose={() => setReview(undefined)} onRevert={revert}/>}
  </MessageFileReferenceScope></WorkspaceChangeStateContext.Provider>;
}
