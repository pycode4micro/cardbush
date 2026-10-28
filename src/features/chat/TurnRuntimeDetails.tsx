import { uiText } from '../../i18n';
import { CheckCircle2, Circle, Clock3, ListChecks, LoaderCircle, Target } from 'lucide-react';
import type { AppLanguage, TaskPlanSnapshot } from '../../types';
import type { ExperimentalGoal } from '../../backend/api';
import type { GoalToolUpdate } from '../../shared/goalState';
import { taskPlanWaitingLabel } from '../taskPlanWaiting';

type TurnRuntimeProps = {
  language: AppLanguage; running: boolean; stopping?: boolean;
  goal?: ExperimentalGoal | null; goalRounds?: GoalToolUpdate[];
  goalCancelling?: boolean; goalWaiting?: boolean; onCancelGoal?: () => Promise<void>;
};
export function TurnRuntimeDetails({ language, running, stopping, goal, goalRounds = [], goalCancelling, goalWaiting,
  onCancelGoal,
}: TurnRuntimeProps) {
  if (!goal && !stopping) return null;
  return <div className="turn-runtime-details" aria-label={uiText(language)('turnRuntimeDetails.turnProgress')}>
    {stopping && <p role="status">{uiText(language)('turnRuntimeDetails.stoppingAndSavingThisTurn')}</p>}
    {goal && (
      <section className={`runtime-goal-detail ${goal.status}`}>
        <div className="runtime-detail-heading">
          <Target size={14} />
          <strong>{uiText(language)('turnRuntimeDetails.goal')}</strong>
          <span>
            {goal.status === 'active' && goalWaiting
              ? uiText(language)('turnRuntimeDetails.waitingForTheTask')
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
                ? uiText(language)('turnRuntimeDetails.cancelling')
                : uiText(language)('turnRuntimeDetails.cancelGoal')}
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
                      {uiText(language)('turnRuntimeDetails.round', { value1: index + 1 })}
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
  </div>;
}

/** Shared plan view for the summary and archived runtime details. */
export function RuntimeTaskPlan({ plan, language, running = false }: {
  plan: TaskPlanSnapshot; language: AppLanguage; running?: boolean;
}) {
  return <section className="runtime-plan-detail">
        <div className="runtime-detail-heading">
          <ListChecks size={14} />
          <strong>{uiText(language)('turnRuntimeDetails.plan')}</strong>
          <span>{plan.nodes.filter(node => node.status === 'completed').length}/{plan.nodes.length}</span>
        </div>
        {plan.explanation && <p>{plan.explanation}</p>}
        <ol>
          {plan.nodes.map((node, index) => (
            <li className={node.status} key={`${index}:${node.step}`}>
              {node.status === 'completed' ? (
                <CheckCircle2 size={13} />
              ) : node.status === 'in_progress' && running ? (
                <LoaderCircle size={13} className="runtime-plan-spinner" />
              ) : (
                <Clock3 size={13} />
              )}
              <span>{node.step}{node.status === 'waiting' && <small> — {taskPlanWaitingLabel(node.waitingKind, language)}{uiText(language)('turnRuntimeDetails.message')}{node.waitingFor}</small>}</span>
            </li>
          ))}
        </ol>
      </section>;
}
function goalTokenLabel(goal: ExperimentalGoal, language: AppLanguage) {
  const prefix = uiText(language)('turnRuntimeDetails.tokens');
  return goal.tokenBudget == null
    ? `${prefix}：${goal.consumedTokens}`
    : `${prefix}：${goal.consumedTokens} / ${goal.tokenBudget}`;
}

function goalStatusLabel(status: ExperimentalGoal['status'], language: AppLanguage) {
  const labels = ({ active: uiText(language)('turnRuntimeDetails.active'), complete: uiText(language)('turnRuntimeDetails.complete'), blocked: uiText(language)('turnRuntimeDetails.blocked'), cancelled: uiText(language)('browserLibraryDialog.cancelled') });
  return labels[status];
}

function goalDecisionLabel(decision: GoalToolUpdate['decision'], language: AppLanguage) {
  if (decision === 'continue') return uiText(language)('turnRuntimeDetails.continue');
  if (decision === 'complete') return uiText(language)('turnRuntimeDetails.complete_5d09a48');
  return uiText(language)('turnRuntimeDetails.blocked_ffb9b04');
}
