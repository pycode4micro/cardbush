import { uiText } from '../../i18n';
import { prefersReducedMotion } from '../../shared/motionPreference';
import { useContext } from 'react';
import { ConversationHostContext } from '../conversationHost';
import { ArrowUpRight, Check, Copy, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  memo,
  type CSSProperties,
} from 'react';

import type { AppLanguage, ChatMessage } from '../../types';
import { fetchSessionTurnMessages } from '../../backend/api';
import { MarkdownContent } from '../chatMessages/MessageBubble';
import { FileMemoScope } from '../chatMessages/FileMemoScope';
import { HoverPreview, useHoverPreview } from '../../components/HoverPreview';
import { conversationDisplayTitle } from '../../shared/conversationTitle';
import { contextTickWindow, indexContextTurns } from './quickContextIndex';

type SelectedTurn = {
  message: ChatMessage;
  serverMessageId?: string;
};

export const QuickContextRail = memo(function QuickContextRail({
  language,
  messages,
  sessionId = '',
  turnHistoryAvailable = false,
  hasEarlier = false,
  loadingEarlier = false,
  onLoadEarlier,
}: {
  language: AppLanguage;
  messages: ChatMessage[];
  sessionId?: string;
  turnHistoryAvailable?: boolean;
  hasEarlier?: boolean;
  loadingEarlier?: boolean;
  onLoadEarlier?: () => void | Promise<unknown>;
}) {
  const host = useContext(ConversationHostContext);
  const panelId = useId();
  const transcript = useMemo(() => indexContextTurns(messages), [messages]);
  const railTurns = transcript.turns;
  const userSignature = useMemo(() => railTurns.map(message => message.id).join('\0'), [railTurns]);
  const lastUserMessage = railTurns.at(-1);
  const [panelView, setPanelView] = useState<'closed' | 'detail'>('closed');
  const hoverPreview = useHoverPreview(panelView !== 'closed');
  const [selectedTurn, setSelectedTurn] = useState<SelectedTurn | null>(null);
  const [remoteTurnMessages, setRemoteTurnMessages] = useState<ChatMessage[] | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [railCapacity, setRailCapacity] = useState(72);
  const [railOffset, setRailOffset] = useState(0);
  const [visibleUserMessageId, setVisibleUserMessageId] = useState('');
  const railRef = useRef<HTMLElement>(null);
  const railHandleRef = useRef<HTMLDivElement>(null);
  const ticksRef = useRef<HTMLDivElement>(null);
  const tickStepRef = useRef(9);
  const browsingRef = useRef(false);
  const focusRequestRef = useRef<number | null>(null);
  const labelsRef = useRef(new WeakMap<ChatMessage, string>());
  const windowAnchorRef = useRef<{ id: string; index: number; offset: number } | null>(null);
  const layoutRef = useRef<{ session: string; current: string; signature: string } | null>(null);
  const pageRef = useRef({ hasEarlier, loadingEarlier, onLoadEarlier });
  pageRef.current = { hasEarlier, loadingEarlier, onLoadEarlier };
  const pagePendingRef = useRef<symbol | null>(null);
  const detailRequestRef = useRef<AbortController | null>(null);
  const currentRailIndex = transcript.positions.get(visibleUserMessageId) ?? railTurns.length - 1;
  const tickWindow = contextTickWindow(railTurns.length, railCapacity, railOffset, tickStepRef.current);
  const visibleRailTurns = railTurns.slice(tickWindow.start, tickWindow.end);
  const hasRailTurns = railTurns.length > 0;

  useLayoutEffect(() => {
    const rail = railRef.current;
    const handle = railHandleRef.current;
    const chatBody = rail?.closest<HTMLElement>('.chat-body');
    if (!rail || !handle || !chatBody) return undefined;
    const updateCapacity = () => {
      // Match the rail's actual visibility, including a docked work summary.
      // Reserve the same reading margin for the transcript and composer.
      if (getComputedStyle(handle).display !== 'none') {
        chatBody.style.setProperty('--chat-reading-gutter', 'max(56px, var(--chat-inline-gutter, 16px))');
      } else {
        chatBody.style.removeProperty('--chat-reading-gutter');
      }
      const availableHeight = Math.max(0, handle.clientHeight - 20);
      const step = parseFloat(getComputedStyle(handle).getPropertyValue('--context-tick-step')) || 9;
      tickStepRef.current = step;
      const nextCapacity = Math.max(2, Math.min(96, Math.floor(availableHeight / step)));
      setRailCapacity((current) => current === nextCapacity ? current : nextCapacity);
    };
    const resizeObserver = new ResizeObserver(updateCapacity);
    resizeObserver.observe(rail);
    resizeObserver.observe(handle);
    updateCapacity();
    return () => {
      resizeObserver.disconnect();
      chatBody.style.removeProperty('--chat-reading-gutter');
    };
  }, [hasRailTurns]);

  useEffect(() => {
    const ticks = ticksRef.current;
    if (!ticks) return;
    const wheel = (event: WheelEvent) => {
      if (!event.cancelable || event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey ||
        !Number.isFinite(event.deltaY) || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      event.stopPropagation();
      browsingRef.current = true;
      hoverPreview.close();
      const page = pageRef.current;
      if (event.deltaY < 0 && ticks.scrollTop <= tickStepRef.current * 2 && page.hasEarlier &&
        !page.loadingEarlier && !pagePendingRef.current && page.onLoadEarlier) {
        const token = Symbol(); pagePendingRef.current = token;
        void Promise.resolve().then(page.onLoadEarlier).catch(() => undefined).finally(() => {
          if (pagePendingRef.current === token) pagePendingRef.current = null;
        });
      }
    };
    ticks.addEventListener('wheel', wheel, { passive: true });
    return () => ticks.removeEventListener('wheel', wheel);
  }, [hasRailTurns, sessionId, hoverPreview.close]);

  const rememberWindow = useCallback(() => {
    const ticks = ticksRef.current;
    if (!ticks) return;
    const index = Math.max(0, Math.floor(ticks.scrollTop / tickStepRef.current));
    if (railTurns[index]) windowAnchorRef.current = { id: railTurns[index].id, index,
      offset: ticks.scrollTop - index * tickStepRef.current };
    setRailOffset(ticks.scrollTop);
  }, [railTurns]);

  useLayoutEffect(() => {
    const ticks = ticksRef.current;
    if (!ticks || !railTurns.length) return;
    const previous = layoutRef.current, anchor = windowAnchorRef.current;
    const current = railTurns[currentRailIndex]?.id ?? '';
    const step = tickStepRef.current;
    if (!previous || previous.session !== sessionId) {
      browsingRef.current = false;
      ticks.scrollTop = Math.max(0, currentRailIndex - railCapacity + 1) * step;
    } else {
      const newIndex = anchor ? transcript.positions.get(anchor.id) : undefined;
      if (newIndex !== undefined && anchor && newIndex !== anchor.index) {
        // Prepending a history page keeps the same tick under the pointer.
        ticks.scrollTop = newIndex * step + anchor.offset;
      } else {
        if (previous.current !== current && previous.signature === userSignature) browsingRef.current = false;
        if (!browsingRef.current) {
          const first = Math.floor(ticks.scrollTop / step);
          if (currentRailIndex < first) ticks.scrollTop = currentRailIndex * step;
          else if (currentRailIndex >= first + railCapacity) ticks.scrollTop = (currentRailIndex - railCapacity + 1) * step;
        }
      }
    }
    layoutRef.current = { session: sessionId, current, signature: userSignature };
    rememberWindow();
  }, [sessionId, currentRailIndex, userSignature, railCapacity]);

  useLayoutEffect(() => {
    const index = focusRequestRef.current;
    if (index === null) return;
    const button = ticksRef.current?.querySelector<HTMLButtonElement>(`[data-turn-index="${index}"]`);
    if (button) { focusRequestRef.current = null; button.focus({ preventScroll: true }); }
  }, [tickWindow.start, tickWindow.end, railCapacity]);

  useEffect(() => {
    const chatBody = railRef.current?.closest('.chat-body');
    const scroller = chatBody?.querySelector<HTMLElement>('.message-list');
    if (!scroller) {
      setVisibleUserMessageId(lastUserMessage?.id ?? '');
      return undefined;
    }

    // Message order changes with userSignature; scrolling only needs a few
    // positional reads, not a full-history scan on every animation frame.
    const userItems = Array.from(
      scroller.querySelectorAll<HTMLElement>('[data-message-role="user"]'),
    ).filter(item => transcript.positions.has(item.dataset.messageId ?? ''));
    let frame = 0;
    const updateVisibleTurn = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const scrollerRect = scroller.getBoundingClientRect();
        const readingAnchor =
          scrollerRect.top + Math.min(180, Math.max(72, scrollerRect.height * 0.28));
        let low = 0;
        let high = userItems.length - 1;
        while (low <= high) {
          const middle = (low + high) >>> 1;
          if (userItems[middle].getBoundingClientRect().top <= readingAnchor) low = middle + 1;
          else high = middle - 1;
        }
        const currentId = userItems[Math.max(0, high)]?.dataset.messageId ?? lastUserMessage?.id ?? '';
        setVisibleUserMessageId((current) => current === currentId ? current : currentId);
      });
    };

    const content = scroller.querySelector<HTMLElement>('.message-list-content');
    const resizeObserver = new ResizeObserver(updateVisibleTurn);
    resizeObserver.observe(scroller);
    if (content) resizeObserver.observe(content);
    scroller.addEventListener('scroll', updateVisibleTurn, { passive: true });
    window.addEventListener('resize', updateVisibleTurn);
    updateVisibleTurn();
    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      scroller.removeEventListener('scroll', updateVisibleTurn);
      window.removeEventListener('resize', updateVisibleTurn);
    };
  }, [lastUserMessage?.id, sessionId, userSignature]);

  const closePanel = useCallback(() => {
    detailRequestRef.current?.abort();
    detailRequestRef.current = null;
    setDetailLoading(false);
    setPanelView('closed');
    setSelectedTurn(null);
    setRemoteTurnMessages(null);
    setCopied(false);
  }, []);

  useEffect(closePanel, [closePanel, sessionId]);
  useEffect(hoverPreview.close, [hoverPreview.close, sessionId]);
  useEffect(() => { setVisibleUserMessageId(''); pagePendingRef.current = null; }, [sessionId]);
  useEffect(() => () => detailRequestRef.current?.abort(), []);

  useEffect(() => {
    if (panelView === 'closed') return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      if (!railRef.current?.contains(event.target as Node)) closePanel();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closePanel();
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [closePanel, panelView]);

  const hoveredMessage = hoverPreview.anchor
    ? transcript.byMessage.get(hoverPreview.anchor.dataset.turnMessageId ?? '') : undefined;
  const hoverMessages = hoveredMessage ? quickTurnPreviewMessages(transcript.messagesFor(hoveredMessage.id)) : [];
  const hoverUser = hoverMessages.find(message => message.role === 'user');
  const hoverAssistant = hoverMessages.find(message => message.role === 'assistant');
  const hoverContent = useLazyTurnPreview(sessionId, hoveredMessage, hoverUser, hoverAssistant);

  if (railTurns.length === 0) return null;

  const localSelectedTurnMessages = selectedTurn
    ? transcript.messagesFor(selectedTurn.message.id)
    : [];
  const selectedTurnMessages = remoteTurnMessages ?? localSelectedTurnMessages;
  const selectedSourceMessage = selectedTurn
    ? transcript.byMessage.get(selectedTurn.message.id) ?? transcript.byMessage.get(selectedTurn.serverMessageId ?? '') ?? null
    : null;
  const previewMessages = quickTurnPreviewMessages(selectedTurnMessages);
  const assistantReply = previewMessages
    .find((message) => message.role === 'assistant')
    ?.content.trim() ?? '';

  const selectTurn = (turn: SelectedTurn) => {
    detailRequestRef.current?.abort();
    detailRequestRef.current = null;
    setSelectedTurn(turn);
    setPanelView('detail');
    setCopied(false);
    setRemoteTurnMessages(null);
    if (!turnHistoryAvailable || !sessionId.trim() || !turn.serverMessageId) {
      setDetailLoading(false);
      return;
    }
    const controller = new AbortController();
    detailRequestRef.current = controller;
    setDetailLoading(true);
    void fetchSessionTurnMessages({
      sessionId: host?.sessionId ?? sessionId,
      messageId: turn.serverMessageId,
      signal: controller.signal,
    }, host?.runtime).then((turnMessages) => {
      if (controller.signal.aborted) return;
      setRemoteTurnMessages(turnMessages);
    }).catch(() => undefined).finally(() => {
      if (detailRequestRef.current !== controller) return;
      detailRequestRef.current = null;
      setDetailLoading(false);
    });
  };

  const copyAssistantReply = async () => {
    if (!assistantReply) return;
    await navigator.clipboard.writeText(assistantReply);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  const jumpToSelectedTurn = () => {
    if (!selectedSourceMessage) return;
    const scroller = railRef.current
      ?.closest('.chat-body')
      ?.querySelector<HTMLElement>('.message-list');
    const item = scroller?.querySelector<HTMLElement>(
      `[data-message-id="${selectorEscape(selectedSourceMessage.id)}"]`,
    );
    if (!scroller || !item) return;
    const scrollerRect = scroller.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    const readingAnchor = Math.min(180, Math.max(72, scroller.clientHeight * 0.22));
    const targetTop = Math.max(
      0,
      Math.min(
        scroller.scrollHeight - scroller.clientHeight,
        scroller.scrollTop + itemRect.top - scrollerRect.top - readingAnchor,
      ),
    );
    closePanel();
    window.requestAnimationFrame(() => {
      scroller.scrollTo({
        top: targetTop,
        behavior: prefersReducedMotion()
          ? 'auto'
          : 'smooth',
      });
    });
  };

  const selectRailTurn = (message: ChatMessage) => {
    selectTurn({
      message,
      serverMessageId: message.messageId ?? message.id,
    });
  };

  const focusTurn = (index: number) => {
    const ticks = ticksRef.current;
    if (!ticks) return;
    browsingRef.current = true;
    const first = Math.floor(ticks.scrollTop / tickStepRef.current);
    if (index < first) ticks.scrollTop = index * tickStepRef.current;
    else if (index >= first + railCapacity) ticks.scrollTop = (index - railCapacity + 1) * tickStepRef.current;
    const button = ticks.querySelector<HTMLButtonElement>(`[data-turn-index="${index}"]`);
    if (button) button.focus({ preventScroll: true }); else focusRequestRef.current = index;
    rememberWindow();
  };
  const turnLabel = (message: ChatMessage) => {
    let label = labelsRef.current.get(message);
    if (label === undefined) { label = compactText(message.content, 120); labelsRef.current.set(message, label); }
    return label;
  };

  return (
    <aside
      ref={railRef}
      className={`quick-context-rail${panelView !== 'closed' ? ' panel-open' : ''}`}
      aria-label={uiText(language)('quickContextRail.quickContext')}
    >
      <div ref={railHandleRef} className="quick-context-handle">
        <div
          ref={ticksRef}
          className="quick-context-ticks"
          style={{ '--context-visible-count': Math.min(railTurns.length, railCapacity) } as CSSProperties}
          data-loading={loadingEarlier} aria-busy={loadingEarlier}
          aria-label={uiText(language)('quickContextRail.quickContext')}
          aria-description={uiText(language)('quickContextRail.navigationHelp')}
          onScroll={() => { hoverPreview.close(); rememberWindow(); }}
          onKeyDown={event => {
            const offsets: Record<string, number> = { ArrowUp: -1, ArrowDown: 1, PageUp: -10, PageDown: 10 };
            const offset = offsets[event.key];
            if (offset !== undefined || event.key === 'Home' || event.key === 'End') {
              event.preventDefault();
              const index = Number((event.target as HTMLElement).closest<HTMLElement>('[data-turn-index]')?.dataset.turnIndex ?? tickWindow.first);
              focusTurn(event.key === 'Home' ? 0 : event.key === 'End' ? railTurns.length - 1
                : Math.max(0, Math.min(railTurns.length - 1, index + offset!)));
            } else if (event.key === 'Escape') hoverPreview.close();
          }}
        >
          <div className="quick-context-items" style={{ height: railTurns.length * tickStepRef.current + 20 }}>
          {visibleRailTurns.map((message, slot) => {
            const index = tickWindow.start + slot, isCurrentTurn = index === currentRailIndex;
            return (
              <button
                {...hoverPreview.triggerProps}
                key={message.id}
                type="button"
                data-turn-index={index}
                data-turn-message-id={message.id}
                style={{ top: index * tickStepRef.current + 10 }}
                className={`quick-context-tick${isCurrentTurn ? ' current' : ''}${hoveredMessage?.id === message.id ? ' previewing' : ''}`}
                aria-label={uiText(language)('quickContextRail.turnPosition', { number: index + 1, count: railTurns.length, title: turnLabel(message) })}
                aria-current={isCurrentTurn ? 'true' : undefined}
                aria-haspopup="dialog"
                aria-expanded={panelView === 'detail' && selectedTurn?.message.id === message.id}
                aria-controls={panelView === 'detail' && selectedTurn?.message.id === message.id ? panelId : undefined}
                aria-describedby={hoveredMessage?.id === message.id ? hoverPreview.id : undefined}
                onClick={() => { hoverPreview.close(); selectRailTurn(message); }}
              />
            );
          })}
          </div>
        </div>
      </div>
      <HoverPreview preview={hoverPreview} className="turn-hover-preview" boundarySelector=".chat-body">
        {hoveredMessage && (!hoverContent ? <div className="turn-hover-skeleton" role="status" aria-label={uiText(language)('common.loading')}>
          <span/><span/><span/><span/>
        </div> : <>
          <div className="hover-preview-title">
            <strong>{hoverContent.title}</strong>
          </div>
          <p className="turn-hover-preview-reply">{hoverContent.reply || (uiText(language)('quickContextRail.noReplyYet'))}</p>
        </>)}
      </HoverPreview>
      <div className="quick-context-popovers">
        {panelView !== 'closed' && (
          <section id={panelId} role="dialog" aria-labelledby={`${panelId}-title`} className={`quick-context-panel ${panelView}`}>
            <header>
              <strong id={`${panelId}-title`}>
                {uiText(language)('quickContextRail.conversationTurn')}
              </strong>
              <button
                type="button"
                className="quick-context-close"
                onClick={closePanel}
                aria-label={uiText(language)('common.close')}
              >
                <X size={14} />
              </button>
            </header>

            <div className="quick-context-turn">
              {detailLoading && <span className="quick-context-detail-loading" />}
              {previewMessages.map((message) => (
                <article className={`quick-context-message ${message.role}`} key={message.id}>
                  <div>
                    <small>{message.role === 'user' ? (uiText(language)('quickContextRail.you')) : 'CardBush'}</small>
                    <FileMemoScope sessionId={message.conversationId || sessionId} turnId={message.turnId}>
                      <MarkdownContent content={message.content} language={language} />
                    </FileMemoScope>
                  </div>
                </article>
              ))}
            </div>
            <footer>
              <button
                type="button"
                disabled={!selectedSourceMessage}
                onClick={jumpToSelectedTurn}
              >
                <ArrowUpRight size={14} />
                {uiText(language)('quickContextRail.jumpToTurn')}
              </button>
              <button
                type="button"
                disabled={!assistantReply}
                onClick={() => void copyAssistantReply()}
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
                {copied
                  ? uiText(language)('browserConnectionSettings.copied')
                  : uiText(language)('quickContextRail.copyAiReply')}
              </button>
            </footer>
          </section>
        )}
      </div>
    </aside>
  );
});

