import type { MessageKey } from '../../i18n';
import { uiText } from '../../i18n';
import type { AppLanguage, ReasoningLevel } from '../../types';

export function modelReasoningLabel(level: ReasoningLevel, language: AppLanguage) {
  const labels: Record<ReasoningLevel, MessageKey> = {
    default: 'modelReasoning.providerDefault',
    none: 'composer.none', low: 'composer.low', medium: 'composer.medium',
    high: 'composer.high', xhigh: 'composer.extraHigh', max: 'composer.max',
  };
  return uiText(language)(labels[level]);
}
