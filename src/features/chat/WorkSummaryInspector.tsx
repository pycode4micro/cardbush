import {
  CheckCircle2,
  CircleStop,
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
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { fetchSubagentTask, fetchTurnSnapshot } from '../../backend/api';
import { useOutsideDismiss } from '../../hooks/useOutsideDismiss';
import type {
  AppLanguage,
  ChatMessage,
  SubagentDispatchEvent,
  SubagentTaskSnapshot,
} from '../../types';
import { AssistantLoopHistoryBlock, MarkdownContent } from '../chatMessages';
import { FileMemoScope } from '../chatMessages/FileMemoScope';
import {
  SUBAGENT_DISPATCH_UI_EVENT,
  type WorkSummaryInspectorDetail,
} from '../subagents/subagentObservabilityEvents';
import { subagentTaskPresentation } from '../subagents/subagentTaskPresentation';
import {
  groupWorkSummaryHistoryByTurn,
  historyTurnLabel,
  historyTurnTimestamp,
} from './workSummaryHistory';

export function WorkSummaryInspector({
  detail,
  messages,
  language,
  active = true,
}: {
  detail: WorkSummaryInspectorDetail;
  messages: ChatMessage[];
  language: AppLanguage;
  active?: boolean;
}) {
  if (detail.kind === 'turn-history') {
    return (
      <TurnHistoryInspector
        detail={detail}
        messages={messages}
        language={language}
        active={active}
      />
    );
  }
  return <SubagentTaskInspector detail={detail} language={language} active={active} />;
}

function TurnHistoryInspector({
  detail,
  messages,
  language,
  active,
}: {
  detail: Extract<WorkSummaryInspectorDetail, { kind: 'turn-history' }>;
  messages: ChatMessage[];
  language: AppLanguage;
  active: boolean;
}) {
  const historyGroups = useMemo(() => groupWorkSummaryHistoryByTurn(messages), [messages]);
  const requestedTurnId = detail.turnId?.trim() || '';
  const groups = useMemo(() => requestedTurnId
    ? historyGroups.filter(group => (group.turnId || group.id) === requestedTurnId)
    : historyGroups, [historyGroups, requestedTurnId]);
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [selectedTurnId, setSelectedTurnId] = useState('');
  const selectorId = useId();
  const scrollRef = useRef<HTMLElement | null>(null);
  const headingRef = useRef<HTMLElement | null>(null);
  const turnSelectorRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const turnNodesRef = useRef(new Map<string, HTMLElement>());
  const appliedRequestRef = useRef<typeof detail | null>(null);
  const selectorContainers = useMemo(() => [turnSelectorRef], []);
  const closeSelector = useCallback((event?: Event) => {
    if (event instanceof KeyboardEvent && event.key === 'Escape') {
      triggerRef.current?.focus({ preventScroll: true });
    }
    setSelectorOpen(false);
  }, []);
  useOutsideDismiss(selectorOpen, selectorContainers, closeSelector);
  useEffect(() => { if (!active) closeSelector(); }, [active, closeSelector]);

  const jumpToTurn = useCallback((groupId: string, behavior: ScrollBehavior = 'smooth') => {
    const scroller = scrollRef.current;
    const turn = turnNodesRef.current.get(groupId);
    if (!scroller || !turn) return;
    scroller.scrollTo({
      top: scroller.scrollTop + turn.getBoundingClientRect().top
        - scroller.getBoundingClientRect().top - (headingRef.current?.offsetHeight ?? 0) - 14,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : behavior,
    });
    setSelectedTurnId(groupId);
    setSelectorOpen(false);
  }, []);

  // Explicit requests switch between one turn and all details in this session's
  // tab. Tab activation alone must not reset the reader's position.
  useLayoutEffect(() => {
    if (!active || appliedRequestRef.current === detail) return;
    setSelectorOpen(false);
    if (requestedTurnId) {
      const group = groups[0];
      if (!group) return;
      jumpToTurn(group.id, 'instant');
    } else {
      scrollRef.current?.scrollTo({ top: 0, behavior: 'instant' });
      setSelectedTurnId('');
    }
    appliedRequestRef.current = detail;
  }, [active, detail, groups, jumpToTurn, requestedTurnId]);

  return (
    <section className="work-summary-inspector work-summary-turn-inspector" ref={scrollRef}>
      <header className="work-summary-inspector-heading" ref={headingRef}>
        <Clock3 size={17} />
        <div>
          <strong>{detail.title || (requestedTurnId
            ? language === 'zh' ? '回合执行详情' : 'Turn execution details'
            : language === 'zh' ? '全部回合详情' : 'All turn details')}</strong>
          <small>
            {language === 'zh' ? '完整消息、计划与工具记录' : 'Messages, plans, and tool activity'}
          </small>
        </div>
        {groups.length > 1 && (
          <div className="work-summary-turn-selector" ref={turnSelectorRef}>
            <button type="button" ref={triggerRef}
              title={language === 'zh' ? '快速选择回合' : 'Quickly select a turn'}
              aria-expanded={selectorOpen} aria-haspopup="menu" aria-controls={selectorId}
              onClick={() => setSelectorOpen(open => !open)}>
              <span>{language === 'zh' ? '选择回合' : 'Select turn'}</span>
              <ChevronDown size={13} />
            </button>
            {selectorOpen && <div className="work-summary-turn-selector-menu" id={selectorId}
              role="menu" aria-label={language === 'zh' ? '选择回合' : 'Select turn'}>
              {groups.map((group) => (
                <button
                  type="button"
                  key={group.id}
                  title={group.prompt}
                  role="menuitem"
                  aria-current={selectedTurnId === group.id ? 'true' : undefined}
                  onClick={() => {
                    triggerRef.current?.focus({ preventScroll: true });
                    jumpToTurn(group.id);
                  }}
                >
                  <span>{historyTurnLabel(group, language)}</span>
                  {historyTurnTimestamp(group.message, language) && (
                    <small>{historyTurnTimestamp(group.message, language)}</small>
                  )}
                </button>
              ))}
            </div>}
          </div>
        )}
      </header>
      {groups.length > 0 ? (
        <div className="work-summary-inspector-turn-list">
          {groups.map((group) => (
            <article
              className="work-summary-inspector-turn"
              key={group.id}
              data-turn-id={group.id}
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
              <FileMemoScope sessionId={detail.sessionId} turnId={group.turnId || group.message.turnId}>
                <AssistantLoopHistoryBlock
                  history={group.history}
                  archivedPlan={group.message.taskPlan && !group.message.taskPlan.active
                    ? group.message.taskPlan
                    : undefined}
                  language={language}
                />
              </FileMemoScope>
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
  active,
}: {
  detail: Extract<WorkSummaryInspectorDetail, { kind: 'subagent-task' }>;
  language: AppLanguage;
  active: boolean;
}) {
  const [task, setTask] = useState(detail.task);
  const [childTurn, setChildTurn] = useState<Record<string, unknown> | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState('');
  const [turnDetailError, setTurnDetailError] = useState('');
  const refreshSequence = useRef(0);

  useEffect(() => setTask(current => current.taskId === detail.task.taskId
    ? mergeTask(current, detail.task) : detail.task), [detail.task]);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const taskId = task.taskId?.trim();
    if (!taskId) return;
    const sequence = ++refreshSequence.current;
    const isCurrent = () => !signal?.aborted && sequence === refreshSequence.current;
    setRefreshing(true);
    try {
      const next = await fetchSubagentTask(taskId, signal, detail.sessionId);
      if (!isCurrent()) return;
      let snapshot: Record<string, unknown> | null = null;
      let detailError = '';
      if (next.childTurnId && next.childSessionId && next.terminal) {
        try {
          snapshot = await fetchTurnSnapshot(next.childTurnId, { sessionId: next.childSessionId, signal });
        } catch (caught) {
          detailError = caught instanceof Error ? caught.message : String(caught);
        }
      }
      if (isCurrent()) {
        // Publish together so settling the polling effect cannot abort its own
        // final transcript read. A detail read failure never changes task status.
        setTask((current) => mergeTask(current, next));
        setChildTurn(snapshot);
        setTurnDetailError(detailError);
        setRefreshError('');
      }
    } catch (caught) {
      if (isCurrent()) {
        setRefreshError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      if (isCurrent()) setRefreshing(false);
    }
  }, [detail.sessionId, task.taskId]);

  useEffect(() => {
    if (!active) return;
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
      if (event.taskId) void refresh(controller.signal);
    };
    window.addEventListener(SUBAGENT_DISPATCH_UI_EVENT, receiveDispatch);
    return () => {
      controller.abort();
      window.removeEventListener(SUBAGENT_DISPATCH_UI_EVENT, receiveDispatch);
    };
  }, [active, detail.sessionId, refresh, task.taskId, task.toolCallId]);

  const status = subagentTaskPresentation(task, language);
  const running = task.status === 'running';

  useEffect(() => {
    if (!active || !running || !task.taskId?.trim()) return undefined;
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
  }, [active, running, refresh, task.taskId]);
  const permissionRequirements = stringList(
    task.raw.permission_requirements ?? task.raw.permissionRequirements,
  );

  return (
    <section className="work-summary-inspector subagent-task-inspector">
      <header className="work-summary-inspector-heading subagent">
        <span className={`subagent-inspector-state ${status.tone}`}>
          {running
            ? <LoaderCircle className="spin" size={17} />
            : status.tone === 'failed'
              ? <TriangleAlert size={17} />
              : task.status === 'stopped'
                ? <CircleStop size={17} />
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
        <Fact label={language === 'zh' ? '执行状态' : 'Execution status'} value={status.label} />
        {task.completedAt && <Fact label={language === 'zh' ? '结束时间' : 'Finished at'} value={new Date(task.completedAt).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US')} />}
      </div>

      {task.requestPrompt && (
        <InspectorSection title={language === 'zh' ? '派发任务' : 'Dispatch prompt'}>
          <FileMemoScope sessionId={detail.sessionId} turnId={task.parentTurnId}>
            <MarkdownContent content={task.requestPrompt} language={language} />
          </FileMemoScope>
        </InspectorSection>
      )}
      {task.responsePrompt && (
        <InspectorSection title={language === 'zh' ? '子级结果' : 'Child result'}>
          <FileMemoScope sessionId={task.childSessionId} turnId={task.childTurnId}>
            <MarkdownContent content={task.responsePrompt} language={language} />
          </FileMemoScope>
        </InspectorSection>
      )}
      {permissionRequirements.length > 0 && (
        <InspectorSection title={language === 'zh' ? '父 Agent 处理权限' : 'Parent-agent permissions'}>
          <p>{language === 'zh' ? '这些项目仅用于提示；子 Agent 不能在此直接获得授权。' : 'Informational only; the subagent cannot be authorized from this view.'}</p>
          <div className="subagent-inspector-chips">{permissionRequirements.map((item) => <span key={item}>{item}</span>)}</div>
        </InspectorSection>
      )}
      {task.errorMessage && (
        <InspectorSection
          title={task.status === 'stopped'
            ? language === 'zh' ? '停止原因' : 'Stop reason'
            : language === 'zh' ? '错误' : 'Error'}
          tone={task.status === 'stopped' ? undefined : 'failed'}
        >
          <p>{task.status === 'stopped' && task.errorMessage === 'turn_stop_requested'
            ? language === 'zh' ? '任务已按停止请求结束。' : 'The task ended following a stop request.'
            : task.errorMessage}</p>
        </InspectorSection>
      )}

      <details className="subagent-inspector-raw">
        <summary>{language === 'zh' ? '完整原始信息' : 'Complete raw details'}</summary>
        {!childTurn && <p>{running
          ? language === 'zh' ? '回合记录将在任务结束后提供。' : 'The turn transcript will be available when the task ends.'
          : language === 'zh' ? '暂未取得回合详情，可刷新重试。' : 'Turn details are not available yet. Refresh to retry.'}</p>}
        {turnDetailError && <p>{turnDetailError}</p>}
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
  if (current.terminal && !next.terminal) return current;
  if (Date.parse(next.updatedAt || '') < Date.parse(current.updatedAt || '')) return current;
  return {
    ...current,
    ...next,
    taskId: next.taskId || current.taskId,
    toolCallId: next.toolCallId || current.toolCallId,
    requestPrompt: next.requestPrompt || current.requestPrompt,
    responsePrompt: next.responsePrompt || current.responsePrompt,
    errorMessage: next.errorMessage,
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
    detailEndpoint: event.detailEndpoint,
    usage: {},
    raw: event.raw,
  };
}

function stringList(value: unknown) {
  return Array.isArray(value)
    ? value.map((item) => String(item ?? '').trim()).filter(Boolean)
    : [];
}
