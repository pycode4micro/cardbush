import {
  CheckCircle2,
  ChevronDown,
  Clock3,
  FileText,
  LoaderCircle,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { fetchSubagentTask, fetchTurnSnapshot } from '../../backend/api';
import type {
  AppLanguage,
  ChatMessage,
  SubagentDispatchEvent,
  SubagentTaskSnapshot,
} from '../../types';
import { AssistantLoopHistoryBlock } from '../chatMessages';
import {
  SUBAGENT_DISPATCH_UI_EVENT,
  type WorkSummaryInspectorDetail,
} from '../subagents/subagentObservabilityEvents';
import {
  groupWorkSummaryHistoryByTurn,
  historyTurnLabel,
  historyTurnTimestamp,
} from './workSummaryHistory';

export function WorkSummaryInspector({
  detail,
  messages,
  language,
}: {
  detail: WorkSummaryInspectorDetail;
  messages: ChatMessage[];
  language: AppLanguage;
}) {
  if (detail.kind === 'turn-history') {
    return (
      <TurnHistoryInspector
        detail={detail}
        messages={messages}
        language={language}
      />
    );
  }
  return <SubagentTaskInspector detail={detail} language={language} />;
}

function TurnHistoryInspector({
  detail,
  messages,
  language,
}: {
  detail: Extract<WorkSummaryInspectorDetail, { kind: 'turn-history' }>;
  messages: ChatMessage[];
  language: AppLanguage;
}) {
  const groups = useMemo(() => {
    const all = groupWorkSummaryHistoryByTurn(messages);
    if (!detail.turnId) return all;
    return all.filter((group) => (group.turnId || group.id) === detail.turnId);
  }, [detail.turnId, messages]);
  const turnSelectorRef = useRef<HTMLDetailsElement | null>(null);
  const turnNodesRef = useRef(new Map<string, HTMLElement>());

  const jumpToTurn = useCallback((groupId: string) => {
    turnNodesRef.current.get(groupId)?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
    turnSelectorRef.current?.removeAttribute('open');
  }, []);

  return (
    <section className="work-summary-inspector work-summary-turn-inspector">
      <header className="work-summary-inspector-heading">
        <Clock3 size={17} />
        <div>
          <strong>{detail.title || (language === 'zh' ? '回合执行详情' : 'Turn execution details')}</strong>
          <small>
            {language === 'zh' ? '完整消息、计划与工具记录' : 'Messages, plans, and tool activity'}
          </small>
        </div>
        {groups.length > 1 && (
          <details className="work-summary-turn-selector" ref={turnSelectorRef}>
            <summary title={language === 'zh' ? '快速选择回合' : 'Quickly select a turn'}>
              <span>{language === 'zh' ? '选择回合' : 'Select turn'}</span>
              <ChevronDown size={13} />
            </summary>
            <div className="work-summary-turn-selector-menu">
              {groups.map((group) => (
                <button
                  type="button"
                  key={group.id}
                  title={group.prompt}
                  onClick={() => jumpToTurn(group.id)}
                >
                  <span>{historyTurnLabel(group, language)}</span>
                  {historyTurnTimestamp(group.message, language) && (
                    <small>{historyTurnTimestamp(group.message, language)}</small>
                  )}
                </button>
              ))}
            </div>
          </details>
        )}
      </header>
      {groups.length > 0 ? (
        <div className="work-summary-inspector-turn-list">
          {groups.map((group) => (
            <article
              className="work-summary-inspector-turn"
              key={group.id}
              ref={(node) => {
                if (node) turnNodesRef.current.set(group.id, node);
                else turnNodesRef.current.delete(group.id);
              }}
            >
              <header>
                <div>
                  <strong title={group.prompt}>{historyTurnLabel(group, language)}</strong>
                </div>
                <span>{historyTurnTimestamp(group.message, language)}</span>
              </header>
              <AssistantLoopHistoryBlock
                history={group.history}
                archivedPlan={group.message.taskPlan && !group.message.taskPlan.active
                  ? group.message.taskPlan
                  : undefined}
                language={language}
              />
            </article>
          ))}
        </div>
      ) : (
        <div className="work-summary-inspector-empty">
          <FileText size={18} />
          <span>{language === 'zh' ? '该回合没有可恢复的执行详情' : 'No recoverable execution details for this turn'}</span>
        </div>
      )}
    </section>
  );
}

function SubagentTaskInspector({
  detail,
  language,
}: {
  detail: Extract<WorkSummaryInspectorDetail, { kind: 'subagent-task' }>;
  language: AppLanguage;
}) {
  const [task, setTask] = useState(detail.task);
  const [childTurn, setChildTurn] = useState<Record<string, unknown> | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState('');

  useEffect(() => setTask(detail.task), [detail.task]);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const taskId = task.taskId?.trim();
    if (!taskId) return;
    setRefreshing(true);
    try {
      const next = await fetchSubagentTask(taskId, signal);
      if (!signal?.aborted) {
        setTask((current) => mergeTask(current, next));
        const childTurnId = next.childTurnId?.trim() || task.childTurnId?.trim();
        if (childTurnId) {
          const snapshot = await fetchTurnSnapshot(childTurnId, signal);
          if (!signal?.aborted) setChildTurn(snapshot);
        }
        setRefreshError('');
      }
    } catch (caught) {
      if (!signal?.aborted) {
        setRefreshError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      if (!signal?.aborted) setRefreshing(false);
    }
  }, [task.childTurnId, task.taskId]);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const receiveDispatch = (rawEvent: Event) => {
      const event = (rawEvent as CustomEvent<SubagentDispatchEvent>).detail;
      if (!event || event.parentSessionId !== detail.sessionId) return;
      const matches = (
        event.taskId && task.taskId && event.taskId === task.taskId
      ) || (
        event.toolCallId && task.toolCallId && event.toolCallId === task.toolCallId
      );
      if (!matches) return;
      setTask((current) => mergeTask(current, taskFromDispatch(event)));
      if (event.taskId) void fetchSubagentTask(event.taskId, controller.signal)
        .then((next) => setTask((current) => mergeTask(current, next)))
        .catch(() => undefined);
    };
    window.addEventListener(SUBAGENT_DISPATCH_UI_EVENT, receiveDispatch);
    return () => {
      controller.abort();
      window.removeEventListener(SUBAGENT_DISPATCH_UI_EVENT, receiveDispatch);
    };
  }, [detail.sessionId, refresh, task.taskId, task.toolCallId]);

  const status = subagentInspectorStatus(task, language);
  const active = task.status === 'running';

  useEffect(() => {
    if (!active || !task.taskId?.trim()) return undefined;
    const controller = new AbortController();
    const refreshActiveTask = () => {
      if (document.visibilityState !== 'visible') return;
      void refresh(controller.signal);
    };
    const timer = window.setInterval(refreshActiveTask, 2500);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [active, refresh, task.taskId]);
  const reportSummary = stringValue(task.report.summary);
  const remainingWork = stringList(task.report.remaining_work ?? task.report.remainingWork);
  const requestedCapabilities = stringList(
    task.report.requested_capabilities ?? task.report.requestedCapabilities,
  );
  const permissionRequirements = stringList(
    task.raw.permission_requirements ?? task.raw.permissionRequirements,
  );

  return (
    <section className="work-summary-inspector subagent-task-inspector">
      <header className="work-summary-inspector-heading subagent">
        <span className={`subagent-inspector-state ${status.tone}`}>
          {active
            ? <LoaderCircle className="spin" size={17} />
            : status.tone === 'failed'
              ? <TriangleAlert size={17} />
              : <CheckCircle2 size={17} />}
        </span>
        <div>
          <strong>{task.agentName || task.teamMemberId || detail.title || (language === 'zh' ? '子 Agent 任务' : 'Subagent task')}</strong>
          <small>{status.label}</small>
        </div>
        <button
          type="button"
          disabled={!task.taskId || refreshing}
          onClick={() => void refresh()}
          title={language === 'zh' ? '刷新任务详情' : 'Refresh task details'}
        >
          <RefreshCw className={refreshing ? 'spin' : ''} size={15} />
        </button>
      </header>

      {refreshError && <div className="subagent-inspector-error">{refreshError}</div>}

      <div className="subagent-inspector-facts">
        <Fact label={language === 'zh' ? '任务 ID' : 'Task ID'} value={task.taskId || (language === 'zh' ? '等待分配' : 'Awaiting assignment')} />
        <Fact label={language === 'zh' ? '工具调用' : 'Tool call'} value={task.toolCallId || '-'} />
        <Fact label={language === 'zh' ? '父级回合' : 'Parent turn'} value={task.parentTurnId || '-'} />
        <Fact label={language === 'zh' ? '子级回合' : 'Child turn'} value={task.childTurnId || '-'} />
        <Fact label={language === 'zh' ? '子会话' : 'Child session'} value={task.childSessionId || '-'} />
        {task.origin === 'team' && <Fact label="Team" value={task.teamId || '-'} />}
        {task.origin === 'team' && <Fact label={language === 'zh' ? '成员' : 'Member'} value={task.teamMemberId || '-'} />}
        {task.origin === 'team' && <Fact label="Profile" value={task.agentProfileId || '-'} />}
        <Fact label={language === 'zh' ? '审查状态' : 'Review status'} value={task.reviewStatus || (language === 'zh' ? '待审查' : 'Pending')} />
        <Fact label={language === 'zh' ? '契约状态' : 'Contract state'} value={task.contractState || '-'} />
      </div>

      {task.requestPrompt && (
        <InspectorSection title={language === 'zh' ? '派发任务' : 'Dispatch prompt'}>
          <p>{task.requestPrompt}</p>
        </InspectorSection>
      )}
      {(reportSummary || task.responsePrompt) && (
        <InspectorSection title={language === 'zh' ? '子级结果' : 'Child result'}>
          <p>{reportSummary || task.responsePrompt}</p>
        </InspectorSection>
      )}
      {remainingWork.length > 0 && (
        <InspectorSection title={language === 'zh' ? '剩余工作' : 'Remaining work'}>
          <ul>{remainingWork.map((item) => <li key={item}>{item}</li>)}</ul>
        </InspectorSection>
      )}
      {requestedCapabilities.length > 0 && (
        <InspectorSection title={language === 'zh' ? '请求的能力' : 'Requested capabilities'}>
          <div className="subagent-inspector-chips">
            {requestedCapabilities.map((item) => <span key={item}>{item}</span>)}
          </div>
        </InspectorSection>
      )}
      {permissionRequirements.length > 0 && (
        <InspectorSection title={language === 'zh' ? '父 Agent 处理权限' : 'Parent-agent permissions'}>
          <p>{language === 'zh' ? '这些项目仅用于提示；子 Agent 不能在此直接获得授权。' : 'Informational only; the subagent cannot be authorized from this view.'}</p>
          <div className="subagent-inspector-chips">{permissionRequirements.map((item) => <span key={item}>{item}</span>)}</div>
        </InspectorSection>
      )}
      {task.errorMessage && (
        <InspectorSection title={language === 'zh' ? '错误' : 'Error'} tone="failed">
          <p>{task.errorMessage}</p>
        </InspectorSection>
      )}

      <details className="subagent-inspector-raw">
        <summary>{language === 'zh' ? '完整原始信息' : 'Complete raw details'}</summary>
        <pre>{JSON.stringify({ task: task.raw, child_turn: childTurn }, null, 2)}</pre>
      </details>
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong title={value}>{value}</strong></div>;
}

function InspectorSection({
  title,
  tone,
  children,
}: {
  title: string;
  tone?: 'failed';
  children: ReactNode;
}) {
  return <section className={`subagent-inspector-section ${tone ?? ''}`}><h3>{title}</h3>{children}</section>;
}

function mergeTask(current: SubagentTaskSnapshot, next: SubagentTaskSnapshot) {
  return {
    ...current,
    ...next,
    taskId: next.taskId || current.taskId,
    toolCallId: next.toolCallId || current.toolCallId,
    requestPrompt: next.requestPrompt || current.requestPrompt,
    responsePrompt: next.responsePrompt || current.responsePrompt,
    errorMessage: next.errorMessage || current.errorMessage,
    raw: { ...current.raw, ...next.raw },
  };
}

function taskFromDispatch(event: SubagentDispatchEvent): SubagentTaskSnapshot {
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

function subagentInspectorStatus(task: SubagentTaskSnapshot, language: AppLanguage) {
  if (task.status === 'running') return { tone: 'running', label: language === 'zh' ? '运行中' : 'Running' };
  if (task.status === 'completed') {
    if (task.reviewStatus === 'accepted') return { tone: 'complete', label: language === 'zh' ? '父级已接受' : 'Accepted by parent' };
    if (task.reviewStatus === 'rejected') return { tone: 'failed', label: language === 'zh' ? '父级已拒绝' : 'Rejected by parent' };
    if (task.reviewStatus === 'revision_requested') return { tone: 'review', label: language === 'zh' ? '需要修订' : 'Revision requested' };
    return { tone: 'review', label: language === 'zh' ? '待父级审查' : 'Awaiting parent review' };
  }
  return { tone: 'failed', label: language === 'zh' ? '任务未完成' : 'Task incomplete' };
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function stringList(value: unknown) {
  return Array.isArray(value)
    ? value.map((item) => String(item ?? '').trim()).filter(Boolean)
    : [];
}
