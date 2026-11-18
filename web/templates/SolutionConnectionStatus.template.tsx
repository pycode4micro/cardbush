import { uiText } from '../../src/i18n';
import { useUiLanguage } from '../../src/i18n/react';

export function SolutionConnectionStatus({ localUnavailable, remoteUnavailable }: { localUnavailable?: boolean; remoteUnavailable?: boolean }) {
  const t = uiText(useUiLanguage());
  return <>
    {localUnavailable && <p className="form-error" role="alert">{t('web.remoteQuestionsUnavailable')}</p>}
    {remoteUnavailable && <p className="muted" role="status">{t('web.remoteQuestionsOffline')}</p>}
  </>;
}
