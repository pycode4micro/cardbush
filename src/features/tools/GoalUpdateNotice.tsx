import { uiText } from '../../i18n';
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
      title: uiText(language)('goalUpdateNotice.goalComplete'),
    };
  }
  if (update.decision === 'blocked') {
    return {
      title: uiText(language)('goalUpdateNotice.goalBlocked'),
    };
  }
  return {
    title: uiText(language)('goalUpdateNotice.goalIncompleteContinuing'),
  };
}