function selectorEscape(value: string) {
  return value.replace(/["\\]/g, '\\$&');
}

export function quickTurnPreviewMessages(messages: ChatMessage[]) {
  const user = messages.find((message) =>
    message.role === 'user' && !isTurnGuidanceMessage(message),
  );
  const assistant = messages.find((message) =>
    message.role === 'assistant' &&
    message.metadata?.transcript_kind === 'assistant_final' &&
    Boolean(message.content.trim()),
  ) ?? [...messages].reverse().find((message) =>
    message.role === 'assistant' && Boolean(message.content.trim()),
  );
  return [user, assistant].filter((message): message is ChatMessage => Boolean(message));
}

function isTurnGuidanceMessage(message: ChatMessage) {
  const metadata = message.metadata ?? {};
  return (
    metadata.turn_guidance === true ||
    metadata.turnGuidance === true ||
    String(metadata.name ?? '').trim() === 'turn_guidance'
  );
}

function compactText(value: string, limit: number) {
  const normalized = value.slice(0, 4000).replace(/\s+/g, ' ').trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized;
}

function turnHoverText(value: string) {
  // A bounded text excerpt avoids mounting another Markdown/media tree while
  // skimming ticks. Full rendering and historical loading belong to the click.
  return value.slice(0, 4000).split(/\r?\n/).map(line => conversationDisplayTitle(line)
    .replace(/^#{1,6}\s+/, '').replace(/^>\s*/, '').replace(/^[-*]\s+/, '• ')
    .replace(/\*\*|__|`/g, '')).filter(Boolean).join('\n').slice(0, 600);
}

type TurnPreview = { title: string; reply: string };
function useLazyTurnPreview(sessionId: string, anchor?: ChatMessage, user?: ChatMessage, assistant?: ChatMessage) {
  type Entry = { sessionId: string; anchor: ChatMessage; user?: ChatMessage; assistant?: ChatMessage; value: TurnPreview };
  const cache = useRef(new Map<string, Entry>());
  const scope = useRef(sessionId);
  const [loaded, setLoaded] = useState<Entry | null>(null);
  const latest = useRef({ sessionId, anchor, user, assistant });
  latest.current = { sessionId, anchor, user, assistant };
  const pending = useRef<(() => void) | null>(null);
  useEffect(() => () => pending.current?.(), [sessionId, anchor]);
  useEffect(() => {
    if (scope.current !== sessionId) { cache.current.clear(); scope.current = sessionId; }
    if (!anchor) { setLoaded(null); return; }
    const cached = cache.current.get(anchor.id);
    if (cached?.anchor === anchor && cached.user === user && cached.assistant === assistant) {
      pending.current?.();
      cache.current.delete(anchor.id); cache.current.set(anchor.id, cached); setLoaded(cached); return;
    }
    if (pending.current) return;
    setLoaded(value => value?.sessionId === sessionId && value.anchor === anchor ? value : null);
    let cancelled = false, idle = 0, timer = 0;
    const read = () => {
      if (cancelled) return;
      if (pending.current === cancel) pending.current = null;
      const source = latest.current;
      if (source.sessionId !== sessionId || source.anchor !== anchor) return;
      const entry: Entry = { ...source, anchor, value: {
        title: compactText(conversationDisplayTitle((source.user ?? anchor).content.slice(0, 4000)), 160),
        reply: turnHoverText(source.assistant?.content ?? ''),
      } };
      cache.current.delete(anchor.id); cache.current.set(anchor.id, entry);
      if (cache.current.size > 64) cache.current.delete(cache.current.keys().next().value!);
      setLoaded(entry);
    };
    // Paint the skeleton first. Only the hovered turn is read during idle time;
    // rapidly moving, scrolling or switching sessions cancels the pending work.
    const frame = requestAnimationFrame(() => {
      if (typeof requestIdleCallback === 'function') idle = requestIdleCallback(read, { timeout: 180 });
      else timer = window.setTimeout(read, 0);
    });
    const cancel = () => {
      cancelled = true; cancelAnimationFrame(frame); if (idle) cancelIdleCallback(idle); clearTimeout(timer);
      if (pending.current === cancel) pending.current = null;
    };
    pending.current = cancel;
  }, [sessionId, anchor, user, assistant]);
  return loaded?.sessionId === sessionId && loaded.anchor === anchor
    ? loaded.value : undefined;
}
