import { Check, ChevronDown, Clipboard, LoaderCircle, Network, Play, RefreshCw, Sparkles, Terminal, WrapText } from 'lucide-react';
import { useCallback, useState, useRef } from 'react';

import { dispatchSubagent, type SubagentDispatchResult } from '../../backend/api';
import type { AppLanguage, ChatMessage, ChatToolExecution } from '../../types';
import {
  cardlingSceneFromToolExecution,
  type CardlingScene,
} from '../cardling/scene';
import { copyText } from '../messageFeedback';
import { preserveScrollPositionForToggle } from '../preserveScrollPosition';
import { PlanningAssessmentNotice, planningAssessmentFromExecution } from './PlanningAssessmentNotice';
import { PlanVerificationPanel, normalizeAssertionResults, planVerificationInfoFromExecution, type VerificationAssertionItem } from './PlanVerificationPanel';
import { SubagentAuditSignalsPanel, subagentAuditSignalsFromExecution } from './SubagentAuditSignalsPanel';
import { SubagentChildTools, subagentChildToolExecutions } from './SubagentChildTools';
import { ToolActionEnvelopeInfo, toolActionEnvelopeFromExecution } from './ToolActionEnvelopeInfo';
import { ToolChangeBlock } from './ToolChangeBlock';
import { ToolHookDecisionNotice, toolHookDecisionFromExecution } from './ToolHookDecisionNotice';
import { RuntimeProfileBadge, WorkerProfileBadge, runtimeProfileInfoFromExecution } from './ToolProfileBadges';
import { displayToolName, isToolRunning, isToolRunningInContext, runningToolLabel, compareToolExecutionOrder } from './toolExecutionState';
import { toolChangeReportFromExecutions, type ConversationChangeReport } from './toolChangeReports';
import { compactToolOutput, toolDisplayOutput, toolOutputNeedsCollapse } from './toolOutput';
import { asRecord } from './toolPayload';
export function ToolExecutionBlock({
  executions,
  language,
  message,
  active,
  onRevertChangeReport,
  onOpenScene,
}: {
  executions: ChatToolExecution[];
  language: AppLanguage;
  message: ChatMessage;
  active: boolean;
  onRevertChangeReport: (
    report: ConversationChangeReport,
    message: ChatMessage,
  ) => Promise<void>;
  onOpenScene: (scene: CardlingScene) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const blockRef = useRef<HTMLDivElement>(null);
  const running = executions.some((execution) => isToolRunningInContext(execution, active));
  const failedCount = executions.filter((execution) =>
    isToolFailedInContext(execution, active),
  ).length;
  const tone = running ? 'neutral' : toolExecutionToneInContext(executions, active);
  const changeReport = toolChangeReportFromExecutions(executions);
  const toggleExpanded = useCallback(() => {
    preserveScrollPositionForToggle(blockRef.current, () => {
      setExpanded((value) => !value);
    });
  }, []);

  if (changeReport) {
    const messageChangeReport: ConversationChangeReport = {
      ...changeReport,
      id: `${message.id}:${message.turnId ?? ''}`,
      messageId: message.id,
      turnId: message.turnId,
      createdAt: message.createdAt,
    };
    return (
      <ToolChangeBlock
        report={messageChangeReport}
        running={running}
        tone={tone}
        language={language}
        onRevert={() => onRevertChangeReport(messageChangeReport, message)}
      />
    );
  }

  const summary = running
    ? runningToolLabel(executions, language)
    : failedCount > 0
      ? language === 'zh'
        ? `已运行 ${executions.length} 条命令，${failedCount} 条失败`
        : `Ran ${executions.length} tools, ${failedCount} failed`
      : language === 'zh'
        ? `已运行 ${executions.length} 条命令`
        : `Ran ${executions.length} tools`;

  return (
    <div
      ref={blockRef}
      className={`tool-execution-block ${expanded ? 'expanded' : ''} ${running ? 'running' : ''} ${tone}`}
    >
      <button
        className="tool-execution-summary"
        type="button"
        onClick={toggleExpanded}
      >
        <Terminal size={15} />
        <span>{summary}</span>
        <ChevronDown size={16} className={expanded ? 'expanded' : ''} />
      </button>
      {expanded && (
        <div className="tool-execution-details">
          {executions.map((execution, index) => (
            <ToolExecutionDetail
              // eslint-disable-next-line react/no-array-index-key
              key={`${execution.id}-${index}`}
              execution={execution}
              message={message}
              language={language}
              active={active}
              onOpenScene={onOpenScene}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function isSubagentDispatchRejectionExecution(execution: ChatToolExecution) {
  const metadata = execution.metadata;
  const hasSubagentMarker =
    execution.name.trim().toLowerCase().includes('subagent') ||
    String(metadata.kind ?? metadata.type ?? '').trim() === 'subagent_tool' ||
    metadata.subagent_task_id != null ||
    metadata.subagentTaskId != null ||
    metadata.subagent_name != null ||
    metadata.subagentName != null;
  if (!hasSubagentMarker) {
    return false;
  }
  const outputPayload = parseToolOutputJson(execution.output);
  const candidates = [
    execution.metadata,
    asRecord(execution.metadata.result),
    asRecord(execution.metadata.payload),
    outputPayload,
  ];
  return candidates.some(isSubagentDispatchRejectionPayload);
}

function isSubagentDispatchRejectionPayload(payload: Record<string, unknown>) {
  if (Object.keys(payload).length === 0) {
    return false;
  }
  const status = String(payload.status ?? '').trim().toLowerCase();
  return (
    payload.accepted === false ||
    status === 'rejected' ||
    Boolean(payload.error_code ?? payload.errorCode)
  );
}

function isToolFailed(execution: ChatToolExecution) {
  if (isSubagentDispatchRejectionExecution(execution)) {
    return false;
  }
  const verificationInfo = planVerificationInfoFromExecution(execution);
  if (verificationInfo?.failed) {
    return false;
  }
  const normalized = execution.state.trim().toLowerCase();
  return (
    ['fail', 'failed', 'error'].includes(normalized) ||
    (!execution.success && !isToolRunning(execution))
  );
}

function isToolFailedInContext(execution: ChatToolExecution, active: boolean) {
  if (!active && isToolRunning(execution)) {
    return false;
  }
  return isToolFailed(execution);
}

type ToolExecutionTone = 'neutral' | 'warning' | 'danger';

function toolExecutionTone(executions: ChatToolExecution[]): ToolExecutionTone {
  const settled = executions.filter((execution) => !isToolRunning(execution));
  if (settled.length === 0) {
    return 'neutral';
  }
  const failedCount = settled.filter(isToolFailed).length;
  if (failedCount > 1 && failedCount / settled.length > 0.5) {
    return 'danger';
  }
  const latestSettled = [...settled].sort(compareToolExecutionOrder).at(-1);
  if (latestSettled && isToolFailed(latestSettled)) {
    return 'warning';
  }
  return 'neutral';
}

function toolExecutionToneInContext(
  executions: ChatToolExecution[],
  active: boolean,
): ToolExecutionTone {
  if (active) {
    return toolExecutionTone(executions);
  }
  const failedCount = executions.filter((execution) =>
    isToolFailedInContext(execution, active),
  ).length;
  if (failedCount > 1 && failedCount / executions.length > 0.5) {
    return 'danger';
  }
  const latest = [...executions].sort(compareToolExecutionOrder).at(-1);
  if (latest && isToolFailedInContext(latest, active)) {
    return 'warning';
  }
  return 'neutral';
}

function parseToolOutputJson(value: string) {
  const text = value.trim();
  if (!text.startsWith('{')) {
    return {};
  }
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return {};
  }
}

function summarizeRecord(value: Record<string, unknown>) {
  const entries = Object.entries(value).filter(([, raw]) => raw != null && raw !== '');
  if (entries.length === 0) {
    return '-';
  }
  return entries
    .slice(0, 6)
    .map(([key, raw]) => `${key}: ${String(raw)}`)
    .join(' · ');
}

function summarizeWorkerContractDefaults(value: Record<string, unknown>) {
  const entries = Object.entries(value).filter(([, raw]) => raw != null && raw !== '');
  if (entries.length === 0) {
    return '';
  }
  return entries
    .slice(0, 6)
    .map(([key, raw]) => {
      if (Array.isArray(raw)) {
        return `${key}: ${raw.join(', ')}`;
      }
      if (raw && typeof raw === 'object') {
        return `${key}: ${summarizeRecord(asRecord(raw))}`;
      }
      return `${key}: ${String(raw)}`;
    })
    .join(' · ');
}

function summarizeWriteScope(scope: string[]) {
  if (scope.length === 0) {
    return '';
  }
  const visible = scope.slice(0, 4).join(', ');
  return scope.length > 4 ? `${visible} +${scope.length - 4}` : visible;
}

function summarizeIoManifest(manifest: Record<string, unknown>) {
  const keys = ['reads', 'writes', 'exports', 'consumes'];
  const parts = keys
    .map((key) => {
      const value = summarizeLooseValue(manifest[key]);
      return value ? `${key}: ${value}` : '';
    })
    .filter(Boolean);
  if (parts.length > 0) {
    return parts.join(' · ');
  }
  return summarizeRecord(manifest);
}

function summarizeAssertionResults(items: VerificationAssertionItem[]) {
  const visible = items
    .slice(0, 4)
    .map((item) =>
      [item.label, item.status ? `(${item.status})` : '', item.summary]
        .filter(Boolean)
        .join(' '),
    )
    .join(' · ');
  return items.length > 4 ? `${visible} +${items.length - 4}` : visible;
}

function stringArrayLoose(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(summarizeLooseValue)
    .map((item) => item.trim())
    .filter(Boolean);
}

function summarizeLooseValue(value: unknown): string {
  if (value == null || value === '') {
    return '';
  }
  if (Array.isArray(value)) {
    return value.map(summarizeLooseValue).filter(Boolean).join(', ');
  }
  if (typeof value === 'object') {
    const record = asRecord(value);
    const title = nonEmptyString(
      record.label ?? record.name ?? record.id ?? record.path ?? record.summary,
    );
    if (title) {
      return title;
    }
    return summarizeRecord(record);
  }
  return String(value).trim();
}

function summarizeSubagentWriteLease(
  lease: NonNullable<SubagentDispatchResult['writeLease']>,
) {
  const conflictText = lease.conflicts.length > 0
    ? `conflicts: ${lease.conflicts.slice(0, 2).map(summarizeWriteLeaseConflict).join(' | ')}`
    : '';
  return [
    lease.status ? `lease: ${lease.status}` : 'lease',
    lease.policy ? `policy: ${lease.policy}` : '',
    lease.scope.length > 0 ? `scope: ${summarizeWriteScope(lease.scope)}` : '',
    conflictText,
    lease.reason ? `reason: ${lease.reason}` : '',
  ].filter(Boolean).join(' · ');
}

function summarizeWriteLeaseRecord(value: Record<string, unknown>) {
  const scope = stringArray(value.scope);
  const conflicts = Array.isArray(value.conflicts)
    ? value.conflicts.map(asRecord)
    : [];
  return [
    nonEmptyString(value.status) ? `status: ${String(value.status)}` : '',
    nonEmptyString(value.policy) ? `policy: ${String(value.policy)}` : '',
    scope.length > 0 ? `scope: ${summarizeWriteScope(scope)}` : '',
    conflicts.length > 0
      ? `conflicts: ${conflicts.slice(0, 2).map(summarizeWriteLeaseConflict).join(' | ')}`
      : '',
    nonEmptyString(value.reason) ? `reason: ${String(value.reason)}` : '',
  ].filter(Boolean).join(' · ');
}

function summarizeWriteLeaseConflict(value: Record<string, unknown>) {
  const scope = stringArray(value.scope ?? value.write_scope ?? value.writeScope);
  return [
    nonEmptyString(value.task_id ?? value.taskId)
      ? `task: ${String(value.task_id ?? value.taskId)}`
      : '',
    scope.length > 0 ? summarizeWriteScope(scope) : '',
    nonEmptyString(value.reason) ? String(value.reason) : '',
  ].filter(Boolean).join(' ');
}

function nonEmptyString(value: unknown) {
  const text = value == null ? '' : String(value).trim();
  return text || undefined;
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.map((item) => String(item ?? '').trim()).filter(Boolean)
    : [];
}

function firstDefined(values: unknown[]) {
  return values.find((value) => {
    if (value == null || value === '') {
      return false;
    }
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    if (typeof value === 'object') {
      return Object.keys(asRecord(value)).length > 0;
    }
    return true;
  });
}

function ToolExecutionDetail({
  execution,
  message,
  language,
  active,
  onOpenScene,
}: {
  execution: ChatToolExecution;
  message: ChatMessage;
  language: AppLanguage;
  active: boolean;
  onOpenScene: (scene: CardlingScene) => void;
}) {
  const [outputExpanded, setOutputExpanded] = useState(false);
  const [outputWrapped, setOutputWrapped] = useState(false);
  const scene = cardlingSceneFromToolExecution(execution, message);
  const duration = formatDuration(execution.durationMs);
  const summary = execution.summary.trim();
  const actionEnvelope = toolActionEnvelopeFromExecution(execution);
  const output = toolDisplayOutput(execution, actionEnvelope);
  const childExecutions = subagentChildToolExecutions(execution);
  const runtimeInfo = runtimeProfileInfoFromExecution(execution);
  const hookDecision = toolHookDecisionFromExecution(execution);
  const planningAssessment = planningAssessmentFromExecution(execution);
  const verificationInfo = planVerificationInfoFromExecution(execution);
  const auditSignals = subagentAuditSignalsFromExecution(execution);
  const workerInfo = workerProfileInfoFromExecution(execution);
  const dispatchPlan = planDispatchInfoFromExecution(execution);
  const failed = isToolFailedInContext(execution, active);
  const shouldCollapseOutput = toolOutputNeedsCollapse(output);
  const visibleOutput =
    shouldCollapseOutput && !outputExpanded ? compactToolOutput(output) : output;
  const status = verificationInfo?.failed
    ? language === 'zh'
      ? '节点验证未通过'
      : 'Verification failed'
    : isToolRunningInContext(execution, active)
      ? language === 'zh'
        ? '运行中'
        : 'Running'
      : failed
        ? language === 'zh'
          ? '失败'
          : 'Failed'
        : language === 'zh'
          ? '完成'
          : 'Done';
  return (
    <section className="tool-execution-detail">
      <header>
        <strong>{displayToolName(execution.name)}</strong>
        <span className={verificationInfo?.failed ? 'warning' : failed ? 'failed' : ''}>
          {duration ? `${status} · ${duration}` : status}
        </span>
      </header>
      {summary && <code>$ {summary}</code>}
      <RuntimeProfileBadge info={runtimeInfo} />
      <WorkerProfileBadge info={workerInfo} />
      {actionEnvelope && (
        <ToolActionEnvelopeInfo envelope={actionEnvelope} language={language} />
      )}
      {planningAssessment && (
        <PlanningAssessmentNotice language={language} />
      )}
      {dispatchPlan && (
        <PlanDispatchAdvisorPanel
          plan={dispatchPlan}
          language={language}
          sessionId={message.conversationId ?? ''}
          turnId={message.turnId}
        />
      )}
      {hookDecision && <ToolHookDecisionNotice decision={hookDecision} />}
      {verificationInfo && (
        <PlanVerificationPanel info={verificationInfo} language={language} />
      )}
      {auditSignals && (
        <SubagentAuditSignalsPanel signals={auditSignals} language={language} />
      )}
      {scene && (
        <button
          className="tool-scene-open"
          type="button"
          onClick={() => onOpenScene(scene)}
        >
          <Sparkles size={14} />
          <span>{language === 'zh' ? '打开交互场景' : 'Open interactive scene'}</span>
        </button>
      )}
      <SubagentChildTools
        executions={childExecutions}
        language={language}
        isFailed={(child) => isToolFailedInContext(child, active)}
      />
      {output.trim() && (
        <>
          <pre
            className={`tool-execution-output ${outputExpanded ? 'expanded' : ''} ${
              outputWrapped ? 'wrapped' : ''
            }`}
          >
            {visibleOutput}
          </pre>
          <div className="tool-output-actions">
            {shouldCollapseOutput && (
              <button
                className="tool-output-toggle"
                type="button"
                onClick={() => setOutputExpanded((value) => !value)}
              >
                {outputExpanded
                  ? language === 'zh'
                    ? '收起输出'
                    : 'Collapse output'
                  : language === 'zh'
                    ? '展开完整输出'
                    : 'Expand full output'}
              </button>
            )}
            <button
              className="tool-output-toggle"
              type="button"
              aria-pressed={outputWrapped}
              onClick={() => setOutputWrapped((value) => !value)}
            >
              <WrapText size={13} />
              <span>
                {outputWrapped
                  ? language === 'zh'
                    ? '取消换行'
                    : 'No wrap'
                  : language === 'zh'
                    ? '换行'
                    : 'Wrap'}
              </span>
            </button>
            <button
              className="tool-output-toggle"
              type="button"
              onClick={() => void copyText(output).catch(() => undefined)}
            >
              <Clipboard size={13} />
              <span>{language === 'zh' ? '复制输出' : 'Copy output'}</span>
            </button>
          </div>
        </>
      )}
    </section>
  );
}

type WorkerDispatchRecommendation = {
  agentName: string;
  runtimeProfile: string;
  resolvedRuntimeProfile: string;
  expectedHookSet: string;
  workerContractPolicy: string;
  workerContractDefaults: Record<string, unknown>;
  dispatchDecision: string;
  dispatchReady?: boolean;
  requiresUserApproval?: boolean;
  parentAutoDispatchExpected?: boolean;
  parentAutoDispatchPolicy: string;
  whyNotParentDirect: string;
  whyNotParallelTools: string;
  whyNotSubagent: string;
  writeScopeConfidence: string;
  dispatchGroupId: string;
  dispatchGroupNodeIds: string[];
  executionChannel: string;
  writeScope: string[];
  writeLease: Record<string, unknown>;
  ioManifest: Record<string, unknown>;
  successAssertions: string[];
  assertionResults: VerificationAssertionItem[];
  verificationLevel: string;
  lane: string;
  planNodeId: string;
  exitCondition: string;
  task: string;
  raw: Record<string, unknown>;
};

type PlanDispatchInfo = {
  advisor: Record<string, unknown>;
  candidates: WorkerDispatchRecommendation[];
};

function PlanDispatchAdvisorPanel({
  plan,
  language,
  sessionId,
  turnId,
}: {
  plan: PlanDispatchInfo;
  language: AppLanguage;
  sessionId: string;
  turnId?: string;
}) {
  const advisorText = summarizeDispatchAdvisor(plan.advisor, language);
  const groups = groupWorkerDispatchCandidates(plan.candidates);
  return (
    <section className="dispatch-advisor-panel">
      {advisorText && (
        <div className="dispatch-advisor-summary">
          <Network size={13} />
          <span>{advisorText}</span>
        </div>
      )}
      {groups.map((group) => (
        <div className="dispatch-candidate-group" key={group.id}>
          {group.label && (
            <div className="dispatch-candidate-group-label">{group.label}</div>
          )}
          {group.items.map((dispatch, index) => (
            <WorkerDispatchRecommendationCard
              key={`${dispatch.dispatchGroupId || 'candidate'}-${dispatch.planNodeId || index}-${dispatch.agentName}-${index}`}
              dispatch={dispatch}
              language={language}
              sessionId={sessionId}
              turnId={turnId}
            />
          ))}
        </div>
      ))}
    </section>
  );
}

function WorkerDispatchRecommendationCard({
  dispatch,
  language,
  sessionId,
  turnId,
}: {
  dispatch: WorkerDispatchRecommendation;
  language: AppLanguage;
  sessionId: string;
  turnId?: string;
}) {
  const [dispatching, setDispatching] = useState(false);
  const [result, setResult] = useState<SubagentDispatchResult | null>(null);
  const [error, setError] = useState('');
  const autoDispatchExpected =
    dispatch.parentAutoDispatchExpected === true &&
    dispatch.requiresUserApproval === false;
  const activeWriteScope =
    result?.writeScope && result.writeScope.length > 0
      ? result.writeScope
      : dispatch.writeScope;
  const rows = [
    [language === 'zh' ? 'Agent' : 'Agent', dispatch.agentName],
    [language === 'zh' ? '决策' : 'Decision', dispatch.dispatchDecision],
    [
      language === 'zh' ? '就绪' : 'Ready',
      dispatch.dispatchReady == null
        ? ''
        : dispatch.dispatchReady
          ? language === 'zh'
            ? '是'
            : 'Yes'
          : language === 'zh'
            ? '否'
            : 'No',
    ],
    [
      language === 'zh' ? '审批' : 'Approval',
      dispatch.requiresUserApproval == null
        ? ''
        : dispatch.requiresUserApproval
          ? language === 'zh'
            ? '需要用户确认'
            : 'User approval required'
          : language === 'zh'
            ? '不需要'
            : 'Not required',
    ],
    [
      language === 'zh' ? '自动派发' : 'Auto dispatch',
      dispatch.parentAutoDispatchExpected == null
        ? ''
        : dispatch.parentAutoDispatchExpected
          ? language === 'zh'
            ? '父 Agent 可自动执行'
            : 'Parent agent can dispatch'
          : language === 'zh'
            ? '不预期'
            : 'Not expected',
    ],
    [
      language === 'zh' ? '自动策略' : 'Auto policy',
      dispatch.parentAutoDispatchPolicy,
    ],
    [language === 'zh' ? '通道' : 'Channel', dispatch.executionChannel],
    [language === 'zh' ? 'Profile' : 'Profile', dispatch.runtimeProfile],
    [
      language === 'zh' ? '解析 Profile' : 'Resolved',
      result?.resolvedRuntimeProfile ?? dispatch.resolvedRuntimeProfile,
    ],
    [
      language === 'zh' ? 'Hook set' : 'Hook set',
      result?.resolvedHookSet ?? dispatch.expectedHookSet,
    ],
    [
      language === 'zh' ? '契约策略' : 'Contract',
      dispatch.workerContractPolicy,
    ],
    [
      language === 'zh' ? '默认推断' : 'Defaults',
      summarizeWorkerContractDefaults(dispatch.workerContractDefaults),
    ],
    [language === 'zh' ? '组' : 'Group', dispatch.dispatchGroupId],
    [
      language === 'zh' ? '组节点' : 'Group nodes',
      dispatch.dispatchGroupNodeIds.join(', '),
    ],
    [language === 'zh' ? '写入范围' : 'Write scope', summarizeWriteScope(activeWriteScope)],
    [language === 'zh' ? '范围置信' : 'Scope confidence', dispatch.writeScopeConfidence],
    [language === 'zh' ? 'Lane' : 'Lane', dispatch.lane],
    [language === 'zh' ? 'Plan node' : 'Plan node', dispatch.planNodeId],
    [language === 'zh' ? '退出条件' : 'Exit', dispatch.exitCondition],
    [
      language === 'zh' ? '非父级原因' : 'Not parent',
      dispatch.whyNotParentDirect,
    ],
    [
      language === 'zh' ? '非工具并发' : 'Not tools',
      dispatch.whyNotParallelTools,
    ],
    [
      language === 'zh' ? '非子 Agent' : 'Not subagent',
      dispatch.whyNotSubagent,
    ],
  ].filter(([, value]) => value);
  const hasExecutionEvidence =
    Object.keys(dispatch.ioManifest).length > 0 ||
    dispatch.successAssertions.length > 0 ||
    dispatch.assertionResults.length > 0 ||
    Boolean(dispatch.verificationLevel);
  const prompt = workerDispatchPrompt(dispatch);
  const canDispatch = Boolean(sessionId.trim() && dispatch.agentName.trim() && prompt.trim());
  const accepted = result?.accepted && result.status !== 'rejected';
  const statusTone =
    result?.accepted && result.status !== 'rejected'
      ? 'accepted'
      : result || error
        ? 'rejected'
        : '';
  const resolvedStatus = [
    result?.resolvedRuntimeProfile || dispatch.resolvedRuntimeProfile
      ? `profile: ${result?.resolvedRuntimeProfile ?? dispatch.resolvedRuntimeProfile}`
      : '',
    result?.resolvedHookSet || dispatch.expectedHookSet
      ? `hooks: ${result?.resolvedHookSet ?? dispatch.expectedHookSet}`
      : '',
  ].filter(Boolean).join(' · ');
  const writeLeaseStatus = result?.writeLease
    ? summarizeSubagentWriteLease(result.writeLease)
    : '';
  const runDispatch = useCallback(async () => {
    if (!canDispatch || dispatching) {
      return;
    }
    setDispatching(true);
    setError('');
    try {
      const nextResult = await dispatchSubagent({
        sessionId,
        turnId,
        agentName: dispatch.agentName,
        prompt,
        runtimeProfile: dispatch.runtimeProfile,
        lane: dispatch.lane,
        planNodeId: dispatch.planNodeId,
        exitCondition: dispatch.exitCondition,
        writeScope: dispatch.writeScope,
        waitSeconds: 0,
      });
      setResult(nextResult);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setDispatching(false);
    }
  }, [canDispatch, dispatch, dispatching, prompt, sessionId, turnId]);

  return (
    <section className={`worker-dispatch-card ${statusTone}`}>
      <header>
        <Network size={14} />
        <strong>
          {autoDispatchExpected
            ? language === 'zh'
              ? '父 Agent 可自动派发'
              : 'Parent auto-dispatch ready'
            : language === 'zh'
              ? '建议派发子 Agent'
              : 'Recommended worker dispatch'}
        </strong>
        <button
          className={autoDispatchExpected ? 'manual' : 'primary'}
          type="button"
          disabled={!canDispatch || dispatching}
          onClick={() => void runDispatch()}
        >
          {dispatching ? (
            <LoaderCircle size={13} />
          ) : accepted ? (
            <RefreshCw size={13} />
          ) : (
            <Play size={13} />
          )}
          <span>
            {dispatching
              ? language === 'zh'
                ? '派发中'
                : 'Dispatching'
              : accepted
                ? language === 'zh'
                  ? result?.reason === 'already_running'
                    ? '已复用'
                    : autoDispatchExpected
                      ? '调试复用'
                      : '复用检查'
                  : result?.reason === 'already_running'
                    ? 'Reused'
                    : autoDispatchExpected
                      ? 'Debug reuse'
                      : 'Check reuse'
                : language === 'zh'
                  ? autoDispatchExpected
                    ? '手动派发'
                    : '派发'
                  : autoDispatchExpected
                    ? 'Manual dispatch'
                    : 'Dispatch'}
          </span>
        </button>
        <button
          type="button"
          onClick={() =>
            void copyText(JSON.stringify(dispatch.raw, null, 2)).catch(() => undefined)
          }
        >
          <Clipboard size={13} />
          <span>{language === 'zh' ? '复制参数' : 'Copy'}</span>
        </button>
      </header>
      {autoDispatchExpected && (
        <p className="worker-dispatch-status auto">
          {language === 'zh'
            ? '无需用户审批；正常情况下父 Agent 会根据 plan 证据自行派发。这个按钮仅作为手动/调试兜底。'
            : 'No user approval is required; the parent agent should dispatch from plan evidence. This button is only a manual/debug fallback.'}
        </p>
      )}
      {dispatch.task && <p>{dispatch.task}</p>}
      {!canDispatch && (
        <p className="worker-dispatch-status rejected">
          {language === 'zh'
            ? '缺少 session、agent 或 prompt，暂不能派发。'
            : 'Missing session, agent, or prompt; cannot dispatch yet.'}
        </p>
      )}
      {(result || error) && (
        <p className={`worker-dispatch-status ${statusTone || 'rejected'}`}>
          {workerDispatchResultText(result, error, language)}
        </p>
      )}
      {resolvedStatus && (
        <p className="worker-dispatch-status accepted">{resolvedStatus}</p>
      )}
      {writeLeaseStatus && (
        <p className={`worker-dispatch-status ${accepted ? 'accepted' : 'rejected'}`}>
          {writeLeaseStatus}
        </p>
      )}
      {result?.supervisor && (!result.accepted || result.status === 'rejected') && (
        <p className="worker-dispatch-status rejected">
          {[
            result.supervisor.counts
              ? `${language === 'zh' ? '运行数' : 'Counts'}: ${summarizeRecord(result.supervisor.counts as unknown as Record<string, unknown>)}`
              : '',
            result.supervisor.limits
              ? `${language === 'zh' ? '限制' : 'Limits'}: ${summarizeRecord(result.supervisor.limits as unknown as Record<string, unknown>)}`
              : '',
          ].filter(Boolean).join(' · ')}
        </p>
      )}
      {rows.length > 0 && (
        <dl>
          {rows.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {hasExecutionEvidence && (
        <details className="worker-dispatch-evidence">
          <summary>
            {language === 'zh' ? '输入输出与验收' : 'IO and verification'}
          </summary>
          <dl>
            {dispatch.verificationLevel && (
              <div>
                <dt>{language === 'zh' ? '验证级别' : 'Verification'}</dt>
                <dd>{dispatch.verificationLevel}</dd>
              </div>
            )}
            {Object.keys(dispatch.ioManifest).length > 0 && (
              <div>
                <dt>{language === 'zh' ? 'IO' : 'IO'}</dt>
                <dd>{summarizeIoManifest(dispatch.ioManifest)}</dd>
              </div>
            )}
            {dispatch.successAssertions.length > 0 && (
              <div>
                <dt>{language === 'zh' ? '验收条件' : 'Assertions'}</dt>
                <dd>{dispatch.successAssertions.join(' · ')}</dd>
              </div>
            )}
            {dispatch.assertionResults.length > 0 && (
              <div>
                <dt>{language === 'zh' ? '验收结果' : 'Results'}</dt>
                <dd>{summarizeAssertionResults(dispatch.assertionResults)}</dd>
              </div>
            )}
          </dl>
        </details>
      )}
    </section>
  );
}

function workerDispatchPrompt(dispatch: WorkerDispatchRecommendation) {
  return String(
    dispatch.raw.prompt ??
      dispatch.raw.task ??
      dispatch.raw.instruction ??
      dispatch.raw.user_input ??
      dispatch.raw.userInput ??
      dispatch.task,
  ).trim();
}

function workerDispatchResultText(
  result: SubagentDispatchResult | null,
  error: string,
  language: AppLanguage,
) {
  if (error) {
    return error;
  }
  if (!result) {
    return '';
  }
  if (!result.accepted || result.status === 'rejected') {
    if (result.reason === 'write_lease_conflict') {
      return result.message || (language === 'zh' ? '写租约冲突，未派发' : 'Write lease conflict');
    }
    return result.message || result.reason || (language === 'zh' ? '派发被拒绝' : 'Dispatch rejected');
  }
  const task = result.taskId ? ` · ${result.taskId}` : '';
  if (result.reason === 'already_running') {
    return language === 'zh'
      ? `已有运行中的子 Agent，已复用${task}`
      : `Already running; reused${task}`;
  }
  return language === 'zh'
    ? `子 Agent 已派发${task}`
    : `Subagent dispatched${task}`;
}

function planDispatchInfoFromExecution(
  execution: ChatToolExecution,
): PlanDispatchInfo | null {
  if (!/(^|_)plan$/i.test(execution.name) && execution.name !== 'plan') {
    return null;
  }
  const outputPayload = parseToolOutputJson(execution.output);
  const payloads = [
    execution.metadata,
    asRecord(execution.metadata.plan),
    asRecord(execution.metadata.result),
    asRecord(asRecord(execution.metadata.result).plan),
    outputPayload,
    asRecord(outputPayload.plan),
    asRecord(outputPayload.result),
    asRecord(asRecord(outputPayload.result).plan),
  ];
  const advisor = firstRecord(
    payloads.flatMap((payload) => [
      asRecord(payload.dispatch_advisor),
      asRecord(payload.dispatchAdvisor),
    ]),
  );
  const candidateItems = payloads.flatMap((payload) =>
    arrayRecords(payload.dispatch_candidates ?? payload.dispatchCandidates),
  );
  const candidates = candidateItems
    .map(normalizeWorkerDispatchRecord)
    .filter((item): item is WorkerDispatchRecommendation => item != null);
  if (candidates.length === 0) {
    const legacy = [
      execution.metadata.recommended_worker_dispatch,
      execution.metadata.recommendedWorkerDispatch,
      asRecord(execution.metadata.result).recommended_worker_dispatch,
      asRecord(execution.metadata.result).recommendedWorkerDispatch,
      outputPayload.recommended_worker_dispatch,
      outputPayload.recommendedWorkerDispatch,
      asRecord(outputPayload.result).recommended_worker_dispatch,
      asRecord(outputPayload.result).recommendedWorkerDispatch,
    ].map(asRecord);
    for (const candidate of legacy) {
      const normalized = normalizeWorkerDispatchRecord(candidate);
      if (normalized) {
        candidates.push(normalized);
        break;
      }
    }
  }
  if (Object.keys(advisor).length === 0 && candidates.length === 0) {
    return null;
  }
  return { advisor, candidates };
}

function firstRecord(values: Record<string, unknown>[]) {
  return values.find((value) => Object.keys(value).length > 0) ?? {};
}

function arrayRecords(value: unknown) {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function groupWorkerDispatchCandidates(candidates: WorkerDispatchRecommendation[]) {
  const groups = new Map<string, WorkerDispatchRecommendation[]>();
  candidates.forEach((candidate, index) => {
    const groupKey = candidate.dispatchGroupId ||
      (candidate.dispatchGroupNodeIds.length > 1
        ? candidate.dispatchGroupNodeIds.join('|')
        : `single-${candidate.planNodeId || candidate.agentName || index}`);
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), candidate]);
  });
  return Array.from(groups.entries()).map(([id, items]) => {
    const first = items[0];
    const groupNodes = first?.dispatchGroupNodeIds ?? [];
    const showLabel =
      Boolean(first?.dispatchGroupId) ||
      groupNodes.length > 1 ||
      items.length > 1 ||
      first?.executionChannel === 'parallel_writer';
    const labelParts = [
      first?.executionChannel === 'parallel_writer' ? 'parallel_writer' : '',
      first?.dispatchGroupId ? `group: ${first.dispatchGroupId}` : '',
      groupNodes.length > 0 ? `nodes: ${groupNodes.join(', ')}` : '',
      items.length > 1 ? `candidates: ${items.length}` : '',
    ].filter(Boolean);
    return {
      id,
      label: showLabel ? labelParts.join(' · ') : '',
      items,
    };
  });
}

function summarizeDispatchAdvisor(
  advisor: Record<string, unknown>,
  language: AppLanguage,
) {
  if (Object.keys(advisor).length === 0) {
    return '';
  }
  const currentNode = asRecord(advisor.current_node ?? advisor.currentNode);
  const currentNodeText =
    summarizeAdvisorValue(advisor.current_node ?? advisor.currentNode) ||
    summarizeAdvisorValue(
      currentNode.id ?? currentNode.node_id ?? currentNode.title ?? currentNode.name,
    );
  const recommendedExecution = nonEmptyString(
    advisor.recommended_execution ??
      advisor.recommendedExecution ??
      currentNode.recommended_execution ??
      currentNode.recommendedExecution,
  );
  const decision = nonEmptyString(
    advisor.dispatch_decision ??
      advisor.dispatchDecision ??
      currentNode.dispatch_decision ??
      currentNode.dispatchDecision,
  );
  const requiresApproval = optionalBoolean(
    advisor.requires_user_approval ??
      advisor.requiresUserApproval ??
      currentNode.requires_user_approval ??
      currentNode.requiresUserApproval,
  );
  const autoPolicy = nonEmptyString(
    advisor.parent_auto_dispatch_policy ??
      advisor.parentAutoDispatchPolicy ??
      currentNode.parent_auto_dispatch_policy ??
      currentNode.parentAutoDispatchPolicy,
  );
  const parts = [
    currentNodeText
      ? `${language === 'zh' ? '当前节点' : 'Node'}: ${currentNodeText}`
      : '',
    recommendedExecution
      ? `${language === 'zh' ? '推荐' : 'Recommended'}: ${recommendedExecution}`
      : '',
    decision ? `${language === 'zh' ? '决策' : 'Decision'}: ${decision}` : '',
    requiresApproval === false
      ? language === 'zh'
        ? '无需用户审批'
        : 'No user approval'
      : '',
    autoPolicy
      ? `${language === 'zh' ? '自动策略' : 'Auto policy'}: ${autoPolicy}`
      : '',
  ].filter(Boolean);
  return parts.join(' · ');
}

function summarizeAdvisorValue(value: unknown) {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value).trim();
  }
  const record = asRecord(value);
  if (Object.keys(record).length === 0) {
    return '';
  }
  const label = nonEmptyString(record.label ?? record.title ?? record.name);
  const id = nonEmptyString(record.id ?? record.node_id ?? record.nodeId);
  return [id, label && label !== id ? label : ''].filter(Boolean).join(' · ');
}

function normalizeWorkerDispatchRecord(
  value: Record<string, unknown>,
): WorkerDispatchRecommendation | null {
  if (Object.keys(value).length === 0) {
    return null;
  }
  const agentName = nonEmptyString(
    value.agent_name ?? value.agentName ?? value.name ?? value.agent,
  ) ?? '';
  const runtimeProfile = nonEmptyString(
    value.runtime_profile ??
      value.runtimeProfile ??
      value.agent_profile ??
      value.agentProfile,
  ) ?? '';
  const lane = nonEmptyString(value.lane ?? value.profile_lane ?? value.profileLane) ?? '';
  const resolvedRuntimeProfile = nonEmptyString(
    value.resolved_runtime_profile ?? value.resolvedRuntimeProfile,
  ) ?? '';
  const expectedHookSet = nonEmptyString(
    value.expected_hook_set ??
      value.expectedHookSet ??
      value.resolved_hook_set ??
      value.resolvedHookSet,
  ) ?? '';
  const workerContractPolicy = nonEmptyString(
    value.worker_contract_policy ?? value.workerContractPolicy,
  ) ?? '';
  const workerContractDefaults = asRecord(
    value.worker_contract_defaults ?? value.workerContractDefaults,
  );
  const dispatchDecision = nonEmptyString(
    value.dispatch_decision ?? value.dispatchDecision,
  ) ?? '';
  const dispatchReady = optionalBoolean(value.dispatch_ready ?? value.dispatchReady);
  const requiresUserApproval = optionalBoolean(
    value.requires_user_approval ?? value.requiresUserApproval,
  );
  const parentAutoDispatchExpected = optionalBoolean(
    value.parent_auto_dispatch_expected ?? value.parentAutoDispatchExpected,
  );
  const parentAutoDispatchPolicy = nonEmptyString(
    value.parent_auto_dispatch_policy ?? value.parentAutoDispatchPolicy,
  ) ?? '';
  const whyNotParentDirect = nonEmptyString(
    value.why_not_parent_direct ?? value.whyNotParentDirect,
  ) ?? '';
  const whyNotParallelTools = nonEmptyString(
    value.why_not_parallel_tools ?? value.whyNotParallelTools,
  ) ?? '';
  const whyNotSubagent = nonEmptyString(
    value.why_not_subagent ?? value.whyNotSubagent,
  ) ?? '';
  const writeScopeConfidence = nonEmptyString(
    value.write_scope_confidence ?? value.writeScopeConfidence,
  ) ?? '';
  const dispatchGroupId = nonEmptyString(
    value.dispatch_group_id ?? value.dispatchGroupId,
  ) ?? '';
  const dispatchGroupNodeIds = stringArray(
    value.dispatch_group_node_ids ?? value.dispatchGroupNodeIds,
  );
  const executionChannel = nonEmptyString(
    value.execution_channel ?? value.executionChannel,
  ) ?? '';
  const writeScope = stringArray(
    value.write_scope ??
      value.writeScope ??
      value.subagent_write_scope ??
      value.subagentWriteScope,
  );
  const writeLease = asRecord(
    value.write_lease ??
      value.writeLease ??
      value.subagent_write_lease ??
      value.subagentWriteLease,
  );
  const ioManifest = asRecord(value.io_manifest ?? value.ioManifest);
  const successAssertions = stringArrayLoose(
    value.success_assertions ?? value.successAssertions,
  );
  const assertionResults = normalizeAssertionResults(
    value.assertion_results ?? value.assertionResults,
  );
  const verificationLevel = nonEmptyString(
    value.verification_level ?? value.verificationLevel,
  ) ?? '';
  const planNodeId = nonEmptyString(
    value.plan_node_id ?? value.planNodeId ?? value.node_id ?? value.nodeId,
  ) ?? '';
  const exitCondition = nonEmptyString(
    value.exit_condition ?? value.exitCondition,
  ) ?? '';
  const task = nonEmptyString(
    value.task ?? value.prompt ?? value.instruction ?? value.title ?? value.summary,
  ) ?? '';
  if (!agentName && !runtimeProfile && !lane && !planNodeId && !exitCondition) {
    return null;
  }
  return {
    agentName,
    runtimeProfile,
    resolvedRuntimeProfile,
    expectedHookSet,
    workerContractPolicy,
    workerContractDefaults,
    dispatchDecision,
    dispatchReady,
    requiresUserApproval,
    parentAutoDispatchExpected,
    parentAutoDispatchPolicy,
    whyNotParentDirect,
    whyNotParallelTools,
    whyNotSubagent,
    writeScopeConfidence,
    dispatchGroupId,
    dispatchGroupNodeIds,
    executionChannel,
    writeScope,
    writeLease,
    ioManifest,
    successAssertions,
    assertionResults,
    verificationLevel,
    lane,
    planNodeId,
    exitCondition,
    task,
    raw: value,
  };
}

function optionalBoolean(value: unknown) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === 'yes') {
      return true;
    }
    if (normalized === 'false' || normalized === 'no') {
      return false;
    }
  }
  return undefined;
}

function workerProfileInfoFromExecution(execution: ChatToolExecution) {
  const metadata = execution.metadata;
  const outputPayload = parseToolOutputJson(execution.output);
  const candidate = normalizeWorkerDispatchRecord({
    agent_name:
      metadata.agent_name ??
      metadata.agentName ??
      metadata.subagent_name ??
      metadata.subagentName ??
      outputPayload.agent_name ??
      outputPayload.agentName,
    runtime_profile:
      metadata.runtime_profile ??
      metadata.runtimeProfile ??
      metadata.subagent_runtime_profile ??
      metadata.subagentRuntimeProfile ??
      outputPayload.runtime_profile ??
      outputPayload.runtimeProfile,
    lane:
      metadata.lane ??
      metadata.subagent_lane ??
      metadata.subagentLane ??
      outputPayload.lane,
    plan_node_id:
      metadata.plan_node_id ??
      metadata.planNodeId ??
      metadata.subagent_plan_node_id ??
      metadata.subagentPlanNodeId ??
      outputPayload.plan_node_id ??
      outputPayload.planNodeId,
    exit_condition:
      metadata.exit_condition ??
      metadata.exitCondition ??
      outputPayload.exit_condition ??
      outputPayload.exitCondition,
    resolved_runtime_profile:
      metadata.resolved_runtime_profile ??
      metadata.resolvedRuntimeProfile ??
      metadata.subagent_resolved_runtime_profile ??
      metadata.subagentResolvedRuntimeProfile ??
      outputPayload.resolved_runtime_profile ??
      outputPayload.resolvedRuntimeProfile,
    expected_hook_set:
      metadata.expected_hook_set ??
      metadata.expectedHookSet ??
      metadata.resolved_hook_set ??
      metadata.resolvedHookSet ??
      metadata.subagent_resolved_hook_set ??
      metadata.subagentResolvedHookSet ??
      outputPayload.expected_hook_set ??
      outputPayload.expectedHookSet ??
      outputPayload.resolved_hook_set ??
      outputPayload.resolvedHookSet,
    worker_contract_policy:
      metadata.worker_contract_policy ??
      metadata.workerContractPolicy ??
      outputPayload.worker_contract_policy ??
      outputPayload.workerContractPolicy,
    worker_contract_defaults:
      metadata.worker_contract_defaults ??
      metadata.workerContractDefaults ??
      outputPayload.worker_contract_defaults ??
      outputPayload.workerContractDefaults,
    dispatch_decision:
      metadata.dispatch_decision ??
      metadata.dispatchDecision ??
      outputPayload.dispatch_decision ??
      outputPayload.dispatchDecision,
    dispatch_ready:
      metadata.dispatch_ready ??
      metadata.dispatchReady ??
      outputPayload.dispatch_ready ??
      outputPayload.dispatchReady,
    write_scope_confidence:
      metadata.write_scope_confidence ??
      metadata.writeScopeConfidence ??
      outputPayload.write_scope_confidence ??
      outputPayload.writeScopeConfidence,
    execution_channel:
      metadata.execution_channel ??
      metadata.executionChannel ??
      outputPayload.execution_channel ??
      outputPayload.executionChannel,
    write_scope:
      metadata.write_scope ??
      metadata.writeScope ??
      metadata.subagent_write_scope ??
      metadata.subagentWriteScope ??
      outputPayload.write_scope ??
      outputPayload.writeScope,
    write_lease:
      metadata.write_lease ??
      metadata.writeLease ??
      metadata.subagent_write_lease ??
      metadata.subagentWriteLease ??
      outputPayload.write_lease ??
      outputPayload.writeLease,
  });
  if (!candidate) {
    return '';
  }
  const parts = [
    candidate.agentName ? `agent: ${candidate.agentName}` : '',
    candidate.dispatchDecision ? `decision: ${candidate.dispatchDecision}` : '',
    candidate.dispatchReady != null ? `ready: ${candidate.dispatchReady ? 'yes' : 'no'}` : '',
    candidate.executionChannel ? `channel: ${candidate.executionChannel}` : '',
    candidate.runtimeProfile ? `profile: ${candidate.runtimeProfile}` : '',
    candidate.resolvedRuntimeProfile ? `resolved: ${candidate.resolvedRuntimeProfile}` : '',
    candidate.expectedHookSet ? `hooks: ${candidate.expectedHookSet}` : '',
    candidate.workerContractPolicy ? `policy: ${candidate.workerContractPolicy}` : '',
    Object.keys(candidate.workerContractDefaults).length > 0
      ? `defaults: ${summarizeWorkerContractDefaults(candidate.workerContractDefaults)}`
      : '',
    candidate.writeScope.length > 0 ? `scope: ${summarizeWriteScope(candidate.writeScope)}` : '',
    candidate.writeScopeConfidence ? `scope confidence: ${candidate.writeScopeConfidence}` : '',
    Object.keys(candidate.writeLease).length > 0
      ? `lease: ${summarizeWriteLeaseRecord(candidate.writeLease)}`
      : '',
    candidate.lane ? `lane: ${candidate.lane}` : '',
    candidate.planNodeId ? `node: ${candidate.planNodeId}` : '',
  ].filter(Boolean);
  return parts.join(' · ');
}


function formatDuration(durationMs: number) {
  if (durationMs <= 0) {
    return '';
  }
  if (durationMs >= 1000) {
    return `${(durationMs / 1000).toFixed(1)}s`;
  }
  return `${Math.round(durationMs)}ms`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
