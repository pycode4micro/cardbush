import { ArrowLeft, ArrowRight } from 'lucide-react';
import { uiText } from '../../i18n';
import type { AppLanguage } from '../../types';
import type { InspectorTab } from './inspectorTabs';
import type { InspectorNavigationState, InspectorWebviewHandle } from './InspectorWebview';

type TabHistory = {
  tab: InspectorTab; navigation?: InspectorNavigationState; handle?: InspectorWebviewHandle;
  onStep?: (id: string, step: 'back' | 'forward') => void;
};

export function inspectorHistoryActions({ tab, navigation, handle, onStep }: TabHistory) {
  const native = tab.kind === 'resource' && (!navigation?.sourceTarget || navigation.sourceTarget === tab.detail.target)
    ? navigation : undefined;
  let back = native?.canGoBack ? handle?.goBack : undefined;
  let forward = native?.canGoForward ? handle?.goForward : undefined;
  if (!native?.canGoBack && onStep && 'backToStart' in tab && tab.backToStart) back = () => onStep(tab.id, 'back');
  if (onStep && tab.kind === 'resource' && tab.forwardPage) forward = () => onStep(tab.id, 'forward');
  return { back, forward };
}

export function InspectorHistoryButtons({ language, ...history }: TabHistory & { language: AppLanguage }) {
  const actions = inspectorHistoryActions(history);
  const t = uiText(language);
  return <>
    <button type="button" className="inspector-history-back" title={t('app.back')} aria-label={t('app.back')}
      disabled={!actions.back} onClick={actions.back}>
      <ArrowLeft size={15} aria-hidden="true"/>
    </button>
    <button type="button" className="inspector-history-forward" title={t('app.forward')} aria-label={t('app.forward')}
      disabled={!actions.forward} onClick={actions.forward}>
      <ArrowRight size={15} aria-hidden="true"/>
    </button>
  </>;
}
