import {
  ArrowDown,
  ArrowUp,
  GitFork,
  Lock,
  Minus,
  Octagon,
  Square,
  X,
} from 'lucide-react';
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  closeShadowConversation,
  createShadowConversation,
  fetchSessionMessages,
  recordAssistantLogicFeedback,
  streamShadowConversationMessage,
  updateShadowConversationMode,
  type ShadowConversationRecord,
} from './backend/api';
import {
  MessageBubble,
  MessageFileReferenceScope,
  projectRenderableChatMessages,
} from './features/chatMessages';
import { normalizeChatMessagesForDisplay } from './hooks/useCardbushChat';
import { ShadowCloneIcon } from './components/ShadowCloneIcon';
import {
  themeBackgroundColor,
  themeClassNames,
} from './features/appearance/themeRuntime';
import type { ChatMessage, ThemeMode } from './types';

type ShadowMode = 'readonly' | 'fork';
export type ShadowConversationContext = Awaited<
  ReturnType<NonNullable<Window['cardbushDesktop']>['shadowWindowContext']>
>;

type ShadowWindowProps = {
  context?: ShadowConversationContext;
  embedded?: boolean;
  onClose?: () => void;
};

function historyThroughTurn(messages: ChatMessage[], sourceTurnId: string) {
  if (!sourceTurnId) return messages;
  let lastIndex = -1;
  messages.forEach((message, index) => {
    if (message.turnId === sourceTurnId) lastIndex = index;
  });
  return lastIndex >= 0 ? messages.slice(0, lastIndex + 1) : messages;
}

const ignoreAsync = async () => undefined;
const shadowScrollBottomTolerance = 42;

function shadowTranscriptIsAtBottom(target: HTMLElement) {
  return target.scrollHeight - target.clientHeight - target.scrollTop <=
    shadowScrollBottomTolerance;
}

