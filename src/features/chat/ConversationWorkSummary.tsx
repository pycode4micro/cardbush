import {
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  FileCode2,
  FileOutput,
  LoaderCircle,
  Wrench,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  fetchSubagentTask,
  fetchSubagentTasks,
} from '../../backend/api';
import {
  isContextCompactionPresentationExecution,
} from '../../backend/contextCompactionPresentation';
import type {
  AppLanguage,
  ChatMessage,
  SubagentDispatchEvent,
  SubagentTaskSnapshot,
} from '../../types';
import {
  displayToolName,
  isToolRunning,
  summarizeChangeReports,
  type ConversationChangeReport,
} from '../tools';
import {
  openWorkSummaryInspector,
  SUBAGENT_DISPATCH_UI_EVENT,
} from '../subagents/subagentObservabilityEvents';
import {
  groupWorkSummaryHistoryByTurn,
  historyTurnLabel,
  historyTurnTimestamp,
} from './workSummaryHistory';

const historyTurnPageSize = 3;
const subagentTaskPageSize = 3;

export function ConversationWorkSummary({
  language,
  sessionId,
  messages,
  changeReports,
  onOpenChangeReview,
  subagentObservabilityAvailable = false,
  softVisible = true,
}: {
  language: AppLanguage;
  sessionId: string;
  messages: ChatMessage[];
  changeReports: ConversationChangeReport[];
  onOpenChangeReview: (filePath?: string) => void;
  subagentObservabilityAvailable?: boolean;
  softVisible?: boolean;
}) {
  const [visibleHistoryTurnCount, setVisibleHistoryTurnCount] = useState(historyTurnPageSize);
  const [visibleSubagentTaskCount, setVisibleSubagentTaskCount] = useState(subagentTaskPageSize);
  const subagentTasks = useSubagentTaskFeed(sessionId, subagentObservabilityAvailable);
  const executions = useMemo(
    () => messages
      .flatMap((message) => [
        ...(message.toolExecutions ?? []),
        ...(message.loopHistory ?? []).flatMap((history) => history.toolExecutions ?? []),
      ])
      // Context compaction deliberately reuses the Tool-row presentation in
      // the transcript, but it is Runtime maintenance rather than user work.
      .filter((execution) => !isContextCompactionPresentationExecution(execution))
      .filter((execution, index, all) =>
        all.findIndex((candidate) => candidate.id === execution.id) === index)
      .slice(-6)
      .reverse(),
    [messages],
  );
  const historyGroups = useMemo(() => groupWorkSummaryHistoryByTurn(messages), [messages]);
  const historyCount = useMemo(
    () => historyGroups.reduce((total, group) => total + group.history.length, 0),
    [historyGroups],
  );
  const visibleHistoryGroups = historyGroups.slice(0, visibleHistoryTurnCount);
  const remainingHistoryTurnCount = Math.max(0, historyGroups.length - visibleHistoryGroups.length);
  const visibleSubagentTasks = subagentTasks.slice(0, visibleSubagentTaskCount);
  const remainingSubagentTaskCount = Math.max(
    0,
    subagentTasks.length - visibleSubagentTasks.length,
  );
  const changeSummary = useMemo(
    () => summarizeChangeReports(changeReports),
    [changeReports],
  );
  const recentFiles = useMemo(() => {
    const seen = new Set<string>();
    return [...changeReports]
      .reverse()
      .flatMap((report) => [...report.files].reverse())
      .filter((file) => {
        const key = file.path.trim().replaceAll('\\', '/').toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 5);
  }, [changeReports]);

  useEffect(() => {
    setVisibleHistoryTurnCount(historyTurnPageSize);
    setVisibleSubagentTaskCount(subagentTaskPageSize);
  }, [sessionId]);

  return (
    <aside
      className={`conversation-work-summary soft-panel-motion ${softVisible ? 'soft-panel-visible' : 'soft-panel-hidden'}`}
      aria-hidden={!softVisible}
    >
      <div className="work-summary-content">
        <section className="work-summary-overview">
            <header className="work-summary-header">
              <div>
                <span className="work-summary-kicker">
                  {language === 'zh' ? '当前对话' : 'Current conversation'}
                </span>
                <h2>{language === 'zh' ? '工作摘要' : 'Work summary'}</h2>
              </div>
              <div className="work-summary-metrics">
                <span>{changeSummary?.fileCount ?? 0} {language === 'zh' ? '文件' : 'files'}</span>
                <span>{executions.length} {language === 'zh' ? '工具' : 'tools'}</span>
              </div>
            </header>

            <div className="work-summary-section outputs">
              <div className="work-summary-section-title">
                <FileOutput size={14} />
                <strong>{language === 'zh' ? '最近产出' : 'Recent outputs'}</strong>
                {changeSummary && (
                  <button type="button" onClick={() => onOpenChangeReview()}>
                    {changeSummary.fileCount}
                  </button>
                )}
              </div>
              {recentFiles.length > 0 ? (
                <div className="work-summary-file-list">
                  {recentFiles.map((file) => (
                    <button
                      type="button"
                      key={file.path}
                      onClick={() => onOpenChangeReview(file.path)}
                    >
                      <FileCode2 size={14} />
                      <span title={file.path}>{file.path.replaceAll('\\', '/').split('/').pop()}</span>
                      <small>
                        <b>+{file.additions}</b>
                        <i>-{file.deletions}</i>
                      </small>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="work-summary-empty">{language === 'zh' ? '尚无文件产出' : 'No outputs yet'}</p>
              )}
            </div>

            <div className="work-summary-section">
              <div className="work-summary-section-title">
                <Wrench size={14} />
                <strong>{language === 'zh' ? '工具执行' : 'Tool activity'}</strong>
                <span>{executions.length}</span>
              </div>
              {executions.length > 0 ? (
                <div className="work-summary-tool-list">
                  {executions.slice(0, 5).map((execution) => {
                    const running = isToolRunning(execution);
                    return (
                      <div className="work-summary-tool" key={execution.id}>
                        {running ? <LoaderCircle className="spin" size={13} /> : <CheckCircle2 size={13} />}
                        <span>
                          <strong>{displayToolName(execution.name)}</strong>
                          <small>{execution.summary || execution.output || (language === 'zh' ? '已完成' : 'Completed')}</small>
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="work-summary-empty">{language === 'zh' ? '尚无工具执行' : 'No tool activity yet'}</p>
              )}
            </div>

            {subagentTasks.length > 0 && (
              <div className="work-summary-section work-summary-subagents" data-testid="work-summary-subagents">
                <div className="work-summary-section-title">
                  <Bot size={14} />
                  <strong>{language === 'zh' ? '子 Agent 派发' : 'Subagent dispatches'}</strong>
                  <span>{subagentTasks.length}</span>
                </div>
                <div className="work-summary-subagent-list">
                  {visibleSubagentTasks.map((task) => (
                    <button
                      className="work-summary-subagent-task"
                      type="button"
                      key={subagentTaskIdentity(task)}
                      onClick={() => openWorkSummaryInspector({
                        kind: 'subagent-task',
                        sessionId,
                        task,
                        title: subagentTaskTitle(task, language),
                      })}
                    >
                      <span className={`work-summary-subagent-state ${subagentTaskTone(task)}`}>
                        {subagentTaskActive(task)
                          ? <LoaderCircle className="spin" size={13} />
                          : <CheckCircle2 size={13} />}
                      </span>
                      <span className="work-summary-subagent-main">
                        <strong>{subagentTaskTitle(task, language)}</strong>
                        {task.origin === 'team' && (
                          <span className="work-summary-subagent-tags">
                            {task.teamId && <em>Team · {task.teamId}</em>}
                            {task.teamMemberId && <em>{language === 'zh' ? '成员' : 'Member'} · {task.teamMemberId}</em>}
                            {task.agentProfileId && <em>Profile · {task.agentProfileId}</em>}
                          </span>
                        )}
                        <small title={task.requestPrompt || task.errorMessage}>
                          {task.requestPrompt || task.errorMessage || subagentTaskStatusLabel(task, language)}
                        </small>
                      </span>
                      <span className={`work-summary-subagent-status ${subagentTaskTone(task)}`}>
                        {subagentTaskStatusLabel(task, language)}
                      </span>
                      <ChevronRight size={14} />
                    </button>
                  ))}
                </div>
                {remainingSubagentTaskCount > 0 && (
                  <button
                    className="work-summary-history-more"
                    type="button"
                    onClick={() => setVisibleSubagentTaskCount(
                      (current) => current + subagentTaskPageSize,
                    )}
                  >
                    {language === 'zh'
                      ? `显示更早的 ${Math.min(subagentTaskPageSize, remainingSubagentTaskCount)} 个子任务`
                      : `Show ${Math.min(subagentTaskPageSize, remainingSubagentTaskCount)} earlier tasks`}
                    <ChevronDown size={13} />
                  </button>
                )}
              </div>
            )}

            {historyCount > 0 && (
              <div className="work-summary-section work-summary-history" data-testid="work-summary-history">
                <div className="work-summary-section-title">
                  <Clock3 size={14} />
                  <strong>{language === 'zh' ? '历史记录' : 'History'}</strong>
                  <span>
                    {historyGroups.length} {language === 'zh' ? '回合' : 'turns'}
                  </span>
                  <button
                    className="work-summary-history-all"
                    type="button"
                    onClick={() => openWorkSummaryInspector({
                      kind: 'turn-history',
                      sessionId,
                      title: language === 'zh' ? '全部回合详情' : 'All turn details',
                    })}
                  >
                    {language === 'zh' ? '全部详情' : 'All details'}
                    <ChevronRight size={13} />
                  </button>
                </div>
                <div className="work-summary-history-list">
                  {visibleHistoryGroups.map((group) => (
                    <button
                      className="work-summary-history-turn"
                      type="button"
                      key={group.id}
                      onClick={() => openWorkSummaryInspector({
                        kind: 'turn-history',
                        sessionId,
                        turnId: group.turnId || group.id,
                        title: historyTurnLabel(group, language),
                      })}
                    >
                      <span className="work-summary-history-turn-main">
                        <strong title={group.prompt}>{historyTurnLabel(group, language)}</strong>
                      </span>
                      <span className="work-summary-history-turn-meta">
                        <small>{historyTurnTimestamp(group.message, language)}</small>
                      </span>
                      <ChevronRight size={14} />
                    </button>
                  ))}
                </div>
                {remainingHistoryTurnCount > 0 && (
                  <button
                    className="work-summary-history-more"
                    type="button"
                    onClick={() => setVisibleHistoryTurnCount((current) => current + historyTurnPageSize)}
                  >
                    {language === 'zh'
                      ? `显示更早的 ${Math.min(historyTurnPageSize, remainingHistoryTurnCount)} 个回合`
                      : `Show ${Math.min(historyTurnPageSize, remainingHistoryTurnCount)} earlier turns`}
                    <ChevronDown size={13} />
                  </button>
                )}
              </div>
            )}
        </section>
      </div>
    </aside>
  );
}

function useSubagentTaskFeed(sessionId: string, available: boolean) {
  const [tasks, setTasks] = useState<SubagentTaskSnapshot[]>([]);
  const hasActiveTasks = tasks.some(subagentTaskActive);

  const mergeTasks = useCallback((incoming: SubagentTaskSnapshot[]) => {
    setTasks((current) => mergeSubagentTasks(current, incoming));
  }, []);

  const refresh = useCallback((signal?: AbortSignal) => {
    const normalized = sessionId.trim();
    if (!available || !normalized) return Promise.resolve();
    return fetchSubagentTasks(normalized, { limit: 100, signal }).then((snapshots) => {
      if (signal?.aborted) return;
      mergeTasks(snapshots);
    });
  }, [available, mergeTasks, sessionId]);

  useEffect(() => {
    setTasks([]);
    if (!available || !sessionId.trim()) return undefined;
    const controller = new AbortController();
    void refresh(controller.signal).catch(() => undefined);

    const receiveDispatch = (rawEvent: Event) => {
      const event = (rawEvent as CustomEvent<SubagentDispatchEvent>).detail;
      if (!event || event.parentSessionId.trim() !== sessionId.trim()) return;
      const provisional = subagentTaskFromDispatchEvent(event);
      mergeTasks([provisional]);
      if (event.taskId) {
        void fetchSubagentTask(event.taskId, controller.signal)
          .then((task) => mergeTasks([task]))
          .catch(() => undefined);
      }
    };
    const refreshVisible = () => {
      if (document.visibilityState === 'visible') {
        void refresh(controller.signal).catch(() => undefined);
      }
    };
    window.addEventListener(SUBAGENT_DISPATCH_UI_EVENT, receiveDispatch);
    window.addEventListener('focus', refreshVisible);
    document.addEventListener('visibilitychange', refreshVisible);
    return () => {
      controller.abort();
      window.removeEventListener(SUBAGENT_DISPATCH_UI_EVENT, receiveDispatch);
      window.removeEventListener('focus', refreshVisible);
      document.removeEventListener('visibilitychange', refreshVisible);
    };
  }, [available, mergeTasks, refresh, sessionId]);

  useEffect(() => {
    const normalized = sessionId.trim();
    if (!available || !normalized) return undefined;
    const controller = new AbortController();
    const refreshTaskFeed = () => {
      if (document.visibilityState !== 'visible') return;
      void refresh(controller.signal).catch(() => undefined);
    };
    const timer = window.setInterval(refreshTaskFeed, hasActiveTasks ? 2500 : 10000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [available, hasActiveTasks, refresh, sessionId]);

  return tasks;
}

function subagentTaskFromDispatchEvent(event: SubagentDispatchEvent): SubagentTaskSnapshot {
  return {
    protocol: event.protocol,
    taskId: event.taskId,
    toolCallId: event.toolCallId,
    parentSessionId: event.parentSessionId,
    parentTurnId: event.parentTurnId,
    childSessionId: event.childSessionId,
    childTurnId: event.childTurnId,
    agentName: event.agentName,
    origin: event.origin,
    teamId: event.teamId,
    teamMemberId: event.teamMemberId,
    agentProfileId: event.agentProfileId,
    status: event.status || event.phase,
    terminal: event.terminal,
    accepted: event.accepted,
    errorMessage: event.errorCode,
    reviewStatus: event.reviewStatus,
    contractState: event.contractState,
    detailEndpoint: event.detailEndpoint,
    report: {},
    review: {},
    contractEvaluation: {},
    executionContract: {},
    workerProposal: {},
    mergePlan: {},
    usage: {},
    raw: event.raw,
  };
}

function mergeSubagentTasks(
  current: SubagentTaskSnapshot[],
  incoming: SubagentTaskSnapshot[],
) {
  const next = [...current];
  for (const task of incoming) {
    const existingIndex = next.findIndex((candidate) => subagentTaskMatches(candidate, task));
    if (existingIndex < 0) {
      next.push(task);
      continue;
    }
    const existing = next[existingIndex];
    const incomingIsNewer = subagentTaskIsNewer(existing, task);
    const preferred = incomingIsNewer ? task : existing;
    const fallback = incomingIsNewer ? existing : task;
    next[existingIndex] = {
      ...fallback,
      ...preferred,
      taskId: preferred.taskId || fallback.taskId,
      toolCallId: preferred.toolCallId || fallback.toolCallId,
      requestPrompt: preferred.requestPrompt || fallback.requestPrompt,
      responsePrompt: preferred.responsePrompt || fallback.responsePrompt,
      errorMessage: preferred.errorMessage || fallback.errorMessage,
      raw: { ...fallback.raw, ...preferred.raw },
    };
  }
  return next.sort((left, right) => subagentTaskTime(right) - subagentTaskTime(left));
}

function subagentTaskIsNewer(
  existing: SubagentTaskSnapshot,
  incoming: SubagentTaskSnapshot,
) {
  const existingTime = subagentTaskTime(existing);
  const incomingTime = subagentTaskTime(incoming);
  if (existingTime > 0 && incomingTime > 0 && incomingTime !== existingTime) {
    return incomingTime > existingTime;
  }
  if (existing.terminal && !incoming.terminal) return false;
  if (!existing.terminal && incoming.terminal) return true;
  return true;
}

function subagentTaskMatches(left: SubagentTaskSnapshot, right: SubagentTaskSnapshot) {
  return Boolean(
    (left.taskId && right.taskId && left.taskId === right.taskId) ||
      (left.toolCallId && right.toolCallId && left.toolCallId === right.toolCallId),
  );
}

function subagentTaskIdentity(task: SubagentTaskSnapshot) {
  return task.taskId || task.toolCallId || `${task.parentTurnId}:${task.status}`;
}

function subagentTaskTime(task: SubagentTaskSnapshot) {
  const parsed = Date.parse(task.updatedAt || task.createdAt || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function subagentTaskActive(task: SubagentTaskSnapshot) {
  return task.status === 'running';
}

function subagentTaskTone(task: SubagentTaskSnapshot) {
  if (task.status === 'failed' || task.status === 'stopped') return 'failed';
  if (task.status === 'completed' && task.reviewStatus !== 'accepted') {
    return 'review';
  }
  if (task.reviewStatus === 'accepted') return 'complete';
  return 'running';
}

function subagentTaskTitle(task: SubagentTaskSnapshot, language: AppLanguage) {
  if (task.agentName?.trim()) return task.agentName.trim();
  if (task.origin === 'team' && task.teamMemberId?.trim()) return task.teamMemberId.trim();
  if (task.taskId?.trim()) {
    const compact = task.taskId.trim().replace(/^subagent[_:-]?/i, '').slice(0, 8);
    return language === 'zh' ? `子任务 ${compact}` : `Task ${compact}`;
  }
  return language === 'zh' ? '正在派发子 Agent' : 'Dispatching subagent';
}

function subagentTaskStatusLabel(task: SubagentTaskSnapshot, language: AppLanguage) {
  if (task.status === 'running') {
    return language === 'zh' ? '运行中' : 'Running';
  }
  if (task.status === 'completed') {
    return task.reviewStatus === 'accepted'
      ? language === 'zh' ? '父级已接受' : 'Accepted by parent'
      : language === 'zh' ? '待父级审查' : 'Awaiting parent review';
  }
  if (task.status === 'stopped') return language === 'zh' ? '已停止' : 'Stopped';
  return language === 'zh' ? '未完成' : 'Not completed';
}
