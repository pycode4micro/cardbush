import { lazy, Suspense, useEffect, useRef, type ComponentProps, type ReactNode } from 'react';
import { ProfileCenter } from '../profile/ProfileCenter';
import { GlobalTooltip } from '../../components/GlobalTooltip';
import { uiText } from '../../i18n';
import { UiLanguageProvider } from '../../i18n/react';
import { ApplicationVoiceHost } from '../voice/VoiceConversation';
import { AssistantView } from './AssistantView';
import { AssistantEventConnection } from './events/AssistantEventConnection';
import { McpUserRequests } from '../plugins/McpUserRequests';
import type { WorkSummaryInspectorDetail } from '../subagents/subagentObservabilityEvents';

const ModelsSettingsPanel = lazy(() => import('../settings/ModelsSettingsPanel').then(module => ({ default: module.ModelsSettingsPanel })));
const WorkSummaryInspector = lazy(() => import('../chat/WorkSummaryInspector').then(module => ({ default: module.WorkSummaryInspector })));
type ModelPanel = ComponentProps<typeof ModelsSettingsPanel>;

function ResidentDialog({ title, language, close, children }: { title: string; language: string; close(): void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (!dialog.current?.open) dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="assistant-settings-dialog resident-dialog" aria-label={title} onClose={close}>
    <header><h2>{title}</h2><button type="button" onClick={close}>{uiText(language)('common.close')}</button></header>
    <Suspense fallback={null}>{children}</Suspense>
  </dialog>;
}

export function AssistantWindowView({ assistant, events, ready, onProfileDialog, theme, appearance, modelPanel, closeModels, detail, closeDetail }: {
  assistant: ComponentProps<typeof AssistantView>; events: ComponentProps<typeof AssistantEventConnection>;
  ready: boolean; onProfileDialog(open: boolean): void; theme: string; appearance: Record<string, string>; modelPanel?: ModelPanel; closeModels(): void;
  detail?: WorkSummaryInspectorDetail; closeDetail(): void;
}) {
  const { language } = assistant, t = uiText(language);
  return <UiLanguageProvider language={language}><ApplicationVoiceHost language={language}>
    <main className={`app resident-assistant ${theme}`} lang={language} style={appearance}>
      <ProfileCenter language={language} ready={ready} onDialogChange={onProfileDialog} prepare={assistant.prepare} floating
        settings={() => window.cardbushDesktop?.openAssistantWorkspace?.('settings')}
        switchWindow={async () => { await window.cardbushDesktop?.assistantMode?.('workspace'); }}>
        <AssistantView {...assistant} compactProfileMenu/>
      </ProfileCenter>
      <AssistantEventConnection {...events} />
      {modelPanel && <ResidentDialog title={t('settingsNavigation.models')} language={language} close={closeModels}><ModelsSettingsPanel {...modelPanel}/></ResidentDialog>}
      {detail && <ResidentDialog title={t('resident.executionDetails')} language={language} close={closeDetail}>
        <WorkSummaryInspector detail={detail} messages={[]} language={language}/>
      </ResidentDialog>}
      <McpUserRequests language={language}/>
      <GlobalTooltip/>
    </main>
  </ApplicationVoiceHost></UiLanguageProvider>;
}
