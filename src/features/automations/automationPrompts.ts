import { uiText } from '../../i18n';
import type { AppLanguage } from '../../types';

export function automationSetupPrompt(language: AppLanguage): string {
  return uiText(language)('automationPrompts.helpMeCreateAScheduledTaskThrough');
}
