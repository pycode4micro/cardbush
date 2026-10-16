import type { AppLanguage, ChatMessage, RuntimeConnectionUpdate } from '../../types';

export type QuickInputState = { label: string; state: 'error' | 'waiting' | 'working' | 'idle'; icon: 'alert' | 'working' | 'complete' | 'chat'; hasActivity: boolean };
export function quickInputState({ language, messages, sending, stopping, submitting, waiting, error, recovery, queued = 0 }: {
  language: AppLanguage; messages: ChatMessage[]; sending: boolean; stopping?: boolean; submitting?: boolean;
  waiting?: boolean; error?: string | null; recovery?: RuntimeConnectionUpdate | null; queued?: number;
}): QuickInputState {
  const zh = language === 'zh';
  const latest = [...messages].reverse().find(message => message.role === 'assistant' || message.role === 'user');
  const recovering = recovery && ['retrying', 'syncing'].includes(recovery.state);
  const failed = Boolean(error || recovery?.state === 'failed' || (!sending && latest?.status === 'failed'));
  const busy = !failed && !waiting && Boolean(sending || submitting || stopping || recovering);
  const label = failed ? (zh ? '需要处理' : 'Needs attention')
    : waiting ? (zh ? '等待你的确认' : 'Waiting for you')
    : recovering ? (zh ? '正在恢复连接' : 'Reconnecting')
    : stopping ? (zh ? '正在停止' : 'Stopping')
    : submitting ? (zh ? '正在发送' : 'Sending')
    : sending ? (zh ? '正在处理' : 'Working')
    : queued ? (zh ? `已排队 · ${queued} 条` : `Queued · ${queued}`)
    : latest?.status === 'stopped' ? (zh ? '已停止' : 'Stopped')
    : latest?.role === 'assistant' ? (zh ? '已回复' : 'Reply ready')
    : latest?.role === 'user' ? (zh ? '已发送' : 'Sent')
    : (zh ? '当前会话' : 'Current conversation');
  return { label, state: failed ? 'error' : waiting ? 'waiting' : busy ? 'working' : 'idle',
    icon: failed || waiting ? 'alert' : busy ? 'working' : latest?.role === 'assistant' ? 'complete' : 'chat',
    hasActivity: Boolean(latest || failed || waiting || busy || queued) };
}
