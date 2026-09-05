import { ArrowLeft, ArrowUpRight, Check, ChevronRight, Copy, Search, X } from 'lucide-react';
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type { AppLanguage, ChatMessage } from '../../types';
import {
  fetchSessionTurnMessages,
  searchSessionContext,
} from '../../backend/api';
import { MarkdownContent } from '../chatMessages/MessageBubble';

type IndexedUserTurn = {
  message: ChatMessage;
  messageIndex: number;
  normalized: string;
  terms: Map<string, number>;
};

type ContextIndex = {
  turns: IndexedUserTurn[];
  documentFrequency: Map<string, number>;
};

type ContextMatch = IndexedUserTurn & {
  score: number;
  serverMessageId?: string;
};

const queryDelayMs = 900;
const maxTermsPerText = 420;

export function QuickContextRail({
  language,
  messages,
  draft,
  sessionId = '',
  serverSearchAvailable = false,
}: {
  language: AppLanguage;
  messages: ChatMessage[];
  draft: string;
  sessionId?: string;
  serverSearchAvailable?: boolean;
}) {
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
  const [index, setIndex] = useState<ContextIndex | null>(null);
  const [matches, setMatches] = useState<ContextMatch[]>([]);
  const [searching, setSearching] = useState(false);
  const [panelView, setPanelView] = useState<'closed' | 'list' | 'detail'>('closed');
  const [selectedMatch, setSelectedMatch] = useState<ContextMatch | null>(null);
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
  const matchedTurnIds = useMemo(
    () => new Set(matches.map((match) => match.message.id)),
    [matches],
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

  useEffect(() => {
    const handle = railHandleRef.current;
    if (!handle) return undefined;
    const updateCapacity = () => {
      const availableHeight = Math.max(0, handle.clientHeight - 20);
      const nextCapacity = Math.max(8, Math.min(96, Math.floor(availableHeight / 9)));
      setRailCapacity((current) => current === nextCapacity ? current : nextCapacity);
    };
    const resizeObserver = new ResizeObserver(updateCapacity);
    resizeObserver.observe(handle);
    updateCapacity();
    return () => resizeObserver.disconnect();
  }, []);

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

    let frame = 0;
    const updateVisibleTurn = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const scrollerRect = scroller.getBoundingClientRect();
        const readingAnchor =
          scrollerRect.top + Math.min(180, Math.max(72, scrollerRect.height * 0.28));
        const userItems = Array.from(
          scroller.querySelectorAll<HTMLElement>('[data-message-role="user"]'),
        );
        let currentId = userItems[0]?.dataset.messageId ?? lastUserMessage?.id ?? '';
        for (const item of userItems) {
          if (item.getBoundingClientRect().top > readingAnchor) break;
          currentId = item.dataset.messageId ?? currentId;
        }
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
  }, [lastUserMessage?.id, userSignature]);

  const query = draft.trim() || lastUserMessage?.content.trim() || '';
  const querySource: 'draft' | 'latest' = draft.trim() ? 'draft' : 'latest';
  useEffect(() => {
    let cancelled = false;
    setSearching(true);
    const cancelBuild = buildContextIndexLazily(messages, (nextIndex) => {
      if (cancelled) return;
      setIndex(nextIndex);
      setSearching(false);
    });
    return () => {
      cancelled = true;
      cancelBuild();
    };
  }, [userSignature]);

  useEffect(() => {
    if (query.length < 2 || (!serverSearchAvailable && (!index || index.turns.length < 2))) {
      setMatches([]);
      setSearching(false);
      return undefined;
    }
    const controller = new AbortController();
    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      if (serverSearchAvailable && sessionId.trim()) {
        void searchSessionContext({
          sessionId,
          query,
          limit: 8,
          roles: ['user'],
          excludeMessageIds: querySource === 'latest' && lastUserMessage?.id
            ? [lastUserMessage.messageId ?? lastUserMessage.id]
            : undefined,
          requestId: typeof crypto !== 'undefined' && 'randomUUID' in crypto
            ? crypto.randomUUID()
            : `context-${Date.now()}`,
          signal: controller.signal,
        }).then((result) => {
          if (cancelled) return;
          setMatches(result.items.map((item, resultIndex) => {
            const messageIndex = messages.findIndex((message) => (
              message.id === item.messageId || message.messageId === item.messageId
            ));
            return {
              message: {
                id: item.messageId,
                messageId: item.messageId,
                role: item.role,
                content: item.snippet,
                conversationId: sessionId,
                turnId: item.turnId,
                createdAt: item.createdAt,
              },
              messageIndex: messageIndex >= 0 ? messageIndex : resultIndex,
              normalized: normalizeSearchText(item.snippet),
              terms: termFrequency(item.snippet),
              score: item.score,
              serverMessageId: item.messageId,
            };
          }));
          setSearching(false);
        }).catch((error) => {
          if (cancelled || error instanceof DOMException && error.name === 'AbortError') return;
          setMatches(index ? searchContextIndex(
            index,
            query,
            querySource === 'latest' ? lastUserMessage?.id : undefined,
          ) : []);
          setSearching(false);
        });
        return;
      }
      const cancelIdle = scheduleIdle(() => {
        if (cancelled) return;
        setMatches(index ? searchContextIndex(
          index,
          query,
          querySource === 'latest' ? lastUserMessage?.id : undefined,
        ) : []);
        setSearching(false);
      });
      if (cancelled) cancelIdle();
    }, queryDelayMs);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [index, lastUserMessage?.id, messages, query, querySource, serverSearchAvailable, sessionId]);

  useEffect(() => {
    setSelectedMatch(null);
    setRemoteTurnMessages(null);
    setPanelView((current) => current === 'closed' ? current : 'list');
    setCopied(false);
  }, [query]);

  const closePanel = useCallback(() => {
    detailRequestRef.current?.abort();
    detailRequestRef.current = null;
    setDetailLoading(false);
    setPanelView('closed');
    setSelectedMatch(null);
    setCopied(false);
  }, []);

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

  if (!serverSearchAvailable && index && index.turns.length < 2) return null;
  if (!serverSearchAvailable && !index && !searching) return null;

  const localSelectedTurnMessages = selectedMatch
    ? turnMessagesFromTranscript(messages, selectedMatch.messageIndex)
    : [];
  const selectedTurnMessages = remoteTurnMessages ?? localSelectedTurnMessages;
  const selectedSourceMessage = selectedMatch
    ? messages.find((message) => (
      message.id === selectedMatch.message.id ||
      message.messageId === selectedMatch.message.id ||
      Boolean(selectedMatch.serverMessageId && (
        message.id === selectedMatch.serverMessageId ||
        message.messageId === selectedMatch.serverMessageId
      ))
    )) ?? null
    : null;
  const previewMessages = quickTurnPreviewMessages(selectedTurnMessages);
  const assistantReply = previewMessages
    .find((message) => message.role === 'assistant')
    ?.content.trim() ?? '';

  const selectMatch = (match: ContextMatch) => {
    detailRequestRef.current?.abort();
    detailRequestRef.current = null;
    setSelectedMatch(match);
    setPanelView('detail');
    setCopied(false);
    setRemoteTurnMessages(null);
    if (!serverSearchAvailable || !sessionId.trim() || !match.serverMessageId) {
      setDetailLoading(false);
      return;
    }
    const controller = new AbortController();
    detailRequestRef.current = controller;
    setDetailLoading(true);
    void fetchSessionTurnMessages({
      sessionId,
      messageId: match.serverMessageId,
      signal: controller.signal,
    }).then((turnMessages) => {
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
    selectMatch({
      message,
      messageIndex: Math.max(0, messageIndex),
      normalized: normalizeSearchText(message.content),
      terms: termFrequency(message.content),
      score: matches.find((match) => match.message.id === message.id)?.score ?? 0,
      serverMessageId: message.messageId ?? message.id,
    });
  };

  return (
    <aside
      ref={railRef}
      className={`quick-context-rail${searching ? ' searching' : ''}${panelView !== 'closed' ? ' panel-open' : ''}`}
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
            const isMatchedTurn =
              panelView !== 'closed' &&
              !isCurrentTurn &&
              matchedTurnIds.has(message.id);
            return (
              <button
                key={message.id}
                type="button"
                className={`quick-context-tick${isCurrentTurn ? ' current' : ''}${isMatchedTurn ? ' matched' : ''}`}
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
              {panelView === 'detail' ? (
                <button
                  type="button"
                  className="quick-context-back"
                  onClick={() => setPanelView('list')}
                  aria-label={language === 'zh' ? '返回请求列表' : 'Back to request list'}
                >
                  <ArrowLeft size={14} />
                </button>
              ) : <Search size={14} />}
              <strong>
                {panelView === 'detail'
                  ? language === 'zh' ? '本轮对话' : 'Conversation turn'
                  : language === 'zh' ? '相关请求' : 'Related requests'}
              </strong>
              <span className="quick-context-panel-meta">
                {panelView === 'list' && (searching
                  ? language === 'zh' ? '检索中' : 'Searching'
                  : `${matches.length}`)}
              </span>
              <button
                type="button"
                className="quick-context-close"
                onClick={closePanel}
                aria-label={language === 'zh' ? '关闭' : 'Close'}
              >
                <X size={14} />
              </button>
            </header>

            {panelView === 'list' ? (
              <div className="quick-context-request-list">
                <small className="quick-context-query-source">
                  {querySource === 'draft'
                    ? language === 'zh' ? '按当前输入匹配' : 'Matched to current draft'
                    : language === 'zh' ? '按上一条提问匹配' : 'Matched to latest prompt'}
                </small>
                {searching && matches.length === 0 && <span className="quick-context-list-loading" />}
                {!searching && matches.length === 0 && (
                  <p className="quick-context-empty">
                    {language === 'zh' ? '暂未找到相关历史请求' : 'No related request found'}
                  </p>
                )}
                {matches.map((match) => (
                  <button
                    key={match.message.id}
                    type="button"
                    className="quick-context-request"
                    onClick={() => selectMatch(match)}
                  >
                    <span>{compactText(match.message.content, 92)}</span>
                    <ChevronRight size={14} />
                  </button>
                ))}
              </div>
            ) : (
              <>
                <div className="quick-context-turn">
                  {detailLoading && <span className="quick-context-list-loading" />}
                  {previewMessages.map((message) => (
                    <article className={`quick-context-message ${message.role}`} key={message.id}>
                      <div>
                        <small>{message.role === 'user' ? (language === 'zh' ? '你' : 'You') : 'CardBush'}</small>
                        <MarkdownContent content={message.content} language={language} />
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
              </>
            )}
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

function buildContextIndexLazily(
  messages: ChatMessage[],
  onReady: (index: ContextIndex) => void,
) {
  const pendingTurns = messages
    .map((message, messageIndex) => ({ message, messageIndex }))
    .filter(({ message }) => message.role === 'user' && Boolean(message.content.trim()))
    .reverse();
  const turns: IndexedUserTurn[] = [];
  const documentFrequency = new Map<string, number>();
  let cursor = 0;
  let cancelled = false;
  let cancelIdle: () => void = () => {};

  const processChunk = () => {
    if (cancelled) return;
    const end = Math.min(pendingTurns.length, cursor + 80);
    for (; cursor < end; cursor += 1) {
      const source = pendingTurns[cursor];
      const turn: IndexedUserTurn = {
        ...source,
        normalized: normalizeSearchText(source.message.content),
        terms: termFrequency(source.message.content),
      };
      turns.push(turn);
      for (const term of turn.terms.keys()) {
        documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
      }
    }
    if (cursor === end && (cursor === pendingTurns.length || cursor === 80)) {
      onReady({
        turns: [...turns].sort((left, right) => left.messageIndex - right.messageIndex),
        documentFrequency: new Map(documentFrequency),
      });
    }
    if (cursor < pendingTurns.length) cancelIdle = scheduleIdle(processChunk);
  };

  cancelIdle = scheduleIdle(processChunk);
  return () => {
    cancelled = true;
    cancelIdle();
  };
}

function searchContextIndex(
  index: ContextIndex,
  rawQuery: string,
  excludedMessageId?: string,
): ContextMatch[] {
  const queryTerms = termFrequency(rawQuery);
  const queryNormalized = normalizeSearchText(rawQuery);
  if (queryTerms.size === 0) return [];
  const documentCount = Math.max(1, index.turns.length);
  const matches = index.turns.flatMap((turn) => {
    if (turn.message.id === excludedMessageId) return [];
    let weightedOverlap = 0;
    let totalQueryWeight = 0;
    for (const [term, queryCount] of queryTerms) {
      const frequency = index.documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (documentCount + 0.5) / (frequency + 0.5));
      totalQueryWeight += idf * queryCount;
      const turnCount = turn.terms.get(term) ?? 0;
      if (turnCount > 0) weightedOverlap += idf * Math.min(queryCount, turnCount);
    }
    const coverage = totalQueryWeight > 0 ? weightedOverlap / totalQueryWeight : 0;
    const phraseBoost = queryNormalized.length >= 6 && turn.normalized.includes(queryNormalized)
      ? 0.32
      : 0;
    const reverseBoost = turn.normalized.length >= 6 && queryNormalized.includes(turn.normalized)
      ? 0.16
      : 0;
    const score = coverage + phraseBoost + reverseBoost;
    return score >= 0.08 ? [{ ...turn, score }] : [];
  });
  return matches
    .sort((left, right) => right.score - left.score || right.messageIndex - left.messageIndex)
    .slice(0, 8);
}

function termFrequency(value: string) {
  const terms = searchableTerms(value);
  const frequencies = new Map<string, number>();
  for (const term of terms) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
  return frequencies;
}

function searchableTerms(value: string) {
  const normalized = normalizeSearchText(value);
  const terms: string[] = [];
  for (const token of normalized.match(/[a-z0-9_./:@-]{2,}/g) ?? []) terms.push(token);
  for (const sequence of normalized.match(/[\u3400-\u9fff]+/g) ?? []) {
    if (sequence.length === 1) terms.push(sequence);
    for (let index = 0; index < sequence.length - 1; index += 1) {
      terms.push(sequence.slice(index, index + 2));
    }
    for (let index = 0; index < sequence.length - 2; index += 2) {
      terms.push(sequence.slice(index, index + 3));
    }
  }
  return terms.slice(0, maxTermsPerText);
}

function normalizeSearchText(value: string) {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
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

function scheduleIdle(callback: () => void) {
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(callback, { timeout: 700 });
    return () => window.cancelIdleCallback(id);
  }
  const id = globalThis.setTimeout(callback, 32);
  return () => globalThis.clearTimeout(id);
}
