import { uiText } from '../../i18n';
import { useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, CheckCircle2, ChevronUp, LoaderCircle, MessageSquare } from 'lucide-react';
import type { AppLanguage, ChatMessage, RuntimeConnectionUpdate } from '../../types';
import { ComposerPortalContext } from './ComposerPortalContext';
import { quickInputState } from './quickInputState';

/** The quick composer observes the same turn as the full conversation. */
export function QuickInputStatus({ language, messages, sending, stopping, submitting, waiting, error, recovery, queued = 0,
  sessionId, children, interaction, expandOnError = false, errorContent }: {
  language: AppLanguage; messages: ChatMessage[]; sending: boolean; stopping?: boolean;
  submitting?: boolean; waiting?: boolean; error?: string | null;
  recovery?: RuntimeConnectionUpdate | null; queued?: number;
  sessionId: string; children: ReactNode; interaction?: ReactNode;
  expandOnError?: boolean;
  errorContent?: ReactNode;
}) {
  const target = useContext(ComposerPortalContext);
  const [expanded, setExpanded] = useState(false);
  const [visited, setVisited] = useState(false);
  const scroller = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null);
  const following = useRef(true), lastScrollTop = useRef(0), panelId = useId();
  useEffect(() => { setExpanded(false); setVisited(false); following.current = true; }, [target, sessionId]);
  useEffect(() => { if (target && waiting) setExpanded(true); }, [target, waiting, sessionId]);
  useEffect(() => { if (target && expandOnError && error) setExpanded(true); }, [target, expandOnError, error]);
  useEffect(() => { if (expanded) setVisited(true); }, [expanded]);
  useLayoutEffect(() => {
    if (!expanded || !scroller.current || !content.current) return;
    const scroll = scroller.current;
    following.current = true;
    const follow = () => {
      if (following.current) scroll.scrollTop = scroll.scrollHeight;
      lastScrollTop.current = scroll.scrollTop;
    };
    follow();
    // Markdown and tool results can finish laying out after the streamed update.
    const observer = new ResizeObserver(follow);
    observer.observe(content.current);
    return () => observer.disconnect();
  }, [expanded, target, sessionId]);
  // A queued scroll event from the previous layout can arrive after React adds
  // content but before ResizeObserver. Commit following before that event so
  // layout growth is not mistaken for a reader scrolling away from the bottom.
  useLayoutEffect(() => {
    const scroll = scroller.current;
    if (!expanded || !scroll) return;
    if (following.current) scroll.scrollTop = scroll.scrollHeight;
    lastScrollTop.current = scroll.scrollTop;
  });
  if (!target) return null;

  const { label, state, icon } = quickInputState({ language, messages, sending, stopping, submitting, waiting, error, recovery, queued });
  const Icon = { alert: AlertCircle, working: LoaderCircle, complete: CheckCircle2, chat: MessageSquare }[icon];
  return createPortal(<section className="quick-input-conversation" data-expanded={expanded}>
    <button type="button" className="quick-input-status" data-state={state}
      onClick={() => setExpanded(value => !value)} aria-expanded={expanded} aria-controls={panelId}
      aria-label={`${label} · ${expanded ? (uiText(language)('quickInputStatus.collapseConversationPreview')) : (uiText(language)('quickInputStatus.expandConversationPreviewToViewProgressAnd'))}`}>
    <Icon size={16} aria-hidden="true"/><span role="status" aria-live="polite">{label}</span>
    <span className="quick-input-status-action">{expanded ? (uiText(language)('quickInputStatus.collapse')) : (uiText(language)('quickInputStatus.expand'))}<ChevronUp size={15}/></span>
    </button>
    <div id={panelId} ref={scroller} className="quick-input-transcript" hidden={!expanded} role="region" tabIndex={0}
      aria-label={uiText(language)('quickInputStatus.conversationPreview')}
      onScroll={event => {
        const node = event.currentTarget;
        if (node.scrollHeight - node.scrollTop - node.clientHeight < 36) following.current = true;
        else if (node.scrollTop < lastScrollTop.current) following.current = false;
        lastScrollTop.current = node.scrollTop;
      }}>
      {(expanded || visited) && <div ref={content} className="quick-input-transcript-content">
        {children}
        {!messages.length && !sending && <p className="quick-input-empty">{uiText(language)('quickInputStatus.progressAndRepliesWillAppearHereAfter')}</p>}
        {error && (errorContent ?? <p className="quick-input-error" role="alert">{error}</p>)}
        {interaction}
      </div>}
    </div>
  </section>, target);
}
