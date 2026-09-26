import { useContext } from 'react';
import { ConversationHostContext } from '../conversationHost';
import { ArrowUpRight, Check, Copy, X } from 'lucide-react';
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type { AppLanguage, ChatMessage } from '../../types';
import { fetchSessionTurnMessages } from '../../backend/api';
import { MarkdownContent } from '../chatMessages/MessageBubble';
import { FileMemoScope } from '../chatMessages/FileMemoScope';

type SelectedTurn = {
  message: ChatMessage;
  messageIndex: number;
  serverMessageId?: string;
};

export function QuickContextRail({
  language,
  messages,
  sessionId = '',
  turnHistoryAvailable = false,
}: {
  language: AppLanguage;
  messages: ChatMessage[];
  sessionId?: string;
  turnHistoryAvailable?: boolean;
}) {
  const host = useContext(ConversationHostContext);
  const userSignature = useMemo(
    () => messages
      .filter((message) => message.role === 'user')
      .map((message) => `${message.id}:${message.content.length}:${fastTextFingerprint(message.content)}`)
      .join('|'),
    [messages],
  );
  const lastUserMessage = useMemo(
    () => [...messages].reverse().find((message) => message.role === 'user') ?? null,
    [userSignature],
  );
  const [panelView, setPanelView] = useState<'closed' | 'detail'>('closed');
  const [selectedTurn, setSelectedTurn] = useState<SelectedTurn | null>(null);
  const [remoteTurnMessages, setRemoteTurnMessages] = useState<ChatMessage[] | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [railCapacity, setRailCapacity] = useState(72);
  const [railWindowStart, setRailWindowStart] = useState(0);
  const [hoveredTurnPreview, setHoveredTurnPreview] = useState<{
    messageId: string;
    top: number;
  } | null>(null);
  const [visibleUserMessageId, setVisibleUserMessageId] = useState('');
  const railRef = useRef<HTMLElement>(null);
  const railHandleRef = useRef<HTMLDivElement>(null);
  const detailRequestRef = useRef<AbortController | null>(null);
  const railTurns = useMemo(
    () => messages.filter((message) => message.role === 'user'),
    [userSignature],
  );
  const hoveredTurn = hoveredTurnPreview
    ? railTurns.find((message) => message.id === hoveredTurnPreview.messageId) ?? null
    : null;
  const currentRailIndex = railTurns.findIndex((message) => message.id === (
    visibleUserMessageId || lastUserMessage?.id
  ));
  const maxRailWindowStart = Math.max(0, railTurns.length - railCapacity);
  const visibleRailTurns = railTurns.slice(
    Math.min(railWindowStart, maxRailWindowStart),
    Math.min(railWindowStart, maxRailWindowStart) + railCapacity,
  );
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
      const nextCapacity = Math.max(8, Math.min(96, Math.floor(availableHeight / 9)));
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
    setRailWindowStart((current) => {
      const maxStart = Math.max(0, railTurns.length - railCapacity);
      if (currentRailIndex < 0) return Math.min(current, maxStart);
      const edgeBuffer = Math.min(6, Math.floor(railCapacity * 0.12));
      if (currentRailIndex < current + edgeBuffer) {
        return Math.max(0, currentRailIndex - edgeBuffer);
      }
      if (currentRailIndex >= current + railCapacity - edgeBuffer) {
        return Math.min(maxStart, currentRailIndex - railCapacity + edgeBuffer + 1);
      }
      return Math.min(current, maxStart);
    });
  }, [currentRailIndex, railCapacity, railTurns.length]);

  const scrollRailWindow = (direction: number) => {
    if (railTurns.length <= railCapacity || direction === 0) return;
    const step = Math.max(1, Math.round(railCapacity * 0.08));
    setRailWindowStart((current) => Math.min(
      Math.max(0, railTurns.length - railCapacity),
      Math.max(0, current + Math.sign(direction) * step),
    ));
  };

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
    );
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

  if (railTurns.length === 0) return null;

  const localSelectedTurnMessages = selectedTurn
    ? turnMessagesFromTranscript(messages, selectedTurn.messageIndex)
    : [];
  const selectedTurnMessages = remoteTurnMessages ?? localSelectedTurnMessages;
  const selectedSourceMessage = selectedTurn
    ? messages.find((message) => (
      message.id === selectedTurn.message.id ||
      message.messageId === selectedTurn.message.id ||
      Boolean(selectedTurn.serverMessageId && (
        message.id === selectedTurn.serverMessageId ||
        message.messageId === selectedTurn.serverMessageId
      ))
    )) ?? null
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
        behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
          ? 'auto'
          : 'smooth',
      });
    });
  };

  const selectRailTurn = (message: ChatMessage) => {
    const messageIndex = messages.findIndex((item) => item.id === message.id);
    selectTurn({
      message,
      messageIndex: Math.max(0, messageIndex),
      serverMessageId: message.messageId ?? message.id,
    });
  };

  return (
    <aside
      ref={railRef}
      className={`quick-context-rail${panelView !== 'closed' ? ' panel-open' : ''}`}
      aria-label={language === 'zh' ? '快速上下文' : 'Quick context'}
    >
      <div ref={railHandleRef} className="quick-context-handle">
        <span
          className="quick-context-ticks"
          onWheel={(event) => {
            if (railTurns.length <= railCapacity) return;
            event.preventDefault();
            scrollRailWindow(event.deltaY);
          }}
        >
          {visibleRailTurns.map((message) => {
            const isCurrentTurn = message.id === (
              visibleUserMessageId || lastUserMessage?.id
            );
            return (
              <button
                key={message.id}
                type="button"
                className={`quick-context-tick${isCurrentTurn ? ' current' : ''}`}
                aria-current={isCurrentTurn ? 'true' : undefined}
                aria-label={compactText(message.content, 120)}
                onPointerEnter={(event) => {
                  const railRect = railRef.current?.getBoundingClientRect();
                  const tickRect = event.currentTarget.getBoundingClientRect();
                  if (!railRect) return;
                  setHoveredTurnPreview({
                    messageId: message.id,
                    top: tickRect.top + tickRect.height / 2 - railRect.top,
                  });
                }}
                onPointerLeave={() => setHoveredTurnPreview(null)}
                onFocus={(event) => {
                  const railRect = railRef.current?.getBoundingClientRect();
                  const tickRect = event.currentTarget.getBoundingClientRect();
                  if (!railRect) return;
                  setHoveredTurnPreview({
                    messageId: message.id,
                    top: tickRect.top + tickRect.height / 2 - railRect.top,
                  });
                }}
                onBlur={() => setHoveredTurnPreview(null)}
                onClick={() => {
                  setHoveredTurnPreview(null);
                  selectRailTurn(message);
                }}
              />
            );
          })}
        </span>
      </div>
      <div className="quick-context-popovers">
        {hoveredTurn && panelView === 'closed' && (
          <div
            className="quick-context-turn-preview"
            role="tooltip"
            style={{ '--quick-context-preview-top': `${hoveredTurnPreview?.top ?? 0}px` } as CSSProperties}
          >
            <small>{language === 'zh' ? '用户请求' : 'User request'}</small>
            <p>{hoveredTurn.content}</p>
          </div>
        )}
        {panelView !== 'closed' && (
          <section className={`quick-context-panel ${panelView}`}>
            <header>
              <strong>
                {language === 'zh' ? '本轮对话' : 'Conversation turn'}
              </strong>
              <button
                type="button"
                className="quick-context-close"
                onClick={closePanel}
                aria-label={language === 'zh' ? '关闭' : 'Close'}
              >
                <X size={14} />
              </button>
            </header>

            <div className="quick-context-turn">
              {detailLoading && <span className="quick-context-detail-loading" />}
              {previewMessages.map((message) => (
                <article className={`quick-context-message ${message.role}`} key={message.id}>
                  <div>
                    <small>{message.role === 'user' ? (language === 'zh' ? '你' : 'You') : 'CardBush'}</small>
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
                {language === 'zh' ? '跳转到该轮' : 'Jump to turn'}
              </button>
              <button
                type="button"
                disabled={!assistantReply}
                onClick={() => void copyAssistantReply()}
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
                {copied
                  ? language === 'zh' ? '已复制' : 'Copied'
                  : language === 'zh' ? '复制 AI 回复' : 'Copy AI reply'}
              </button>
            </footer>
          </section>
        )}
      </div>
    </aside>
  );
}

function findNextUserMessageIndex(messages: ChatMessage[], startIndex: number) {
  const nextIndex = messages.findIndex((message, index) => index >= startIndex && message.role === 'user');
  return nextIndex < 0 ? messages.length : nextIndex;
}

function selectorEscape(value: string) {
  return value.replace(/["\\]/g, '\\$&');
}

function turnMessagesFromTranscript(messages: ChatMessage[], anchorIndex: number) {
  const anchor = messages[anchorIndex];
  if (!anchor) return [];
  const turnId = anchor.turnId?.trim() ?? '';
  if (!turnId) {
    return messages.slice(
      anchorIndex,
      findNextUserMessageIndex(messages, anchorIndex + 1),
    );
  }
  return messages.slice(anchorIndex).filter((message) => message.turnId?.trim() === turnId);
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
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized;
}

function fastTextFingerprint(value: string) {
  let hash = 2166136261;
  const step = Math.max(1, Math.floor(value.length / 64));
  for (let index = 0; index < value.length; index += step) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
