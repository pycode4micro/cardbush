import { uiText } from '../../i18n';
import { ConversationHostContext } from '../conversationHost';
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileOutput,
  LoaderCircle,
  CircleStop,
  TriangleAlert,
} from 'lucide-react';
import { useCallback, useContext, useEffect, useMemo, useState, type HTMLAttributes } from 'react';

import {
  fetchSubagentTask,
  fetchSubagentTasks,
} from '../../backend/api';
import { openFileContextMenu } from '../../shared/fileContextMenu';
import type {
  AppLanguage,
  ChatMessage,
  SubagentDispatchEvent,
  SubagentTaskSnapshot,
} from '../../types';
import {
  summarizeChangeReports,
  type ConversationChangeReport,
} from '../tools';
import {
  openWorkSummaryInspector,
  SUBAGENT_DISPATCH_UI_EVENT,
} from '../subagents/subagentObservabilityEvents';
import { subagentTaskPresentation } from '../subagents/subagentTaskPresentation';
import { FileTypeIcon } from '../chatMessages/FileTypeIcon';
import { openInspector, openMediaInspector } from '../inspector/inspectorEvents';
import type { ProjectPathAlias } from '../conversationScope';
import { workSummaryOutputs } from './workSummaryOutputs';
import { TeamWorkSummary } from '../team/TeamWorkSummary';
import { isEmployeeTask } from '../team/employeePresentation';
import { withConversationAgentNames } from '../team/toolAgentActivity';
import { conversationTaskPlan } from './conversationTaskPlan';
import { RuntimeTaskPlan } from './TurnRuntimeDetails';
const subagentTaskPageSize = 3;
const outputPageSize = 5;
const noPathAliases: ProjectPathAlias[] = [];

