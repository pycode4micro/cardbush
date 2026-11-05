import { ArrowLeft, ArrowRight } from 'lucide-react';
import { uiText } from '../../i18n';
import type { AppLanguage } from '../../types';
import type { InspectorTab } from './inspectorTabs';
import type { InspectorNavigationState, InspectorWebviewHandle } from './InspectorWebview';

export function InspectorHistoryButtons({ tab, language, navigation, handle, onStep }: {
  tab: InspectorTab; language: AppLanguage; navigation?: InspectorNavigationState; handle?: InspectorWebviewHandle;
  onStep?: (id: string, step: 'back' | 'forward') => void;
}) {
  const native = tab.kind === 'resource' && (!navigation?.sourceTarget || navigation.sourceTarget === tab.detail.target)
    ? navigation : undefined;
  const backToStart = Boolean(onStep && 'backToStart' in tab && tab.backToStart);
  const forwardToPage = Boolean(onStep && tab.kind === 'resource' && tab.forwardPage);
  const t = uiText(language);
  return <>
    <button type="button" className="inspector-history-back" title={t('app.back')} aria-label={t('app.back')}
      disabled={!native?.canGoBack && !backToStart}
      onClick={() => native?.canGoBack ? handle?.goBack() : onStep?.(tab.id, 'back')}>
      <ArrowLeft size={15} aria-hidden="true"/>
    </button>
    <button type="button" className="inspector-history-forward" title={t('app.forward')} aria-label={t('app.forward')}
      disabled={!native?.canGoForward && !forwardToPage}
      onClick={() => forwardToPage ? onStep?.(tab.id, 'forward') : handle?.goForward()}>
      <ArrowRight size={15} aria-hidden="true"/>
    </button>
  </>;
}
