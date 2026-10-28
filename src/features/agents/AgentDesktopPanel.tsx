import { uiText } from '../../i18n';
import { Suspense, type ComponentProps } from 'react';
import { DeferredModuleNotice, recoverableLazy } from '../../shared/recoverableLazy';
import type { AgentDesktopView } from './AgentDesktopView';

const Desktop = recoverableLazy('agent-desktop',
  async () => ({ default: (await import('./AgentDesktopView')).AgentDesktopView }),
  (props, retry) => <DeferredModuleNotice language={props.language} retry={retry}/>);

export function AgentDesktopPanel(props: ComponentProps<typeof AgentDesktopView>) {
  return <Suspense fallback={<div className="deferred-module-notice" role="status">
    {uiText(props.language)('agentDesktopPanel.loadingRemoteDesktop')}
  </div>}><Desktop {...props}/></Suspense>;
}
