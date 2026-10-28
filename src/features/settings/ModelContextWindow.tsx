import { uiText } from '../../i18n';
import { useId, useState } from 'react';
import { CircleHelp } from 'lucide-react';
import { resolveContextBudget, type ContextBudget } from '@cardbush/bush-protocol';
import type { AppLanguage } from '../../types';

export function ModelContextWindow({ contextTokens, outputTokens, language }: {
  contextTokens: number; outputTokens?: number; language: AppLanguage;
}) {
  const helpId = useId();
  const [helpOpen, setHelpOpen] = useState(false);
  let budget: ContextBudget | undefined;
  try { budget = resolveContextBudget(contextTokens, outputTokens); } catch { /* The form validates incomplete edits on save. */ }
  const count = (value: number) => value.toLocaleString(language);
  const regularBudget = budget ? budget.normalInputLimit - budget.compactionOutputTokens - budget.safetyTokens : undefined;
  return <div className="model-context-window">
    <div className="model-context-window-heading">
      <span>{uiText(language)('composer.conversationContextWindow')}
        <button type="button" className="model-context-help-button" aria-label={uiText(language)('modelContextWindow.howContextWindowsAreCalculated')}
          aria-expanded={helpOpen} aria-controls={helpId} onClick={() => setHelpOpen(value => !value)}><CircleHelp size={14}/></button>
      </span>
      <output aria-label={uiText(language)('composer.conversationContextWindow')}>{budget ? `${count(budget.compactionTriggerTokens)} tokens` : '—'}</output>
    </div>
    <p>{budget ? uiText(language)('modelContextWindow.calculatedAutomaticallyContextCompactsAtThisBudget')
      : uiText(language)('modelContextWindow.enterAValidTotalWindowWithAn')}</p>
    {helpOpen && <div id={helpId} className="model-context-window-help">
      <p>{uiText(language)('modelContextWindow.theTotalContextWindowIsTheModel')}</p>
      <p>{uiText(language)('modelContextWindow.reserveTheMaximumOutputForTheNext')}</p>
      {budget && <>
        <dl>
          <div><dt>{uiText(language)('composer.totalContextWindow')}</dt><dd>{count(budget.contextWindowTokens)}</dd></div>
          <div><dt>{uiText(language)('modelContextWindow.replyAndReasoningReserve')}</dt><dd>−{count(budget.normalOutputTokens)}</dd></div>
          <div><dt>{uiText(language)('modelContextWindow.compactionOutputReserve')}</dt><dd>−{count(budget.compactionOutputTokens)}</dd></div>
          <div><dt>{uiText(language)('modelContextWindow.safetyMargin')}</dt><dd>−{count(budget.safetyTokens)}</dd></div>
          <div><dt>{uiText(language)('composer.conversationContextWindow')}</dt><dd>{count(budget.compactionTriggerTokens)}</dd></div>
        </dl>
        {regularBudget !== budget.compactionTriggerTokens && <p>{uiText(language)('modelContextWindow.theReservesLeaveTokensTheSafetyBounds', { value1: count(regularBudget!), value2: count(budget.compactionTriggerTokens) })}</p>}
      </>}
      <p>{uiText(language)('modelContextWindow.theTriggerStaysWithin95OfAvailable')}</p>
    </div>}
  </div>;
}
