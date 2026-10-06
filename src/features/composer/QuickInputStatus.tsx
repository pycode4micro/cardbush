import { useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, CheckCircle2, ChevronUp, LoaderCircle, MessageSquare } from 'lucide-react';
import type { AppLanguage, ChatMessage, RuntimeConnectionUpdate } from '../../types';
import { ComposerPortalContext } from './ComposerPortalContext';

/** The quick composer observes the same turn as the full conversation. */
export function QuickInputStatus({ language, messages, sending, stopping, submitting, waiting, error, recovery, queued = 0,
  sessionId, children, interaction }: {
  language: AppLanguage; messages: ChatMessage[]; sending: boolean; stopping?: boolean;
  submitting?: boolean; waiting?: boolean; error?: string | null;
  recovery?: RuntimeConnectionUpdate | null; queued?: number;
  sessionId: string; children: ReactNode; interaction?: ReactNode;
}) {
  const target = useContext(ComposerPortalContext);
  const [expanded, setExpanded] = useState(false);
  const [visited, setVisited] = useState(false);
  const scroller = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null);
  const following = useRef(true), panelId = useId();
  useEffect(() => { setExpanded(false); setVisited(false); following.current = true; }, [target, sessionId]);
  useEffect(() => { if (target && waiting) setExpanded(true); }, [target, waiting, sessionId]);
  useEffect(() => { if (expanded) setVisited(true); }, [expanded]);
  useLayoutEffect(() => {
    if (!expanded || !scroller.current || !content.current) return;
    const scroll = scroller.current;
    following.current = true;
    const follow = () => { if (following.current) scroll.scrollTop = scroll.scrollHeight; };
    follow();
    // Markdown and tool results can finish laying out after the streamed update.
    const observer = new ResizeObserver(follow);
    observer.observe(content.current);
    return () => observer.disconnect();
  }, [expanded, target, sessionId]);
  if (!target) return null;
  const zh = language === 'zh';
  const latest = [...messages].reverse().find(message => message.role === 'assistant' || message.role === 'user');
  const recovering = recovery && ['retrying', 'syncing'].includes(recovery.state);
  const failed = Boolean(error || recovery?.state === 'failed' || (!sending && latest?.status === 'failed'));
  const busy = !failed && !waiting && Boolean(sending || submitting || stopping || recovering);
  const label = failed ? (zh ? '需要处理' : 'Needs attention')
    : waiting ? (zh ? '等待你的处理' : 'Waiting for you')
    : recovering ? (zh ? '正在恢复连接' : 'Reconnecting')
    : stopping ? (zh ? '正在停止' : 'Stopping')
    : submitting ? (zh ? '正在发送' : 'Sending')
    : sending ? (zh ? '正在处理' : 'Working')
    : queued ? (zh ? `已排队 · ${queued} 条` : `Queued · ${queued}`)
    : latest?.status === 'stopped' ? (zh ? '已停止' : 'Stopped')
    : latest?.role === 'assistant' ? (zh ? '已回复' : 'Reply ready')
    : latest?.role === 'user' ? (zh ? '已发送' : 'Sent')
    : (zh ? '当前会话' : 'Current conversation');
  const Icon = failed || waiting ? AlertCircle : busy ? LoaderCircle : latest?.role === 'assistant' ? CheckCircle2 : MessageSquare;
  return createPortal(<section className="quick-input-conversation" data-expanded={expanded}>
    <button type="button" className="quick-input-status" data-state={failed ? 'error' : waiting ? 'waiting' : busy ? 'working' : 'idle'}
      onClick={() => setExpanded(value => !value)} aria-expanded={expanded} aria-controls={panelId}
      aria-label={`${label} · ${expanded ? (zh ? '收起简要会话' : 'Collapse conversation preview') : (zh ? '展开简要会话，查看执行情况和回复' : 'Expand conversation preview to view progress and replies')}`}>
    <Icon size={16} aria-hidden="true"/><span role="status" aria-live="polite">{label}</span>
    <span className="quick-input-status-action">{expanded ? (zh ? '收起会话' : 'Collapse') : (zh ? '展开会话' : 'Expand')}<ChevronUp size={15}/></span>
    </button>
    <div id={panelId} ref={scroller} className="quick-input-transcript" hidden={!expanded} role="region" tabIndex={0}
      aria-label={zh ? '简要会话' : 'Conversation preview'}
      onScroll={event => { const node = event.currentTarget; following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 36; }}>
      {(expanded || visited) && <div ref={content} className="quick-input-transcript-content">
        {children}
        {!messages.length && !sending && <p className="quick-input-empty">{zh ? '发送消息后，可在这里查看执行情况和回复。' : 'Progress and replies will appear here after you send a message.'}</p>}
        {error && <p className="quick-input-error" role="alert">{error}</p>}
        {interaction}
      </div>}
    </div>
  </section>, target);
}
