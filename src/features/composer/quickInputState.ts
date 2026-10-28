import { uiText } from '../../i18n';
import type { AppLanguage, ChatMessage, RuntimeConnectionUpdate } from '../../types';

export type QuickInputState = { label: string; state: 'error' | 'waiting' | 'working' | 'idle'; icon: 'alert' | 'working' | 'complete' | 'chat'; hasActivity: boolean };
export function quickInputState({ language, messages, sending, stopping, submitting, waiting, error, recovery, queued = 0 }: {
  language: AppLanguage; messages: ChatMessage[]; sending: boolean; stopping?: boolean; submitting?: boolean;
  waiting?: boolean; error?: string | null; recovery?: RuntimeConnectionUpdate | null; queued?: number;
}): QuickInputState {

  const latest = [...messages].reverse().find(message => message.role === 'assistant' || message.role === 'user');
  const recovering = recovery && ['retrying', 'syncing'].includes(recovery.state);
  const failed = Boolean(error || recovery?.state === 'failed' || (!sending && latest?.status === 'failed'));
  const busy = !failed && !waiting && Boolean(sending || submitting || stopping || recovering);
  const label = failed ? (uiText(language)('quickInputState.needsAttention'))
    : waiting ? (uiText(language)('quickInputState.waitingForYou'))
    : recovering ? (uiText(language)('quickInputState.reconnecting'))
    : stopping ? (uiText(language)('guidanceActivity.stopping'))
    : submitting ? (uiText(language)('quickInputState.sending'))
    : sending ? (uiText(language)('quickInputState.working'))
    : queued ? (uiText(language)('quickInputState.queued', { queued }))
    : latest?.status === 'stopped' ? (uiText(language)('automationPanel.stopped'))
    : latest?.role === 'assistant' ? (uiText(language)('quickInputState.replyReady'))
    : latest?.role === 'user' ? (uiText(language)('quickInputState.sent'))
    : (uiText(language)('app.currentConversation'));
  return { label, state: failed ? 'error' : waiting ? 'waiting' : busy ? 'working' : 'idle',
    icon: failed || waiting ? 'alert' : busy ? 'working' : latest?.role === 'assistant' ? 'complete' : 'chat',
    hasActivity: Boolean(latest || failed || waiting || busy || queued) };
}
