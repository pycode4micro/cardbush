import { Suspense, type ComponentProps } from 'react';
import { DeferredModuleNotice, recoverableLazy } from '../../shared/recoverableLazy';
import type { CardlingSceneHost } from './CardlingSceneHost';

type Props = ComponentProps<typeof CardlingSceneHost>;
const Scene = recoverableLazy('interactive-scene',
  async () => ({ default: (await import('./CardlingSceneHost')).CardlingSceneHost }),
  (props, retry) => <div><DeferredModuleNotice language={props.language} retry={retry}/>
    <button type="button" onClick={props.onClose}>{props.language === 'zh' ? '关闭场景' : 'Close scene'}</button></div>);

export function CardlingScenePanel(props: Props) {
  return <Suspense fallback={<div className="deferred-module-notice" role="status">
    <span>{props.language === 'zh' ? '正在加载交互场景…' : 'Loading interactive scene…'}</span>
    <button type="button" onClick={props.onClose}>{props.language === 'zh' ? '关闭' : 'Close'}</button>
  </div>}><Scene {...props}/></Suspense>;
}
