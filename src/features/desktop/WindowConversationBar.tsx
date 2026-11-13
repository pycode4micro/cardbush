import { useSyncExternalStore } from 'react';
import { PhoneCall } from 'lucide-react';
import { PERSONAL_ASSISTANT_SESSION } from '@cardbush/bush-protocol';
import { uiText } from '../../i18n';
import { useAssistantWorkActivity, voiceCallActivity } from '../assistant/assistantActivity';
import { applicationVoiceSession } from '../voice/VoiceConversation';
import { VoiceComposerPanel, useVoiceConnectingCue } from '../voice/VoiceComposerPanel';
import { voiceComposerPresentation } from '../voice/voiceComposerPresentation';

type ToolbarConversation = { id: string; title: string; status?: string };

type Props = {
  language: string; conversation: ToolbarConversation; viewingConversation: boolean; assistantName: string; open(id: string, returnToCall?: boolean): void;
};

export function WindowConversationBar(props: Props) {
  return <div className="window-conversation-context">
    <ConversationStatusButton {...props}/>
    <WindowCallControls language={props.language} open={props.open}/>
  </div>;
}

function ConversationStatusButton({ language, conversation, viewingConversation, assistantName, open }: Props) {
  const t = uiText(language);
  const activity = useAssistantWorkActivity();
  const assistantStatus = activity !== 'idle' && activity !== 'error' ? t(`assistantActivity.${activity}`) : undefined;
  let { id, title, status } = conversation;
  if (id === PERSONAL_ASSISTANT_SESSION) status = assistantStatus;
  if (!viewingConversation && !status) {
    if (!assistantStatus) return null;
    id = PERSONAL_ASSISTANT_SESSION;
    title = assistantName;
    status = assistantStatus;
  }
  return <button className="recent-bar-chat" type="button"
    aria-label={status ? t('assistantActivity.open', { name: title, status }) : undefined} onClick={() => open(id)}>
    <span className="recent-chat-copy"><strong>{title}</strong>{status && <small data-activity={id === PERSONAL_ASSISTANT_SESSION ? activity : undefined}>{status}</small>}</span>
  </button>;
}

function WindowCallControls({ language, open }: Pick<Props, 'language' | 'open'>) {
  const t = uiText(language);
  const voice = applicationVoiceSession();
  const call = useSyncExternalStore(voice.subscribe, () => voiceCallActivity(voice.snapshot()));
  const callId = useSyncExternalStore(voice.subscribe, () => voice.snapshot().sessionId ?? '');
  const presentation = voiceComposerPresentation(voice);
  const docked = useSyncExternalStore(presentation.subscribe, presentation.snapshot);
  useVoiceConnectingCue(voice, !docked);
  if (!call) return null;
  const returnLabel = t('voiceComposerPanel.returnToCall', { status: t(`assistantActivity.${call}`) });
  return <div className="stage-call-controls" role="group" aria-label={t(`assistantActivity.${call}`)}>
      {!docked && <button className="background-call-return" type="button" aria-label={returnLabel} title={returnLabel}
        onClick={() => open(callId, true)}><PhoneCall aria-hidden="true"/></button>}
      <VoiceComposerPanel session={voice} language={language} showVoicePicker={false} playConnectingCue={false}/>
  </div>;
}
