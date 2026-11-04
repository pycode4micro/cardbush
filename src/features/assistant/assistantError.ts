import { uiText } from '../../i18n';
import type { AppLanguage } from '../../types';

export function assistantErrorText(message: string, language: AppLanguage): string {
  return /^Provider binding .+ is unavailable\.$/.test(message)
    ? uiText(language)('assistantView.modelBindingUnavailable') : message;
}
