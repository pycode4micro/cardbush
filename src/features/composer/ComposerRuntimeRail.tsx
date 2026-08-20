import {
  Brain,
  CheckCircle2,
  Circle,
  Clock3,
  Code2,
  ListChecks,
  LoaderCircle,
  PanelRightOpen,
  Target,
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

export function ComposerRuntimeRail({
  language,
  running,
  taskPlan,
  goal,
  goalRounds = [],
  goalCancelling = false,
  goalWaiting = false,
  thinkingNotice,
  thinkingOpen,
  changeReports,
  changeSummary,
  onToggleThinking,
  onCloseThinking,
  onCancelGoal,
  onOpenChangeReview,
}: {
  language: AppLanguage;
  running: boolean;
  taskPlan?: TaskPlanSnapshot;
  goal?: ExperimentalGoal | null;
  goalRounds?: GoalToolUpdate[];
  goalCancelling?: boolean;
  goalWaiting?: boolean;
  thinkingNotice: ThinkingNotice | null;
  thinkingOpen: boolean;
  changeReports: ConversationChangeReport[];
  changeSummary: ConversationChangeSummary | null;
  onToggleThinking: () => void;
  onCloseThinking: () => void;
  onCancelGoal?: () => Promise<void>;
  onOpenChangeReview: () => void;
}) {
  const [processingOpen, setProcessingOpen] = useState(false);
  const [changesOpen, setChangesOpen] = useState(false);
  const hasProcessing = running || Boolean(goal);
  const activePanel = processingOpen
    ? 'processing'
    : thinkingOpen
      ? 'thinking'
      : changesOpen
        ? 'changes'
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
                onClick={onOpenChangeReview}
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
      <div className="composer-runtime-tabs">
        {hasProcessing && (
          <button
            className={`runtime-context-tab processing-context-tab ${running ? 'running' : 'settled'} ${processingOpen ? 'open' : ''}`}
            type="button"
            role="status"
            aria-expanded={processingOpen}
            title={processingSummary}
            onClick={() => {
              if (thinkingOpen) onCloseThinking();
              setChangesOpen(false);
              setProcessingOpen((current) => !current);
            }}
          >
            {running ? <LoaderCircle size={13} /> : <Target size={13} />}
            <span>
              <strong>
                {running
                  ? language === 'zh' ? '处理中' : 'Working'
                  : language === 'zh' ? '目标' : 'Goal'}
              </strong>
              {processingSummary && <small>{processingSummary}</small>}
            </span>
          </button>
        )}
        {thinkingNotice && (
          <button
            className={`runtime-context-tab thinking-context-tab ${thinkingOpen ? 'open' : ''}`}
            type="button"
            title={thinkingNotice.preview}
            aria-expanded={thinkingOpen}
            onClick={() => {
              setProcessingOpen(false);
              setChangesOpen(false);
              onToggleThinking();
            }}
          >
            <span className="runtime-tab-pulse" />
            <Brain size={12} />
            <span><strong>{language === 'zh' ? '思考中' : 'Thinking'}</strong></span>
          </button>
        )}
        {changeSummary && (
          <button
            className={`runtime-context-tab change-context-tab ${changesOpen ? 'open' : ''}`}
            type="button"
            title={language === 'zh' ? '查看本轮文件更改' : 'View file changes from this turn'}
            aria-expanded={changesOpen}
            onClick={() => {
              setProcessingOpen(false);
              if (thinkingOpen) {
                onCloseThinking();
              }
              setChangesOpen((current) => !current);
            }}
          >
            <span className="runtime-tab-pulse" />
            <Code2 size={12} />
            <span>
              <strong>{running ? (language === 'zh' ? '更改中' : 'Changing') : (language === 'zh' ? '已更改' : 'Changed')}</strong>
              <small>
                {language === 'zh'
                  ? `${changeSummary.fileCount} 个文件 · 累计 ${changedLineCount} 行`
                  : `${changeSummary.fileCount} files · ${changedLineCount} lines total`}
              </small>
              {changeSummary.additions > 0 && <b className="diff-count add">+{changeSummary.additions}</b>}
              {changeSummary.deletions > 0 && <b className="diff-count del">-{changeSummary.deletions}</b>}
            </span>
          </button>
        )}
      </div>
    </div>
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
