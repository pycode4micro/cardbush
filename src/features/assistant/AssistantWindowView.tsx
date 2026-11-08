import type { ChatStreamRequest } from '../../backend/api';
import { UiLanguageProvider } from '../../i18n/react';
import { ApplicationVoiceHost } from '../voice/VoiceConversation';
import { AssistantView } from './AssistantView';
import { AssistantEventConnection } from './events/AssistantEventConnection';

export function AssistantWindowView({language, theme, appearance, prepare, retainDraft, enabled, ownsConfiguration}: {
  language:string; theme:string; appearance:Record<string,string>; prepare():Promise<ChatStreamRequest>;
  retainDraft(value:boolean):void; enabled:boolean; ownsConfiguration:boolean;
}) {
  return <UiLanguageProvider language={language}><ApplicationVoiceHost language={language}>
    <main className={`app resident-assistant ${theme}`} lang={language} style={appearance}>
      <AssistantView active language={language} prepare={prepare} ownsConfiguration={ownsConfiguration}
        floating={{retainDraft, returnToWorkspace:() => void window.cardbushDesktop?.assistantMode?.('workspace')}}/>
      <AssistantEventConnection prepare={prepare} language={language} configuration={prepare} enabled={ownsConfiguration && enabled}/>
    </main>
  </ApplicationVoiceHost></UiLanguageProvider>;
}