export function ShadowWindow({
  context: providedContext,
  embedded = false,
  onClose,
}: ShadowWindowProps = {}) {
  const [context, setContext] = useState<ShadowConversationContext | null>(
    providedContext ?? null,
  );
  const [mode, setMode] = useState<ShadowMode>('readonly');
  const [conversation, setConversation] = useState<ShadowConversationRecord | null>(null);
  const [sourceMessages, setSourceMessages] = useState<ChatMessage[]>([]);
  const [shadowMessages, setShadowMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [activeAssistantMessageId, setActiveAssistantMessageId] = useState('');
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const [modeSwitching, setModeSwitching] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [error, setError] = useState('');
  const [maximized, setMaximized] = useState(false);
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const conversationRef = useRef<ShadowConversationRecord | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const modeSwitchingRef = useRef(false);
  const initializationGenerationRef = useRef(0);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const autoFollowTranscriptRef = useRef(true);

  const closeRuntimeConversation = useCallback(async () => {
    const current = conversationRef.current;
    conversationRef.current = null;
    setConversation(null);
    if (current) await closeShadowConversation(current.id).catch(() => undefined);
  }, []);

  const requestClose = useCallback(async () => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    abortRef.current?.abort();
    abortRef.current = null;
    await closeRuntimeConversation();
    if (embedded) onClose?.();
    else await window.cardbushDesktop?.closeShadowWindow?.();
  }, [closeRuntimeConversation, embedded, onClose]);

  useEffect(() => {
    if (providedContext) {
      setContext(providedContext);
      setMode(providedContext.initialMode);
      return undefined;
    }
    const desktop = window.cardbushDesktop;
    let active = true;
    if (!desktop?.shadowWindowContext) {
      setError('Shadow window bridge is unavailable.');
      setInitializing(false);
      return undefined;
    }
    void desktop.shadowWindowContext().then((payload) => {
      if (!active) return;
      setContext(payload);
      setMode(payload.initialMode);
      const background = themeBackgroundColor(payload.theme);
      document.documentElement.dataset.startTheme = payload.theme;
      document.documentElement.lang = payload.language === 'zh' ? 'zh-CN' : 'en';
      document.documentElement.style.backgroundColor = background;
      document.documentElement.style.setProperty('--cardbush-window-bg', background);
      document.documentElement.style.setProperty('--shadow-accent', payload.accentColor);
      for (const [name, value] of Object.entries(payload.themeVariables ?? {})) {
        document.documentElement.style.setProperty(name, value);
      }
      document.body.style.backgroundColor = background;
      document.getElementById('root')?.style.setProperty('background', background);
      void desktop.isShadowWindowMaximized?.().then((value) => {
        if (active) setMaximized(value);
      });
    }).catch((reason) => {
      if (active) {
        setError(reason instanceof Error ? reason.message : String(reason));
        setInitializing(false);
      }
    });
    const offClose = desktop.onShadowCloseRequest?.(() => void requestClose());
    const onResize = () => {
      void desktop.isShadowWindowMaximized?.().then(setMaximized).catch(() => undefined);
    };
    window.addEventListener('resize', onResize);
    return () => {
      active = false;
      offClose?.();
      window.removeEventListener('resize', onResize);
    };
  }, [providedContext, requestClose]);

  const initializeConversation = useCallback(async (payload: ShadowConversationContext) => {
    const generation = ++initializationGenerationRef.current;
    abortRef.current?.abort();
    abortRef.current = null;
    busyRef.current = false;
    setBusy(false);
    setActiveAssistantMessageId('');
    autoFollowTranscriptRef.current = true;
    setShowScrollBottom(false);
    setInitializing(true);
    setError('');
    try {
      const next = await createShadowConversation({
        sessionId: payload.sessionId,
        sourceTurnId: payload.sourceTurnId,
        clientConversationId: crypto.randomUUID(),
        mode: payload.initialMode,
      });
      if (generation !== initializationGenerationRef.current) {
        await closeShadowConversation(next.id).catch(() => undefined);
        return;
      }
      conversationRef.current = next;
      setConversation(next);
      setMode(next.mode);
      const history = await fetchSessionMessages(payload.sessionId, {
        includeSuperseded: false,
      });
      if (generation !== initializationGenerationRef.current) return;
      setSourceMessages(historyThroughTurn(history.messages, next.sourceTurnId));
    } catch (reason) {
      if (generation === initializationGenerationRef.current) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (generation === initializationGenerationRef.current) setInitializing(false);
    }
  }, []);

  useEffect(() => {
    if (context) void initializeConversation(context);
  }, [context, initializeConversation]);

  useEffect(() => () => {
    initializationGenerationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    busyRef.current = false;
    const current = conversationRef.current;
    conversationRef.current = null;
    if (current) void closeShadowConversation(current.id).catch(() => undefined);
  }, []);

  const syncTranscriptScrollState = useCallback((target: HTMLDivElement) => {
    const atBottom = shadowTranscriptIsAtBottom(target);
    autoFollowTranscriptRef.current = atBottom;
    setShowScrollBottom(
      !atBottom && target.scrollHeight > target.clientHeight + 1,
    );
  }, []);

  const scrollTranscriptToBottom = useCallback(() => {
    const target = transcriptRef.current;
    if (!target) return;
    autoFollowTranscriptRef.current = true;
    setShowScrollBottom(false);
    target.scrollTop = target.scrollHeight;
    window.requestAnimationFrame(() => {
      if (transcriptRef.current === target) {
        target.scrollTop = target.scrollHeight;
      }
    });
  }, []);

  useEffect(() => {
    const target = transcriptRef.current;
    if (!target) return undefined;
    const frame = window.requestAnimationFrame(() => {
      if (autoFollowTranscriptRef.current) {
        target.scrollTop = target.scrollHeight;
      }
      setShowScrollBottom(
        !shadowTranscriptIsAtBottom(target) &&
          target.scrollHeight > target.clientHeight + 1,
      );
    });
    return () => window.cancelAnimationFrame(frame);
  }, [busy, shadowMessages, sourceMessages]);

  useEffect(() => {
    const target = transcriptRef.current;
    const content = target?.querySelector('.shadow-window-transcript-content');
    if (!target || !(content instanceof HTMLElement)) return undefined;
    const observer = new ResizeObserver(() => {
      if (autoFollowTranscriptRef.current) {
        target.scrollTop = target.scrollHeight;
      }
      setShowScrollBottom(
        !shadowTranscriptIsAtBottom(target) &&
          target.scrollHeight > target.clientHeight + 1,
      );
    });
    observer.observe(target);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  const switchMode = useCallback(async (nextMode: ShadowMode) => {
    const current = conversationRef.current;
    if (
      !current || nextMode === current.mode || busyRef.current || initializing ||
      modeSwitchingRef.current
    ) return;
    const previousMode = current.mode;
    modeSwitchingRef.current = true;
    setModeSwitching(true);
    setError('');
    setMode(nextMode);
    try {
      const updated = await updateShadowConversationMode(current.id, nextMode);
      if (conversationRef.current?.id !== current.id) return;
      conversationRef.current = updated;
      setConversation(updated);
      setMode(updated.mode);
    } catch (reason) {
      if (conversationRef.current?.id === current.id) {
        setMode(previousMode);
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      modeSwitchingRef.current = false;
      setModeSwitching(false);
    }
  }, [initializing]);

  const send = useCallback(async () => {
    const content = draft.trim();
    const current = conversationRef.current;
    if (
      !context || !current || !content || busyRef.current || initializing ||
      modeSwitchingRef.current
    ) return;
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content,
      conversationId: current.id,
      createdAt: new Date().toISOString(),
    };
    const assistantId = crypto.randomUUID();
    setShadowMessages((messages) => [
      ...messages,
      userMessage,
      {
        id: assistantId,
        role: 'assistant',
        content: '',
        conversationId: current.id,
        createdAt: new Date().toISOString(),
      },
    ]);
    setDraft('');
    setError('');
    setActiveAssistantMessageId(assistantId);
    autoFollowTranscriptRef.current = true;
    setShowScrollBottom(false);
    busyRef.current = true;
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await streamShadowConversationMessage({
        conversationId: current.id,
        content,
        clientMessageId: userMessage.id,
        modelConfig: context.modelConfig,
        reasoningLevel: context.reasoningLevel,
        projectDir: current.workspaceDir || context.projectDir,
        signal: controller.signal,
        onDelta: (delta) => {
          if (conversationRef.current?.id !== current.id) return;
          setShadowMessages((messages) => messages.map((message) =>
            message.id === assistantId
              ? { ...message, content: `${message.content}${delta}` }
              : message
          ));
        },
        onDone: (message) => {
          if (conversationRef.current?.id !== current.id) return;
          setShadowMessages((messages) => messages.map((entry) =>
            entry.id === assistantId
              ? { ...entry, content: message.content || entry.content, createdAt: message.createdAt }
              : entry
          ));
        },
      });
    } catch (reason) {
      if (!controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      busyRef.current = false;
      setBusy(false);
      setActiveAssistantMessageId((current) => current === assistantId ? '' : current);
    }
  }, [context, draft, initializing]);

  const stop = () => {
    abortRef.current?.abort();
  };
  const language = context?.language ?? 'zh';
  const renderedSourceMessages = useMemo(
    () => projectRenderableChatMessages(normalizeChatMessagesForDisplay(sourceMessages)),
    [sourceMessages],
  );
  const renderedShadowMessages = useMemo(
    () => projectRenderableChatMessages(normalizeChatMessagesForDisplay(shadowMessages)),
    [shadowMessages],
  );
  const allMessages = useMemo(
    () => [...renderedSourceMessages, ...renderedShadowMessages],
    [renderedShadowMessages, renderedSourceMessages],
  );

  return (
    <main
      className={`app ${themeClassNames(context?.theme ?? 'dark')} shadow-window-shell shadow-mode-${mode}${embedded ? ' shadow-inspector-shell' : ''}`}
      style={context
        ? {
            ...context.themeVariables,
            '--shadow-accent': context.accentColor,
          } as CSSProperties
        : undefined}
    >
      <header className={`shadow-window-titlebar${embedded ? ' shadow-inspector-titlebar' : ''}`}>
        <div className={`shadow-window-title${embedded ? '' : ' window-drag'}`}>
          <ShadowCloneIcon size={15} />
          <strong>{context ? `Shadow · ${context.title}` : 'Shadow'}</strong>
        </div>
        <div className={`shadow-window-mode-switch mode-${mode}`} role="group" aria-label="Shadow mode">
          <span className="shadow-window-mode-indicator" aria-hidden="true" />
          <button
            type="button"
            className={mode === 'readonly' ? 'active' : ''}
            disabled={busy || initializing || modeSwitching}
            onClick={() => void switchMode('readonly')}
            title={language === 'zh' ? '只读分析，不允许修改' : 'Analysis only; no changes'}
          >
            <Lock size={13} />
            {language === 'zh' ? '只读' : 'Read only'}
          </button>
          <button
            type="button"
            className={mode === 'fork' ? 'active' : ''}
            disabled={busy || initializing || modeSwitching}
            onClick={() => void switchMode('fork')}
            title={language === 'zh' ? '复用子 Agent 安全边界；有项目时可修改工作区' : 'Child-Agent safety boundary; can change an attached project workspace'}
          >
            <GitFork size={13} />
            Fork
          </button>
        </div>
        {!embedded && (
          <div className="shadow-window-caption-actions">
            <button type="button" onClick={() => window.cardbushDesktop?.minimizeShadowWindow?.()} aria-label="Minimize">
              <Minus size={15} />
            </button>
            <button type="button" onClick={() => void window.cardbushDesktop?.toggleMaximizeShadowWindow?.()} aria-label="Maximize">
              <Square size={maximized ? 12 : 13} />
            </button>
            <button type="button" className="close" onClick={() => void requestClose()} aria-label="Close">
              <X size={15} />
            </button>
          </div>
        )}
      </header>

      <section className="shadow-window-context-bar">
        <span>{mode === 'readonly'
          ? (language === 'zh' ? '冻结历史 · 只读分析' : 'Frozen history · analysis only')
          : (language === 'zh' ? '冻结历史 · 子 Agent 修改边界 · 无 Subagent 能力' : 'Frozen history · child mutation boundary · no Subagent')}</span>
      </section>

      <div className="shadow-window-transcript-frame">
        <div
          className="shadow-window-transcript message-list"
          ref={transcriptRef}
          aria-busy={busy || initializing}
          onScroll={(event) => syncTranscriptScrollState(event.currentTarget)}
        >
          <MessageFileReferenceScope workspaceRoot={conversation?.workspaceDir || context?.projectDir}>
            <div className="shadow-window-transcript-content message-list-content">
              {allMessages.map((message, index) => (
                <div
                  className={`shadow-window-message message-list-item${index === 0 ? ' first' : ''}${index < renderedSourceMessages.length ? ' source' : ' shadow'}`}
                  key={`${message.conversationId ?? 'source'}:${message.id}`}
                >
                  {index === renderedSourceMessages.length && renderedSourceMessages.length > 0 && (
                    <div className="shadow-window-history-divider">
                      <span>{language === 'zh' ? 'Shadow 对话' : 'Shadow conversation'}</span>
                    </div>
                  )}
                  <MessageBubble
                    message={message}
                    language={language}
                    sending={busy}
                    activeTurnId=""
                    activeAssistantMessageId={activeAssistantMessageId}
                    selectedModel={context?.modelConfig.modelName ?? ''}
                    onRegenerate={ignoreAsync}
                    onEditUserMessage={ignoreAsync}
                    onRetryMessage={ignoreAsync}
                    onRetryGuidance={ignoreAsync}
                    onRevertChangeReport={ignoreAsync}
                    onOpenScene={() => undefined}
                    onAssistantFeedback={recordAssistantLogicFeedback}
                  />
                </div>
              ))}
              {initializing && <div className="shadow-window-loading">{language === 'zh' ? '正在冻结会话历史…' : 'Freezing conversation history…'}</div>}
              {error && <div className="shadow-window-error">{error}</div>}
            </div>
          </MessageFileReferenceScope>
        </div>
        <button
          className={`scroll-bottom shadow-window-scroll-bottom${showScrollBottom ? '' : ' hidden'}`}
          type="button"
          aria-label={language === 'zh' ? '回到底部' : 'Scroll to bottom'}
          aria-hidden={!showScrollBottom}
          tabIndex={showScrollBottom ? 0 : -1}
          onClick={scrollTranscriptToBottom}
        >
          <ArrowDown size={16} strokeWidth={1.8} />
        </button>
      </div>

      <footer className="shadow-window-composer composer-surface">
        <textarea
          value={draft}
          disabled={!conversation || initializing || closing}
          placeholder={mode === 'readonly'
            ? (language === 'zh' ? '询问这段会话，不会修改工作区' : 'Ask about this conversation without changing the workspace')
            : (language === 'zh' ? '在 Fork 中继续，可修改工作区' : 'Continue in the Fork with workspace changes')}
          rows={1}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <div className="shadow-window-composer-footer composer-footer">
          <span>{context?.modelConfig.modelName ?? ''}</span>
          {busy ? (
            <button type="button" className="shadow-window-send send-button stop" onClick={stop} aria-label="Stop">
              <Octagon size={15} fill="currentColor" />
            </button>
          ) : (
            <button type="button" className="shadow-window-send send-button" disabled={!draft.trim() || !conversation || initializing || modeSwitching} onClick={() => void send()} aria-label="Send">
              <ArrowUp size={17} />
            </button>
          )}
        </div>
      </footer>
    </main>
  );
}
