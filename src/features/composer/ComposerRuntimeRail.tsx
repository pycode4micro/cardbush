import {
  Brain,
  CheckCircle2,
  Circle,
  Clock3,
  Code2,
  Edit3,
  ListChecks,
  LoaderCircle,
  PanelRightOpen,
  Sparkles,
  Target,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import type { ExperimentalGoal } from '../../backend/api';
import { useSoftPanelPresence } from '../../hooks/useSoftPanelPresence';
import type { GoalToolUpdate } from '../../shared/goalState';
import type {
  AppLanguage,
  TaskPlanSnapshot,
} from '../../types';
import type {
  ConversationChangeReport,
  ConversationChangeSummary,
  ToolFileChange,
} from '../tools';

export type ThinkingNotice = {
  id: string;
  turnId: string;
  preview: string;
  content: string;
  createdAt: string;
};

type RuntimeRailItem = {
  kind: 'processing' | 'thinking' | 'changes' | 'queue';
  label: string;
  summary: string;
  title: string;
};

type RuntimeRailKind = RuntimeRailItem['kind'];

type RuntimeQueuedMessage = {
  id: string;
  text: string;
  createdAt: string;
};

export function ComposerRuntimeRail({
  language,
  running,
  stopping = false,
  taskPlan,
  goal,
  goalRounds = [],
  goalCancelling = false,
  goalWaiting = false,
  thinkingNotice,
  thinkingOpen,
  changeReports,
  changeSummary,
  queuedMessageCount = 0,
  queuedMessagePreview = '',
  queuedMessages = [],
  onToggleThinking,
  onCloseThinking,
  onCancelGoal,
  onOpenChangeReview,
  onEditQueuedMessage,
  onGuideQueuedMessage,
  onRemoveQueuedMessage,
}: {
  language: AppLanguage;
  running: boolean;
  stopping?: boolean;
  taskPlan?: TaskPlanSnapshot;
  goal?: ExperimentalGoal | null;
  goalRounds?: GoalToolUpdate[];
  goalCancelling?: boolean;
  goalWaiting?: boolean;
  thinkingNotice: ThinkingNotice | null;
  thinkingOpen: boolean;
  changeReports: ConversationChangeReport[];
  changeSummary: ConversationChangeSummary | null;
  queuedMessageCount?: number;
  queuedMessagePreview?: string;
  queuedMessages?: RuntimeQueuedMessage[];
  onToggleThinking: () => void;
  onCloseThinking: () => void;
  onCancelGoal?: () => Promise<void>;
  onOpenChangeReview: () => void;
  onEditQueuedMessage?: (item: RuntimeQueuedMessage) => void;
  onGuideQueuedMessage?: (queuedId: string) => Promise<void>;
  onRemoveQueuedMessage?: (queuedId: string) => void;
}) {
  const [processingOpen, setProcessingOpen] = useState(false);
  const [changesOpen, setChangesOpen] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [guidingQueuedId, setGuidingQueuedId] = useState('');
  const hasProcessing = running || Boolean(goal);
  const activePanel = processingOpen
    ? 'processing'
    : thinkingOpen
      ? 'thinking'
      : changesOpen
        ? 'changes'
        : queueOpen
          ? 'queue'
          : null;
  const [renderedPanel, setRenderedPanel] = useState(activePanel);
  const panelPresence = useSoftPanelPresence(Boolean(activePanel), 180);
  const changedFiles = useMemo(
    () => mergeChangedFiles(changeReports),
    [changeReports],
  );
  const expanded = panelPresence.mounted;
  const completedPlanSteps = taskPlan?.nodes.filter((node) => node.status === 'completed').length ?? 0;
  const processingSummary = runtimeProcessingSummary({
    language,
    taskPlan,
    completedPlanSteps,
    goal,
    goalWaiting,
  });
  const changedLineCount = changeSummary
    ? changeSummary.additions + changeSummary.deletions
    : 0;
  const firstQueuedMessage = queuedMessages[0] ?? null;
  const queuePreview = queuedMessagePreview.trim() || firstQueuedMessage?.text.trim() || '';
  const railItems = useMemo<RuntimeRailItem[]>(() => {
    const items: RuntimeRailItem[] = [];
    if (hasProcessing) {
      items.push({
        kind: 'processing',
        label: running
          ? stopping
            ? language === 'zh' ? '停止中' : 'Stopping'
            : language === 'zh' ? '处理中' : 'Working'
          : goal
            ? language === 'zh' ? '目标' : 'Goal'
            : language === 'zh' ? '计划' : 'Plan',
        summary: stopping
          ? language === 'zh'
            ? '正在等待后端确认并保存本轮执行轨迹'
            : 'Waiting for the backend to confirm and preserve this turn'
          : processingSummary ||
            (language === 'zh' ? '正在准备下一步' : 'Preparing the next step'),
        title: processingSummary,
      });
    }
    if (thinkingNotice) {
      items.push({
        kind: 'thinking',
        label: language === 'zh' ? '思考中' : 'Thinking',
        summary: thinkingNotice.preview || thinkingNotice.content,
        title: thinkingNotice.preview || thinkingNotice.content,
      });
    }
    if (changeSummary) {
      const summary = language === 'zh'
        ? `${changeSummary.fileCount} 个文件 · 累计 ${changedLineCount} 行`
        : `${changeSummary.fileCount} files · ${changedLineCount} lines total`;
      items.push({
        kind: 'changes',
        label: running
          ? language === 'zh' ? '更改中' : 'Changing'
          : language === 'zh' ? '已更改' : 'Changed',
        summary,
        title: summary,
      });
    }
    if (queuedMessageCount > 0) {
      const queueHint = language === 'zh'
        ? '当前回复完成后自动发送'
        : 'Sends after the current reply';
      items.push({
        kind: 'queue',
        label: language === 'zh'
          ? `排队 ${queuedMessageCount}`
          : `${queuedMessageCount} queued`,
        summary: queuePreview || queueHint,
        title: `${queueHint}${queuePreview ? `\n${queuePreview}` : ''}`,
      });
    }
    return items;
  }, [
    changeSummary,
    changedLineCount,
    goal,
    hasProcessing,
    language,
    processingSummary,
    queuePreview,
    queuedMessageCount,
    running,
    stopping,
    thinkingNotice,
  ]);
  const railKindKey = railItems.map((item) => item.kind).join(':');
  const availableRailKinds = useMemo<RuntimeRailKind[]>(
    () => railKindKey
      ? railKindKey.split(':') as RuntimeRailKind[]
      : [],
    [railKindKey],
  );
  const [screenKind, setScreenKind] = useState<RuntimeRailKind | null>(null);
  const [rollingToKind, setRollingToKind] = useState<RuntimeRailKind | null>(null);
  const [reelAnimating, setReelAnimating] = useState(false);
  const currentRailItem =
    railItems.find((item) => item.kind === screenKind) ?? railItems[0] ?? null;
  const rollingRailItem = rollingToKind
    ? railItems.find((item) => item.kind === rollingToKind) ?? null
    : null;

  useEffect(() => {
    if (activePanel) {
      setRenderedPanel(activePanel);
    }
  }, [activePanel]);

  useEffect(() => {
    if (!changeSummary) {
      setChangesOpen(false);
    }
  }, [changeSummary]);

  useEffect(() => {
    if (!hasProcessing) {
      setProcessingOpen(false);
    }
  }, [hasProcessing]);

  useEffect(() => {
    if (queuedMessageCount <= 0) {
      setQueueOpen(false);
    }
  }, [queuedMessageCount]);

  useEffect(() => {
    setScreenKind((current) =>
      current && availableRailKinds.includes(current)
        ? current
        : availableRailKinds[0] ?? null,
    );
    if (rollingToKind && !availableRailKinds.includes(rollingToKind)) {
      setReelAnimating(false);
      setRollingToKind(null);
    }
  }, [availableRailKinds, rollingToKind]);

  useEffect(() => {
    if (activePanel && availableRailKinds.includes(activePanel)) {
      setReelAnimating(false);
      setRollingToKind(null);
      setScreenKind(activePanel);
      return undefined;
    }
    if (availableRailKinds.length <= 1 || rollingToKind) return undefined;
    const timer = window.setTimeout(() => {
      const currentIndex = screenKind ? availableRailKinds.indexOf(screenKind) : -1;
      setRollingToKind(
        availableRailKinds[(currentIndex + 1) % availableRailKinds.length],
      );
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [activePanel, availableRailKinds, rollingToKind, screenKind]);

  useEffect(() => {
    if (!rollingToKind) return undefined;
    const frame = window.requestAnimationFrame(() => setReelAnimating(true));
    return () => window.cancelAnimationFrame(frame);
  }, [rollingToKind]);

  useEffect(() => {
    if (!rollingToKind || !reelAnimating) return undefined;
    const timer = window.setTimeout(() => {
      setScreenKind(rollingToKind);
      setReelAnimating(false);
      setRollingToKind(null);
    }, 420);
    return () => window.clearTimeout(timer);
  }, [reelAnimating, rollingToKind]);

  function toggleCurrentPanel(item: RuntimeRailItem) {
    if (item.kind === 'processing') {
      if (thinkingOpen) onCloseThinking();
      setChangesOpen(false);
      setQueueOpen(false);
      setProcessingOpen((current) => !current);
      return;
    }
    if (item.kind === 'thinking') {
      setProcessingOpen(false);
      setChangesOpen(false);
      setQueueOpen(false);
      onToggleThinking();
      return;
    }
    if (item.kind === 'changes') {
      setProcessingOpen(false);
      setQueueOpen(false);
      if (thinkingOpen) onCloseThinking();
      setChangesOpen((current) => !current);
      return;
    }
    setProcessingOpen(false);
    setChangesOpen(false);
    if (thinkingOpen) onCloseThinking();
    setQueueOpen((current) => !current);
  }

  async function guideFirstQueuedMessage() {
    if (!firstQueuedMessage || !onGuideQueuedMessage) return;
    setGuidingQueuedId(firstQueuedMessage.id);
    try {
      await onGuideQueuedMessage(firstQueuedMessage.id);
    } finally {
      setGuidingQueuedId('');
    }
  }

  if (!currentRailItem) return null;

  return (
    <div className={`composer-runtime-rail ${expanded ? 'expanded' : ''} ${panelPresence.visible ? 'context-visible' : 'context-exiting'}`}>
      {panelPresence.mounted && renderedPanel === 'processing' && hasProcessing && (
        <section
          className={`runtime-context-panel processing-context-panel ${running ? 'running' : 'settled'}`}
          aria-label={language === 'zh' ? '处理详情' : 'Working details'}
        >
          <header>
            <span>
              {running
                ? <LoaderCircle size={14} className="spin" />
                : <Target size={14} />}
              <strong>
                {running
                  ? language === 'zh' ? '处理中' : 'Working'
                  : language === 'zh' ? '目标状态' : 'Goal status'}
              </strong>
            </span>
            <button
              type="button"
              title={language === 'zh' ? '收起' : 'Collapse'}
              onClick={() => setProcessingOpen(false)}
            >
              <X size={14} />
            </button>
          </header>
          <div className="processing-context-content">
            {goal && (
              <section className={`runtime-goal-detail ${goal.status}`}>
                <div className="runtime-detail-heading">
                  <Target size={14} />
                  <strong>{language === 'zh' ? '目标' : 'Goal'}</strong>
                  <span>
                    {goal.status === 'active' && goalWaiting
                      ? language === 'zh' ? '等待后端继续' : 'Waiting for backend'
                      : goalStatusLabel(goal.status, language)}
                  </span>
                  {goal.status === 'active' && onCancelGoal && (
                    <button
                      className="runtime-goal-cancel"
                      type="button"
                      disabled={goalCancelling}
                      onClick={() => void onCancelGoal()}
                    >
                      {goalCancelling
                        ? language === 'zh' ? '取消中' : 'Cancelling'
                        : language === 'zh' ? '取消目标' : 'Cancel goal'}
                    </button>
                  )}
                </div>
                <p>{goal.objective}</p>
                {goal.statusReason && (
                  <p className="runtime-goal-reason">{goal.statusReason}</p>
                )}
                <small className="runtime-goal-tokens">
                  {goalTokenLabel(goal, language)}
                </small>
                {goalRounds.length > 0 && (
                  <ol className="runtime-goal-rounds">
                    {goalRounds.map((round, index) => {
                      const isLiveContinuation =
                        round.decision === 'continue' &&
                        goal.status === 'active' &&
                        running &&
                        index === goalRounds.length - 1;
                      return (
                        <li key={`${round.goalId || 'goal'}:${index}:${round.decision}`}>
                          {round.decision === 'complete' ? (
                            <CheckCircle2 size={13} />
                          ) : round.decision === 'blocked' ? (
                            <Circle size={13} />
                          ) : isLiveContinuation ? (
                            <LoaderCircle size={13} />
                          ) : (
                            <Clock3 size={13} />
                          )}
                          <span>
                            <strong>
                              {language === 'zh' ? `第 ${index + 1} 轮` : `Round ${index + 1}`}
                            </strong>
                            <small>{goalDecisionLabel(round.decision, language)}</small>
                            {round.reason && <em>{round.reason}</em>}
                          </span>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </section>
            )}
            {taskPlan && (
              <section className="runtime-plan-detail">
                <div className="runtime-detail-heading">
                  <ListChecks size={14} />
                  <strong>{language === 'zh' ? '计划' : 'Plan'}</strong>
                  <span>{completedPlanSteps}/{taskPlan.nodes.length}</span>
                </div>
                {taskPlan.explanation && <p>{taskPlan.explanation}</p>}
                <ol>
                  {taskPlan.nodes.map((node, index) => (
                    <li className={node.status} key={`${index}:${node.step}`}>
                      {node.status === 'completed' ? (
                        <CheckCircle2 size={13} />
                      ) : node.status === 'in_progress' && running ? (
                        <LoaderCircle size={13} />
                      ) : (
                        <Clock3 size={13} />
                      )}
                      <span>{node.step}</span>
                    </li>
                  ))}
                </ol>
              </section>
            )}
            {!goal && !taskPlan && (
              <p className="runtime-processing-empty">
                {language === 'zh'
                  ? '模型正在生成下一步，计划或目标进度会在收到后显示。'
                  : 'The model is preparing the next step. Plan or goal progress will appear here.'}
              </p>
            )}
          </div>
        </section>
      )}
      {panelPresence.mounted && renderedPanel === 'queue' && queuedMessageCount > 0 && (
        <section
          className="runtime-context-panel queue-context-panel"
          aria-label={language === 'zh' ? '排队消息' : 'Queued message'}
        >
          <header>
            <span>
              <Clock3 size={14} />
              <strong>{language === 'zh' ? `排队 ${queuedMessageCount}` : `${queuedMessageCount} queued`}</strong>
            </span>
            <button
              type="button"
              onClick={() => setQueueOpen(false)}
              aria-label={language === 'zh' ? '关闭排队详情' : 'Close queue details'}
            >
              <X size={14} />
            </button>
          </header>
          <div className="runtime-queue-detail">
            <p>{queuePreview || (language === 'zh' ? '当前回复完成后自动发送' : 'Sends after the current reply')}</p>
            {firstQueuedMessage && (
              <div className="runtime-queue-actions">
                <button
                  type="button"
                  disabled={!onGuideQueuedMessage || guidingQueuedId === firstQueuedMessage.id}
                  onClick={() => void guideFirstQueuedMessage()}
                >
                  {guidingQueuedId === firstQueuedMessage.id ? <LoaderCircle size={13} /> : <Sparkles size={13} />}
                  <span>{language === 'zh' ? '引导' : 'Guide'}</span>
                </button>
                <button
                  type="button"
                  disabled={!onEditQueuedMessage}
                  onClick={() => onEditQueuedMessage?.(firstQueuedMessage)}
                >
                  <Edit3 size={13} />
                  <span>{language === 'zh' ? '编辑' : 'Edit'}</span>
                </button>
                <button
                  type="button"
                  disabled={!onRemoveQueuedMessage}
                  onClick={() => onRemoveQueuedMessage?.(firstQueuedMessage.id)}
                >
                  <Trash2 size={13} />
                  <span>{language === 'zh' ? '删除' : 'Delete'}</span>
                </button>
              </div>
            )}
          </div>
        </section>
      )}
      {panelPresence.mounted && renderedPanel === 'thinking' && thinkingNotice && (
        <section className="runtime-context-panel thinking-context-panel" aria-label="Thinking">
          <header>
            <span><Brain size={14} /><strong>{language === 'zh' ? '思考中' : 'Thinking'}</strong></span>
            <button type="button" title={language === 'zh' ? '收起' : 'Collapse'} onClick={onCloseThinking}>
              <X size={14} />
            </button>
          </header>
          <div className="thinking-context-content">{thinkingNotice.content}</div>
        </section>
      )}
      {panelPresence.mounted && renderedPanel === 'changes' && changeSummary && (
        <section
          className="runtime-context-panel change-context-panel"
          aria-label={language === 'zh' ? '文件更改' : 'File changes'}
        >
          <header>
            <span>
              <Code2 size={14} />
              <strong>
                {language === 'zh'
                  ? `${changeSummary.fileCount} 个文件 · ${changedLineCount} 行`
                  : `${changeSummary.fileCount} files · ${changedLineCount} lines`}
              </strong>
            </span>
            <div className="runtime-context-actions">
              <button
                type="button"
                title={language === 'zh' ? '完整审阅' : 'Open full review'}
                onClick={() => onOpenChangeReview()}
              >
                <PanelRightOpen size={14} />
              </button>
              <button
                type="button"
                title={language === 'zh' ? '收起' : 'Collapse'}
                onClick={() => setChangesOpen(false)}
              >
                <X size={14} />
              </button>
            </div>
          </header>
          <div className="change-context-files">
            {changedFiles.length > 0 ? changedFiles.map((file) => (
              <div className="change-context-file" key={file.path}>
                <strong title={file.path}>{file.path}</strong>
                <span>
                  {file.additions > 0 && <b className="diff-count add">+{file.additions}</b>}
                  {file.deletions > 0 && <b className="diff-count del">-{file.deletions}</b>}
                </span>
              </div>
            )) : (
              <p>
                {language === 'zh'
                  ? '已收到变更统计，文件明细将在工具返回 diff 后显示。'
                  : 'Change totals are available; file details appear when the tool returns a diff.'}
              </p>
            )}
          </div>
        </section>
      )}
      <button
        className={`composer-runtime-screen ${currentRailItem.kind} ${
          currentRailItem.kind === activePanel ? 'open' : ''
        } ${running ? 'running' : 'settled'} ${reelAnimating ? 'rolling' : ''}`}
        type="button"
        aria-expanded={currentRailItem.kind === activePanel}
        title={currentRailItem.title}
        onClick={() => toggleCurrentPanel(currentRailItem)}
      >
        <span className="runtime-screen-viewport" aria-live="polite">
          <span className={`runtime-screen-track ${reelAnimating ? 'rolling' : ''}`}>
            <RuntimeScreenLine
              item={currentRailItem}
              running={running}
              changeSummary={changeSummary}
            />
            {rollingRailItem && (
              <RuntimeScreenLine
                item={rollingRailItem}
                running={running}
                changeSummary={changeSummary}
                hidden
              />
            )}
          </span>
        </span>
      </button>
    </div>
  );
}

function RuntimeScreenLine({
  item,
  running,
  changeSummary,
  hidden = false,
}: {
  item: RuntimeRailItem;
  running: boolean;
  changeSummary: ConversationChangeSummary | null;
  hidden?: boolean;
}) {
  return (
    <span
      className={`runtime-screen-line ${item.kind}`}
      aria-hidden={hidden || undefined}
    >
      {item.kind === 'processing' ? (
        running ? <LoaderCircle size={13} /> : <Target size={13} />
      ) : item.kind === 'thinking' ? (
        <Brain size={13} />
      ) : item.kind === 'changes' ? (
        <Code2 size={13} />
      ) : (
        <Clock3 size={13} />
      )}
      <strong>{item.label}</strong>
      <small>{item.summary}</small>
      {item.kind === 'changes' && changeSummary && (
        <span className="runtime-screen-diff">
          {changeSummary.additions > 0 && (
            <b className="diff-count add">+{changeSummary.additions}</b>
          )}
          {changeSummary.deletions > 0 && (
            <b className="diff-count del">-{changeSummary.deletions}</b>
          )}
        </span>
      )}
    </span>
  );
}

function runtimeProcessingSummary({
  language,
  taskPlan,
  completedPlanSteps,
  goal,
  goalWaiting,
}: {
  language: AppLanguage;
  taskPlan?: TaskPlanSnapshot;
  completedPlanSteps: number;
  goal?: ExperimentalGoal | null;
  goalWaiting?: boolean;
}) {
  const parts: string[] = [];
  if (taskPlan) {
    parts.push(
      language === 'zh'
        ? `计划 ${completedPlanSteps}/${taskPlan.nodes.length}`
        : `Plan ${completedPlanSteps}/${taskPlan.nodes.length}`,
    );
  }
  if (goal?.objective) {
    parts.push(`${language === 'zh' ? '目标' : 'Goal'}：${goal.objective}`);
    parts.push(
      goal.status === 'active' && goalWaiting
        ? language === 'zh' ? '等待后端继续' : 'Waiting for backend'
        : goalStatusLabel(goal.status, language),
    );
  }
  return parts.join(' · ');
}

function goalTokenLabel(goal: ExperimentalGoal, language: AppLanguage) {
  const prefix = language === 'zh' ? 'Token' : 'Tokens';
  return goal.tokenBudget == null
    ? `${prefix}：${goal.consumedTokens}`
    : `${prefix}：${goal.consumedTokens} / ${goal.tokenBudget}`;
}

function goalStatusLabel(status: ExperimentalGoal['status'], language: AppLanguage) {
  const labels = language === 'zh'
    ? { active: '进行中', complete: '已完成', blocked: '已阻塞', cancelled: '已取消' }
    : { active: 'Active', complete: 'Complete', blocked: 'Blocked', cancelled: 'Cancelled' };
  return labels[status];
}

function goalDecisionLabel(decision: GoalToolUpdate['decision'], language: AppLanguage) {
  if (decision === 'continue') return language === 'zh' ? '继续执行' : 'Continue';
  if (decision === 'complete') return language === 'zh' ? '确认完成' : 'Complete';
  return language === 'zh' ? '确认阻塞' : 'Blocked';
}

function mergeChangedFiles(reports: ConversationChangeReport[]): ToolFileChange[] {
  const byPath = new Map<string, ToolFileChange>();
  for (const report of reports) {
    for (const file of report.files) {
      const existing = byPath.get(file.path);
      if (!existing) {
        byPath.set(file.path, { ...file });
        continue;
      }
      existing.additions += file.additions;
      existing.deletions += file.deletions;
      if (file.diff) {
        existing.diff = existing.diff ? `${existing.diff}\n${file.diff}` : file.diff;
      }
      existing.lines.push(...file.lines);
    }
  }
  return [...byPath.values()];
}
