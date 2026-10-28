import { uiText } from '../../i18n';
import { Suspense, type ComponentProps } from 'react';
import { DeferredModuleNotice, recoverableLazy } from '../../shared/recoverableLazy';
import type { CardlingSceneHost } from './CardlingSceneHost';

type Props = ComponentProps<typeof CardlingSceneHost>;
const Scene = recoverableLazy('interactive-scene',
  async () => ({ default: (await import('./CardlingSceneHost')).CardlingSceneHost }),
  (props, retry) => <div><DeferredModuleNotice language={props.language} retry={retry}/>
    <button type="button" onClick={props.onClose}>{uiText(props.language)('cardlingScenePanel.closeScene')}</button></div>);

export function CardlingScenePanel(props: Props) {
  return <Suspense fallback={<div className="deferred-module-notice" role="status">
    <span>{uiText(props.language)('cardlingScenePanel.loadingInteractiveScene')}</span>
    <button type="button" onClick={props.onClose}>{uiText(props.language)('common.close')}</button>
  </div>}><Scene {...props}/></Suspense>;
}
