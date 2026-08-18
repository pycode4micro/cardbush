import { Target } from 'lucide-react';

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
  return (
    <div className={`goal-update-notice ${update.decision}`} role="status">
      <Target size={14} />
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
      title: language === 'zh' ? '目标已完成' : 'Goal complete',
    };
  }
  if (update.decision === 'blocked') {
    return {
      title: language === 'zh' ? '目标已阻塞' : 'Goal blocked',
    };
  }
  return {
    title: language === 'zh' ? '目标未完成，继续执行' : 'Goal incomplete, continuing',
  };
}
