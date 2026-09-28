import { CheckCircle2, Circle, Clock3, Code2, ListChecks, LoaderCircle, Target } from 'lucide-react';
import type { AppLanguage, TaskPlanSnapshot } from '../../types';
import type { ExperimentalGoal } from '../../backend/api';
import type { GoalToolUpdate } from '../../shared/goalState';
import type { ConversationChangeSummary } from '../tools';

type TurnRuntimeProps = {
  language: AppLanguage; running: boolean; stopping?: boolean;
  taskPlan?: TaskPlanSnapshot; goal?: ExperimentalGoal | null; goalRounds?: GoalToolUpdate[];
  goalCancelling?: boolean; goalWaiting?: boolean; onCancelGoal?: () => Promise<void>;
  changeSummary?: ConversationChangeSummary | null; onOpenChangeReview: () => void;
};
export function TurnRuntimeDetails({ language, running, stopping, taskPlan, goal, goalRounds = [], goalCancelling, goalWaiting,
  onCancelGoal, changeSummary, onOpenChangeReview,
}: TurnRuntimeProps) {
  const visiblePlan = taskPlan?.nodes.some(node => node.status !== 'completed') ? taskPlan : undefined;
  const completedPlanSteps = visiblePlan?.nodes.filter(node => node.status === 'completed').length ?? 0;
  if (!goal && !visiblePlan && !changeSummary && !stopping) return null;
  return <div className="turn-runtime-details" aria-label={language === 'zh' ? '本轮进度' : 'Turn progress'}>
    {stopping && <p role="status">{language === 'zh' ? '正在停止并保存本轮记录…' : 'Stopping and saving this turn…'}</p>}
    {goal && (
      <section className={`runtime-goal-detail ${goal.status}`}>
        <div className="runtime-detail-heading">
          <Target size={14} />
          <strong>{language === 'zh' ? '目标' : 'Goal'}</strong>
          <span>
            {goal.status === 'active' && goalWaiting
              ? language === 'zh' ? '等待任务继续' : 'Waiting for the task'
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
    {visiblePlan && (
      <section className="runtime-plan-detail">
        <div className="runtime-detail-heading">
          <ListChecks size={14} />
          <strong>{language === 'zh' ? '计划' : 'Plan'}</strong>
          <span>{completedPlanSteps}/{visiblePlan.nodes.length}</span>
        </div>
        {visiblePlan.explanation && <p>{visiblePlan.explanation}</p>}
        <ol>
          {visiblePlan.nodes.map((node, index) => (
            <li className={node.status} key={`${index}:${node.step}`}>
              {node.status === 'completed' ? (
                <CheckCircle2 size={13} />
              ) : node.status === 'in_progress' && running ? (
                <LoaderCircle size={13} />
              ) : (
                <Clock3 size={13} />
              )}
              <span>{node.step}{node.status === 'waiting' && <small> — {language === 'zh' ? '等待：' : 'Waiting: '}{node.waitingFor}</small>}</span>
            </li>
          ))}
        </ol>
      </section>
    )}

    {changeSummary && <button className="turn-change-review" type="button" onClick={onOpenChangeReview}>
      <Code2 size={14} /><span>{language === 'zh' ? `${changeSummary.fileCount} 个文件更改` : `${changeSummary.fileCount} changed files`}</span>
      <b className="diff-count add">+{changeSummary.additions}</b><b className="diff-count del">-{changeSummary.deletions}</b>
    </button>}
  </div>;
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
