import { CheckCircle2, LoaderCircle, OctagonX } from 'lucide-react';

import type { AppLanguage } from '../../types';
import type { GoalToolUpdate } from '../../shared/goalState';

export function GoalUpdateNotice({
  update,
  language,
}: {
  update: GoalToolUpdate;
  language: AppLanguage;
}) {
  const presentation = goalUpdatePresentation(update, language);
  const Icon = presentation.Icon;
  return (
    <div className={`goal-update-notice ${update.decision}`} role="status">
      <Icon size={14} />
      <div>
        <strong>{presentation.title}</strong>
        {update.reason && <p>{update.reason}</p>}
      </div>
    </div>
  );
}

function goalUpdatePresentation(update: GoalToolUpdate, language: AppLanguage) {
  if (update.decision === 'complete') {
    return {
      Icon: CheckCircle2,
      title: language === 'zh' ? '目标已完成' : 'Goal complete',
    };
  }
  if (update.decision === 'blocked') {
    return {
      Icon: OctagonX,
      title: language === 'zh' ? '目标已阻塞' : 'Goal blocked',
    };
  }
  return {
    Icon: LoaderCircle,
    title: language === 'zh' ? '目标未完成，继续执行' : 'Goal incomplete, continuing',
  };
}
