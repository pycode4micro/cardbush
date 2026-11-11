import type { AppLanguage } from '../../types';
import { useSyncExternalStore } from 'react';
import { uiText } from '../../i18n';
import { AssistantStage } from '../assistant/AssistantCharacter';
import { useAssistantActivity, voiceCallActivity } from '../assistant/assistantActivity';
import { useAssistantAvatar } from '../assistant/assistantAvatar';
import { useAssistantActions } from '../assistant/useAssistantActions';
import { useSidebarContextMenu } from '../sidebar/SidebarContextMenu';
import { applicationVoiceSession } from '../voice/VoiceConversation';
import { voiceComposerPresentation } from '../voice/voiceComposerPresentation';
import { VoiceComposerPanel } from '../voice/VoiceComposerPanel';

export function AssistantStageButton({ language, active, composerObscured, onOpen, onReturnToCall }: {
  language: AppLanguage; active: boolean; composerObscured?: boolean; onOpen(): void; onReturnToCall(id: string): void;
}) {
  const assistant = useAssistantActions(language);
  const { menu, openContextMenu } = useSidebarContextMenu();
  const activity = useAssistantActivity();
  const avatar = useAssistantAvatar();
  const t = uiText(language);
  const voice = applicationVoiceSession();
  const call = useSyncExternalStore(voice.subscribe, () => voiceCallActivity(voice.snapshot()));
  const presentation = voiceComposerPresentation(voice);
  const docked = useSyncExternalStore(presentation.subscribe, presentation.snapshot);
  const backgroundCall = call && (!docked || composerObscured);
  const scene = call ?? activity;
  const status = t(`assistantActivity.${scene}`);
  const entry =
    <button className="recent-bar-chat" type="button" data-nav-section="assistant"
      aria-current={active && !backgroundCall ? 'page' : undefined} aria-label={backgroundCall ? t('voiceComposerPanel.returnToCall', { status }) : t('assistantActivity.open', { name: assistant.profile.name, status })}
      onClick={backgroundCall ? () => onReturnToCall(voice.snapshot().sessionId ?? '') : onOpen} onContextMenu={event => openContextMenu(event, 'nav:assistant', assistant.items)}
      onKeyDown={event => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) openContextMenu(event, 'nav:assistant', assistant.items);
      }}>
      <AssistantStage state={scene} avatar={avatar}/>
      <span className="recent-chat-copy"><strong>{assistant.profile.name}</strong><small>{status}</small></span>
    </button>;
  return <>
    {backgroundCall ? <div className="stage-call-slot">
      {entry}
      <div className="stage-call-controls no-drag"><VoiceComposerPanel session={voice} language={language} showVoicePicker={false} playConnectingCue={!docked}/></div>
    </div> : entry}
    {menu}
    {assistant.dialog}
  </>;
}
