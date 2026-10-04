import { RefreshCw, X } from 'lucide-react';
import type { AppLanguage, ChatMessage } from '../../types';
import { useLiveThinkingNotice } from '../composer/useLiveThinkingNotice';
import { AssistantThinkingDetail } from './AssistantThinkingProcessLine';
import { isGuidanceSealedAssistantSegment, isTurnGuidanceMessage } from './transcript/messageFacts';

function delivery(message: ChatMessage) {
  const value = message.metadata?.guidance_delivery ?? message.status;
  return value === 'pending' || value === 'queued' || value === 'failed' ? value : 'sent';
}

/** Presentation only: waiting for a reply must not invent persisted assistant messages. */
export function guidanceActivityMessages(messages: ChatMessage[], sending: boolean, turnId: string) {
  const ids = new Set<string>();
  let followingAssistant = false, latestGuidance = false;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === 'user' && isTurnGuidanceMessage(message) && delivery(message) === 'failed') {
      ids.add(message.id);
      continue;
    }
    if (!sending || !turnId || message.turnId !== turnId) continue;
    if (message.role === 'assistant' && !isGuidanceSealedAssistantSegment(message)) followingAssistant = true;
    if (message.role !== 'user' || !isTurnGuidanceMessage(message) || latestGuidance) continue;
    latestGuidance = true;
    if (delivery(message) !== 'sent' || !followingAssistant) ids.add(message.id);
  }
  return ids;
}

export function GuidanceActivity({ message, conversationId, turnId, language, model, thinkingVisible,
  reasoningActive, stopping, retryAvailable, onRetry }: {
  message: ChatMessage; conversationId: string; turnId: string; language: AppLanguage; model: string;
  thinkingVisible: boolean; reasoningActive: boolean; stopping: boolean; retryAvailable: boolean; onRetry: (message: ChatMessage) => Promise<void>;
}) {
  const state = delivery(message);
  // Receipt and segment-boundary events can arrive separately. Until the real
  // assistant releases its tail slot, this row shows delivery state only.
  const liveNotice = useLiveThinkingNotice({ activeConversationId: conversationId, activeTurnId: turnId,
    enabled: thinkingVisible && reasoningActive && state === 'sent',
    running: reasoningActive && !stopping && state === 'sent' });
  const notice = reasoningActive && thinkingVisible && state === 'sent' && !stopping ? liveNotice : null;
  const label = stopping ? (language === 'zh' ? '正在停止' : 'Stopping')
    : state === 'pending' ? (language === 'zh' ? '正在发送引导' : 'Sending guidance')
    : state === 'queued' ? (language === 'zh' ? '等待当前步骤完成' : 'Waiting for the current step')
    : !reasoningActive ? (language === 'zh' ? '等待引导生效' : 'Waiting for guidance to apply')
    : language === 'zh' ? '正在继续处理' : 'Continuing';
  return <div className="message-row assistant guidance-activity" data-guidance-id={message.id}
    data-guidance-state={state} role="status" aria-live="polite">
    {state === 'failed' ? <div className="guidance-activity-error">
      <X size={12} /><span>{language === 'zh' ? '引导发送失败' : 'Guidance failed to send'}</span>
      {retryAvailable && <button type="button" className="guidance-retry-button" onClick={() => void onRetry(message)}>
        <RefreshCw size={11} />{language === 'zh' ? '重试' : 'Retry'}
      </button>}
    </div> : <div className="assistant-bubble">
      <AssistantThinkingDetail language={language} model={model} notice={notice}
        statusLabel={notice ? undefined : label} />
    </div>}
  </div>;
}
