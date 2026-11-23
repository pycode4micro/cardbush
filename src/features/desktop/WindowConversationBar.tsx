import { useSyncExternalStore } from 'react';
import { PhoneCall } from 'lucide-react';
import { PERSONAL_ASSISTANT_SESSION, type AssistantWorkActivity } from '@cardbush/bush-protocol';
import { uiText } from '../../i18n';
import { useAssistantWorkActivity, voiceCallActivity } from '../assistant/assistantActivity';
import { applicationVoiceSession } from '../voice/VoiceConversation';
import { VoiceComposerPanel, useVoiceConnectingCue } from '../voice/VoiceComposerPanel';
import { voiceComposerPresentation } from '../voice/voiceComposerPresentation';

type ToolbarConversation = { id: string; title: string; status?: string; activity?: AssistantWorkActivity };

type Props = {
  language: string; conversation: ToolbarConversation; viewingConversation: boolean; assistantName: string;
  activeView?: 'assistant' | 'chat'; open(id: string, returnToCall?: boolean): void;
};

export function WindowConversationBar(props: Props) {
  return <div className="window-conversation-context">
    {props.activeView === 'assistant'
      ? <AssistantWindowTitle language={props.language} assistantName={props.assistantName}/>
      : props.activeView === 'chat'
        ? <ConversationWindowTitle title={props.conversation.title} status={props.conversation.status} activity={props.conversation.activity}/>
        : <ConversationStatusButton {...props}/>}
    <WindowCallControls language={props.language} open={props.open}/>
  </div>;
}

function AssistantWindowTitle({ language, assistantName }: Pick<Props, 'language' | 'assistantName'>) {
  const t = uiText(language);
  const activity = useAssistantWorkActivity();
  const status = activity === 'idle' ? undefined : t(activity === 'working' ? 'assistantTitlebar.working'
    : activity === 'waiting' ? 'sessionAttention.confirmationPending' : `assistantActivity.${activity}`);
  return <ConversationWindowTitle title={assistantName} status={status} activity={activity}/>;
}

function ConversationWindowTitle({ title, status, activity = 'idle' }: Pick<ToolbarConversation, 'title' | 'status' | 'activity'>) {
  return <div className="window-conversation-identity">
    <h1 className="window-conversation-name" title={title}>{title}</h1>
    <span className="window-conversation-status" role="status" data-activity={activity}>
      {status && <span>{status}</span>}
    </span>
  </div>;
}

function ConversationStatusButton({ language, conversation, viewingConversation, assistantName, open }: Props) {
  const t = uiText(language);
  const activity = useAssistantWorkActivity();
  const assistantStatus = activity !== 'idle' && activity !== 'error' ? t(`assistantActivity.${activity}`) : undefined;
  let { id, title, status } = conversation;
  if (id === PERSONAL_ASSISTANT_SESSION) status = assistantStatus;
  if (viewingConversation && !status) return null;
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
