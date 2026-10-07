import { Suspense, type ComponentProps } from 'react';
import { DeferredModuleNotice, recoverableLazy } from '../../shared/recoverableLazy';
import type { AgentDesktopView } from './AgentDesktopView';

const Desktop = recoverableLazy('agent-desktop',
  async () => ({ default: (await import('./AgentDesktopView')).AgentDesktopView }),
  (props, retry) => <DeferredModuleNotice language={props.language === 'zh' ? 'zh' : 'en'} retry={retry}/>);

export function AgentDesktopPanel(props: ComponentProps<typeof AgentDesktopView>) {
  return <Suspense fallback={<div className="deferred-module-notice" role="status">
    {props.language === 'zh' ? '正在加载远端桌面…' : 'Loading remote desktop…'}
  </div>}><Desktop {...props}/></Suspense>;
}