export function ConversationWorkSummary({
  language,
  sessionId,
  messages,
  changeReports,
  onOpenChangeReview,
  workspaceRoot = '',
  pathAliases = noPathAliases,
  subagentObservabilityAvailable = false,
  softVisible = true,
  running = false,
  activeTurnId = '',
  hoverProps,
  keepOpenUntil,
}: {
  language: AppLanguage;
  sessionId: string;
  messages: ChatMessage[];
  changeReports: ConversationChangeReport[];
  onOpenChangeReview: (filePath?: string) => void;
  workspaceRoot?: string;
  pathAliases?: ProjectPathAlias[];
  subagentObservabilityAvailable?: boolean;
  softVisible?: boolean;
  running?: boolean;
  activeTurnId?: string;
  hoverProps?: HTMLAttributes<HTMLElement>;
  keepOpenUntil?: (completion: Promise<unknown>) => void;
}) {
  const host = useContext(ConversationHostContext);
  const openSummary = host?.openWorkSummary ?? openWorkSummaryInspector;
  const [visibleSubagentTaskCount, setVisibleSubagentTaskCount] = useState(subagentTaskPageSize);
  const [outputsExpanded, setOutputsExpanded] = useState(false);
  const taskFeed = useSubagentTaskFeed(sessionId, subagentObservabilityAvailable);
  const allTasks = useMemo(() => childConversationSummaries(withConversationAgentNames(taskFeed, messages)), [taskFeed, messages]);
  const subagentTasks = allTasks.filter(task => !isEmployeeTask(task));
  const visibleSubagentTasks = subagentTasks.slice(0, visibleSubagentTaskCount);
  const remainingSubagentTaskCount = Math.max(
    0,
    subagentTasks.length - visibleSubagentTasks.length,
  );
  const changeSummary = useMemo(
    () => summarizeChangeReports(changeReports),
    [changeReports],
  );
  const outputs = useMemo(
    () => workSummaryOutputs(messages, changeReports, workspaceRoot, pathAliases),
    [messages, changeReports, workspaceRoot, pathAliases],
  );
  const recentOutputs = outputsExpanded ? outputs : outputs.slice(0, outputPageSize);
  const plan = useMemo(() => conversationTaskPlan(messages, running ? activeTurnId : ''),
    [messages, running, activeTurnId]);

  useEffect(() => {
    setVisibleSubagentTaskCount(subagentTaskPageSize);
    setOutputsExpanded(false);
  }, [sessionId]);

  return (
    <aside
      {...hoverProps}
      className={`conversation-work-summary soft-panel-motion ${softVisible ? 'soft-panel-visible' : 'soft-panel-hidden'}`}
      aria-hidden={!softVisible}
    >
      <div className="work-summary-content">
        <section className="work-summary-overview">
            <header className="work-summary-header">
              <div>
                <span className="work-summary-kicker">
                  {uiText(language)('conversationWorkSummary.currentConversation')}
                </span>
                <h2>{uiText(language)('conversationWorkSummary.workSummary')}</h2>
              </div>
              <div className="work-summary-metrics">
                <span>{outputs.length} {uiText(language)('conversationWorkSummary.outputs')}</span>
              </div>
            </header>

            {plan && <div className="work-summary-section work-summary-plan">
              <RuntimeTaskPlan plan={plan} language={language} running={running} />
            </div>}

            <div className="work-summary-section outputs">
              <div className="work-summary-section-title">
                <FileOutput size={14} />
                <strong>{uiText(language)('conversationWorkSummary.recentOutputs')}</strong>
                <span>{outputs.length}</span>
              </div>
              {recentOutputs.length > 0 ? (
                <div className="work-summary-file-list">
                  {recentOutputs.map((output) => (
                    <button
                      type="button"
                      key={output.key}
                      title={output.path.startsWith('data:') ? output.name : output.path}
                      onContextMenu={host ? undefined : event => {
                        const completion = openFileContextMenu(event, output.path, { language });
                        if (completion) keepOpenUntil?.(completion);
                      }}
                      onClick={() => {
                        if (host) { if (output.change && output.type === 'document') onOpenChangeReview(output.change.path); else host.openFile(output.path); return; }
                        if (output.type !== 'document') openMediaInspector(output.path, output.type, output.name);
                        else if (output.change) onOpenChangeReview(output.change.path);
                        else openInspector(output.path, output.name);
                      }}
                    >
                      <FileTypeIcon path={output.path} fileName={output.name} mediaType={output.type === 'document' ? undefined : output.type} />
                      <span className="work-summary-file-name">{output.name}</span>
                      {output.change && output.type === 'document' ? (
                        <small><b>+{output.change.additions}</b><i>-{output.change.deletions}</i></small>
                      ) : (
                        <small>{uiText(language)(`output.type.${output.type}`)}</small>
                      )}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="work-summary-empty">{uiText(language)('conversationWorkSummary.noOutputsYet')}</p>
              )}
              {(outputs.length > outputPageSize || changeSummary) && (
                <div className="work-summary-output-actions">
                  {outputs.length > outputPageSize && (
                    <button type="button" aria-expanded={outputsExpanded} onClick={() => setOutputsExpanded(value => !value)}>
                      {outputsExpanded
                        ? uiText(language)('conversationWorkSummary.showLess')
                        : uiText(language)('conversationWorkSummary.showMore', { value1: outputs.length - outputPageSize })}
                      <ChevronDown size={12} />
                    </button>
                  )}
                  {changeSummary && (
                    <button type="button" onClick={() => onOpenChangeReview()}>
                      {uiText(language)('conversationWorkSummary.reviewAllChanges')}
                    </button>
                  )}
                </div>
              )}
            </div>

            <TeamWorkSummary key={sessionId} messages={messages} tasks={allTasks.filter(isEmployeeTask)} sessionId={sessionId} language={language} />
            {subagentTasks.length > 0 && (
              <div className="work-summary-section work-summary-subagents" data-testid="work-summary-subagents">
                <div className="work-summary-section-title">
                  <strong>{uiText(language)('conversationWorkSummary.subagentDispatches')}</strong>
                  <span>{subagentTasks.length}</span>
                </div>
                <div className="work-summary-subagent-list">
                  {visibleSubagentTasks.map((task) => {
                    const status = subagentTaskPresentation(task, language);
                    return (
                      <button
                        className="work-summary-subagent-task"
                        type="button"
                        key={subagentTaskIdentity(task)}
                        onClick={() => openSummary({
                          kind: 'subagent-task',
                          sessionId,
                          task,
                          title: subagentTaskTitle(task, language),
                        })}
                      >
                        <span className={`work-summary-subagent-state ${status.tone}`}>
                          {subagentTaskActive(task)
                            ? <LoaderCircle className="spin" size={13} />
                            : task.status === 'failed'
                              ? <TriangleAlert size={13} />
                              : task.status === 'stopped'
                                ? <CircleStop size={13} />
                                : <CheckCircle2 size={13} />}
                        </span>
                        <span className="work-summary-subagent-main">
                          <strong>{subagentTaskTitle(task, language)}</strong>
                          {task.origin === 'team' && (
                            <span className="work-summary-subagent-tags">
                              {task.teamId && <em>{uiText(language)('conversationWorkSummary.team')}{task.teamId}</em>}
                              {task.teamMemberId && <em>{uiText(language)('conversationWorkSummary.member')} · {task.teamMemberId}</em>}
                              {task.agentProfileId && <em>{uiText(language)('conversationWorkSummary.profile')}{task.agentProfileId}</em>}
                            </span>
                          )}
                          <small title={task.requestPrompt || task.errorMessage}>
                            {task.requestPrompt || task.errorMessage || status.label}
                          </small>
                        </span>
                        <span className={`work-summary-subagent-status ${status.tone}`}>
                          {status.label}
                        </span>
                        <ChevronRight size={14} />
                      </button>
                    );
                  })}
                </div>
                {remainingSubagentTaskCount > 0 && (
                  <button
                    className="work-summary-history-more"
                    type="button"
                    onClick={() => setVisibleSubagentTaskCount(
                      (current) => current + subagentTaskPageSize,
                    )}
                  >
                    {uiText(language)('conversationWorkSummary.showEarlierTasks', { value1: Math.min(subagentTaskPageSize, remainingSubagentTaskCount) })}
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
  const host = useContext(ConversationHostContext);
  sessionId = host?.sessionId ?? sessionId;
  const [tasks, setTasks] = useState<SubagentTaskSnapshot[]>([]);
  const hasActiveTasks = tasks.some(subagentTaskActive);

  const mergeTasks = useCallback((incoming: SubagentTaskSnapshot[]) => {
    setTasks((current) => mergeSubagentTasks(current, incoming));
  }, []);

  const refresh = useCallback((signal?: AbortSignal) => {
    const normalized = sessionId.trim();
    if (!available || !normalized) return Promise.resolve();
    return fetchSubagentTasks(normalized, { limit: 100, signal }, host?.runtime).then((snapshots) => {
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
        void fetchSubagentTask(event.taskId, controller.signal, sessionId, host?.runtime)
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
    detailEndpoint: event.detailEndpoint,
    usage: {},
    raw: event.raw,
  };
}

/** A resumed child is another turn in the same conversation, not another Agent. */
function childConversationSummaries(tasks: SubagentTaskSnapshot[]) {
  const conversations = new Map<string, SubagentTaskSnapshot>();
  for (const task of [...tasks].sort((a, b) => subagentTaskTime(a) - subagentTaskTime(b))) {
    const key = task.childSessionId ? `${task.remote?.connectionId ?? ''}:${task.childSessionId}` : subagentTaskIdentity(task);
    const original = conversations.get(key);
    conversations.set(key, original ? { ...original, status: task.status, terminal: task.terminal,
      responsePrompt: task.responsePrompt, errorMessage: task.errorMessage, updatedAt: task.updatedAt,
      completedAt: task.completedAt, usage: task.usage } : task);
  }
  return [...conversations.values()].sort((a, b) => subagentTaskTime(b) - subagentTaskTime(a));
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
      agentName: preferred.agentName || fallback.agentName,
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

function subagentTaskTitle(task: SubagentTaskSnapshot, language: AppLanguage) {
  if (task.agentName?.trim()) return task.agentName.trim();
  if (task.origin === 'team' && task.teamMemberId?.trim()) return task.teamMemberId.trim();
  if (task.taskId?.trim()) {
    const compact = task.taskId.trim().replace(/^subagent[_:-]?/i, '').slice(0, 8);
    return uiText(language)('conversationWorkSummary.task', { compact });
  }
  return uiText(language)('conversationWorkSummary.dispatchingSubagent');
}
