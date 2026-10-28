import { uiText } from '../../i18n';
import type { AppLanguage } from '../../types';

/** User-facing explanations are localized; provider diagnostics remain verbatim. */
export function modelFailurePresentation(reason: string, message: string, language: AppLanguage, status?: unknown) {

  if (reason === 'open_task_plan_not_resolved') {
    return {
      tone: 'neutral' as const,
      title: uiText(language)('modelFailurePresentation.somePlanStepsAreStillMarkedUnfinished'),
      detail: uiText(language)('modelFailurePresentation.thePlanToolStillRecordsUnfinishedNodes'),
      technicalDetails: undefined,
    };
  }
  const httpStatus = typeof status === 'number' ? status : Number.NaN;
  let detail: string;
  if (/\btool names must be unique\b|\bduplicate tool names?\b|\bconflicting tool definitions\b/i.test(message)) {
    detail = uiText(language)('modelFailurePresentation.duplicateToolNamesCausedTheModelProvider');
  } else if (['insufficient_quota', 'billing_hard_limit_reached', 'billing_not_active'].includes(reason)) {
    detail = uiText(language)('modelFailurePresentation.theModelProviderHasNoAvailableQuota');
  } else if (httpStatus === 401 || reason === 'invalid_api_key') {
    detail = uiText(language)('modelFailurePresentation.modelProviderAuthenticationFailedCheckYourAccount');
  } else if (httpStatus === 403) {
    detail = uiText(language)('modelFailurePresentation.theModelProviderDeniedAccessCheckYour');
  } else if (httpStatus === 429 || reason === 'rate_limit_exceeded') {
    detail = uiText(language)('modelFailurePresentation.theModelProviderIsRateLimitingRequests');
  } else if (httpStatus === 400 || httpStatus === 422 || reason === 'invalid_request_error') {
    detail = uiText(language)('modelFailurePresentation.theModelProviderRejectedTheRequestParameters');
  } else if (httpStatus >= 500 && httpStatus <= 599) {
    detail = uiText(language)('modelFailurePresentation.theModelProviderIsTemporarilyUnavailableTry');
  } else {
    detail = uiText(language)('modelFailurePresentation.thisTurnCouldNotFinishExistingProgress');
  }
  return {
    tone: 'error' as const,
    title: uiText(language)('modelFailurePresentation.thisTurnFailed'),
    detail,
    technicalDetails: [reason, message].filter(Boolean).join('\n'),
  };
}
