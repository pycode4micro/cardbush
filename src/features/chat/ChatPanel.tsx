import { ArrowDown, Sparkles } from 'lucide-react';
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type UIEvent,
  type WheelEvent,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { recordAssistantLogicFeedback, type ExperimentalGoal } from '../../backend/api';
import type { QueuedChatMessage } from '../../hooks/useCardbushChat';
import {
  normalizeChatMessagesForDisplay,
  normalizeActiveTurnTranscriptForDisplay,
} from '../chatMessages/transcript/messageProjection';
import { useSoftPanelPresence } from '../../hooks/useSoftPanelPresence';
import {
  MessageListFooter,
  absoluteBottomScrollTop,
  isMessageTailVisible,
  lastAssistantMessage,
  manualScrollDetachHoldMs,
  scrollBottomLockTolerance,
  scrollBottomWheelFreezeMs,
  scrollBottomWheelLockTolerance,
  streamingAssistantMessage,
  visualBottomScrollTop,
  type ScrollBottomMetrics,
} from '../chatScroll';
import {
  MessageBubble,
  MessageFileReferenceScope,
  projectRenderableChatMessages,
} from '../chatMessages';
import { QuickContextRail } from './QuickContextRail';
import { ConversationWorkSummary } from './ConversationWorkSummary';
import {
  ComposerRuntimePreTest,
  isComposerRuntimePreTestEnabled,
} from '../pre_test/ComposerRuntimePreTest';
import { isQuickContextPreTestEnabled, QuickContextPreTest } from '../pre_test/QuickContextPreTest';
import { isLoopHistoryPreTestEnabled, LoopHistoryPreTest } from '../pre_test/LoopHistoryPreTest';
import {
  isRuntimeStreamPreTestEnabled,
  runtimeStreamPreTestMode,
} from '../pre_test/runtimeStreamPreTestActivation';
import {
  Composer,
  LiveComposerRuntimeRail,
  quickPayloadText,
  type QuickLoadPayload,
} from '../composer';
import { summarizeChangeReports, type ConversationChangeReport } from '../tools';
import { goalToolUpdateFromExecution } from '../../shared/goalState';
import { CardlingSceneHost } from '../cardling/CardlingSceneHost';
import {
  cardlingSceneKey,
  cardlingSceneRevisionKey,
  latestCardlingSceneFromMessages,
  sceneAutoPlayEnabled,
  type CardlingScene,
} from '../cardling/scene';
import type {
  AppLanguage,
  AppSettingsState,
  ChatMessage,
  ManagedModelConfig,
  PermissionMode,
  SubagentPermissionRouting,
  ReasoningLevel,
  ReferencePlanMode,
  RuntimeContextWindowUsage,
  RuntimeConnectionUpdate,
  PendingInteraction,
  InteractionReplyAnswer,
  ProjectItem,
  SkillSummary,
  ThemeMode,
} from '../../types';
import { recordUiPerformanceMetric } from '../../shared/uiPerformanceTrace';
import { cssEscape } from '../../shared/cssEscape';
import {
  BackendLoading,
  RuntimeStatusBanner,
  ConversationConnectionNotice,
} from './ChatStatusViews';
import { WelcomeComposer } from './WelcomeComposer';
import { TopBar } from '../../components/TopBar';
import { InteractionCard } from '../interactions/InteractionCard';

const LazyRuntimeStreamPreTest = import.meta.env.DEV
  ? lazy(async () => {
      const module = await import('../pre_test/RuntimeStreamPreTest');
      return { default: module.RuntimeStreamPreTest };
    })
  : null;

type RefreshActiveSession = (options?: { silent?: boolean }) => Promise<void>;

function scrollDebug(label: string, data: Record<string, unknown>) {
  try {
    // Detailed scroll traces are intentionally session-scoped. A persisted
    // localStorage switch previously left synchronous IPC logging enabled in
    // ordinary GUI runs long after the original diagnosis had finished.
    if (window.sessionStorage.getItem('cardbush_scroll_debug') !== 'true') {
      return;
    }
  } catch {
    return;
  }
  const entry = {
    at: new Date().toISOString(),
    label,
    ...data,
  };
  const buffer = window.__cardbushScrollDebug ?? [];
  buffer.push(entry);
  if (buffer.length > 300) {
    buffer.splice(0, buffer.length - 300);
  }
  window.__cardbushScrollDebug = buffer;
  console.debug('[cardbush:scroll]', entry);
  void window.cardbushDesktop
    ?.writeDebugLog?.('scroll', {
      ...entry,
    })
    .catch(() => undefined);
}

function gentleAutoFollowScrollBehavior(): ScrollBehavior {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ? 'auto'
    : 'smooth';
}

export function ChatPanel({
  language,
  theme,
  title,
  onlyTalkMode,
  sidebarCollapsed,
  windowMaximized,
  onRevealSidebar,
  activeConversationId,
  activeProjectDir,
  projectPathAliases,
  selectedProjectDir,
  availableProjects,
  onWelcomeProjectChange,
  projectContext,
  messages,
  activeGoal,
  goalAvailable,
  goalCancelling,
  goalWaiting,
  changeReports,
  skills,
  disabledSkillNames,
  visualInputAvailable,
  visualInputEnabled,
  contextSearchAvailable,
  subagentObservabilityAvailable,
  shadowAvailable,
  shadowAccentColor,
  shadowThemeVariables,
  thinkingVisible,
  guidanceDeliveryMode,
  loading,
  historyLoading,
  sending,
  stopping,
  activeTurnId,
  connectionRecovery,
  queuedMessageCount,
  queuedMessagePreview,
  queuedMessages,
  pendingInteraction,
  error,
  notice,
  selectedModel,
  selectedModelConfig,
  contextWindowMaxTokens,
  contextWindowUsage,
  availableModels,
  referencePlanAvailable,
  referencePlanMode,
  permissionMode,
  subagentPermissionRouting,
  reasoningLevelAvailable,
  reasoningLevel,
  reasoningLevels,
  gitAvailable,
  onModelChange,
  onReferencePlanModeChange,
  onPermissionModeChange,
  onSubagentPermissionRoutingChange,
  onReasoningLevelChange,
  onConfigureModels,
  onCreateConversation,
  onSaveProjectContext,
  onToggleSkill,
  onVisualInputEnabledChange,
  onRefreshActiveSession,
  onSend,
  onRetryMessage,
  onRegenerate,
  onEditUserMessage,
  onGuideMessage,
  onRetryGuidance,
  onGuideQueuedMessage,
  onRemoveQueuedMessage,
  onReorderQueuedMessage,
  onRevertChangeReport,
  onOpenChangeReview,
  onReplyInteraction,
  onCancelInteraction,
  onCancelGoal,
  onCancel,
  onClearError,
  onClearNotice,
  draft,
  onDraftChange,
}: {
  language: AppLanguage;
  theme: ThemeMode;
  title: string;
  onlyTalkMode: boolean;
  sidebarCollapsed: boolean;
  windowMaximized: boolean;
  onRevealSidebar: () => void;
  activeConversationId: string;
  activeProjectDir?: string;
  projectPathAliases: Array<{ from: string; to: string }>;
  selectedProjectDir: string;
  availableProjects: ProjectItem[];
  onWelcomeProjectChange: (projectDir: string | null) => Promise<void>;
  projectContext: string;
  messages: ChatMessage[];
  activeGoal: ExperimentalGoal | null;
  goalAvailable: boolean;
  goalCancelling: boolean;
  goalWaiting: boolean;
  changeReports: ConversationChangeReport[];
  skills: SkillSummary[];
  disabledSkillNames: Set<string>;
  visualInputAvailable: boolean;
  visualInputEnabled: boolean;
  contextSearchAvailable: boolean;
  subagentObservabilityAvailable: boolean;
  shadowAvailable: boolean;
  shadowAccentColor: string;
  shadowThemeVariables: Record<`--${string}`, string>;
  thinkingVisible: boolean;
  guidanceDeliveryMode: AppSettingsState['guidance']['deliveryMode'];
  loading: boolean;
  historyLoading: boolean;
  sending: boolean;
  stopping: boolean;
  activeTurnId: string;
  connectionRecovery?: RuntimeConnectionUpdate;
  queuedMessageCount: number;
  queuedMessagePreview: string;
  queuedMessages: QueuedChatMessage[];
  pendingInteraction: PendingInteraction | null;
  error: string | null;
  notice: string | null;
  selectedModel: string;
  selectedModelConfig?: ManagedModelConfig;
  contextWindowMaxTokens?: number;
  contextWindowUsage?: RuntimeContextWindowUsage;
  availableModels: ManagedModelConfig[];
  referencePlanAvailable: boolean;
  referencePlanMode: ReferencePlanMode;
  permissionMode: PermissionMode;
  subagentPermissionRouting: SubagentPermissionRouting;
  reasoningLevelAvailable: boolean;
  reasoningLevel: ReasoningLevel;
  reasoningLevels: ReasoningLevel[];
  gitAvailable: boolean;
  onModelChange: (value: string) => void;
  onReferencePlanModeChange: (value: ReferencePlanMode) => void;
  onPermissionModeChange: (value: PermissionMode) => void;
  onSubagentPermissionRoutingChange: (value: SubagentPermissionRouting) => void;
  onReasoningLevelChange: (value: ReasoningLevel) => void;
  onConfigureModels: () => void;
  onCreateConversation: () => void;
  onSaveProjectContext: (value: string) => Promise<string>;
  onToggleSkill: (skillName: string, enabled: boolean) => void;
  onVisualInputEnabledChange: (enabled: boolean) => void;
  onRefreshActiveSession: RefreshActiveSession;
  onSend: (text: string) => Promise<void>;
  onRetryMessage: (message: ChatMessage) => Promise<void>;
  onRegenerate: (message: ChatMessage) => Promise<void>;
  onEditUserMessage: (message: ChatMessage, content: string) => Promise<void>;
  onGuideMessage: (
    message: ChatMessage,
    guidance: string,
    mode: 'append_context' | 'interrupt_and_continue',
  ) => Promise<void>;
  onRetryGuidance: (message: ChatMessage) => Promise<void>;
  onGuideQueuedMessage: (
    queuedId: string,
    mode?: 'append_context' | 'interrupt_and_continue',
  ) => Promise<void>;
  onRemoveQueuedMessage: (queuedId: string) => void;
  onReorderQueuedMessage: (queuedId: string, targetQueuedId: string) => void;
  onRevertChangeReport: (
    report: ConversationChangeReport,
    message: ChatMessage,
  ) => Promise<void>;
  onOpenChangeReview: (filePath?: string) => void;
  onReplyInteraction: (reply: InteractionReplyAnswer[]) => Promise<void>;
  onCancelInteraction: () => Promise<void>;
  onCancelGoal: () => Promise<void>;
  onCancel: () => Promise<void>;
  onClearError: () => void;
  onClearNotice: () => void;
  draft: string;
  onDraftChange: (value: string) => void;
}) {
  const chatPanelRenderStartedAt = performance.now();
  useLayoutEffect(() => {
    recordUiPerformanceMetric('chat_panel_commit_ms', {
      sessionId: activeConversationId,
      value: performance.now() - chatPanelRenderStartedAt,
    });
  });
  const renderMessages = useMemo(() => {
    const normalized = normalizeChatMessagesForDisplay(messages);
    const activeTranscript = sending
      ? normalizeActiveTurnTranscriptForDisplay(normalized, activeTurnId)
      : normalized;
    return projectRenderableChatMessages(activeTranscript);
  }, [activeTurnId, messages, sending]);
  const [refreshError, setRefreshError] = useState('');
  const refreshBackendWithFeedback = useCallback(async (
    options?: { silent?: boolean },
  ) => {
    try {
      await onRefreshActiveSession(options);
      setRefreshError('');
    } catch (caught) {
      setRefreshError(
        language === 'zh'
          ? 'TypeScript Runtime 不可用，请重启 CardBush 后重试。'
          : 'The TypeScript Runtime is unavailable. Restart CardBush and retry.',
      );
      throw caught;
    }
  }, [language, onRefreshActiveSession]);
  const currentTurnChangeReports = useMemo(() => {
    if (changeReports.length === 0) return [];
    const active = activeTurnId.trim();
    const latest = changeReports[changeReports.length - 1];
    const targetTurn = active || latest?.turnId?.trim() || '';
    if (!targetTurn) return latest ? [latest] : [];
    const matching = changeReports.filter(
      (report) => report.turnId?.trim() === targetTurn,
    );
    return matching.length > 0 ? matching : active ? [] : latest ? [latest] : [];
  }, [activeTurnId, changeReports]);
  const currentTurnChangeSummary = useMemo(
    () => summarizeChangeReports(currentTurnChangeReports),
    [currentTurnChangeReports],
  );
  const activeRuntimeAssistant = useMemo(
    () => sending
      ? streamingAssistantMessage(renderMessages, activeTurnId)?.message ?? null
      : null,
    [activeTurnId, renderMessages, sending],
  );
  const activeTaskPlan = useMemo(() => {
    if (!activeRuntimeAssistant) return undefined;
    if (activeRuntimeAssistant.taskPlan) return activeRuntimeAssistant.taskPlan;
    return [...(activeRuntimeAssistant.loopHistory ?? [])]
      .reverse()
      .find((message) => message.taskPlan)?.taskPlan;
  }, [activeRuntimeAssistant]);
  const activeGoalRounds = useMemo(() => {
    if (!activeRuntimeAssistant) return [];
    const transcript = [
      ...(activeRuntimeAssistant.loopHistory ?? []),
      activeRuntimeAssistant,
    ];
    const seen = new Set<string>();
    return transcript.flatMap((message) => message.toolExecutions ?? [])
      .map((execution) => ({ execution, update: goalToolUpdateFromExecution(execution) }))
      .filter(({ execution, update }) => {
        if (!update || seen.has(execution.id)) return false;
        seen.add(execution.id);
        return true;
      })
      .map(({ update }) => update!);
  }, [activeRuntimeAssistant]);
  const showWelcome = !loading && renderMessages.length === 0;
  const listScrollerRef = useRef<HTMLElement | null>(null);
  const chatBodyRef = useRef<HTMLDivElement>(null);
  const composerDockRef = useRef<HTMLDivElement>(null);
  const scrollBottomButtonRef = useRef<HTMLButtonElement>(null);
  const atBottomRef = useRef(true);
  const autoFollowStreamRef = useRef(true);
  const userDetachedFromBottomRef = useRef(false);
  const showScrollBottomRef = useRef(false);
  const pendingSubmittedUserFocusRef = useRef(false);
  const pendingSubmittedUserEntryUntilRef = useRef(0);
  const userMessageEntryTimersRef = useRef<Map<string, number>>(new Map());
  const programmaticScrollUntilRef = useRef(0);
  const manualScrollDetachUntilRef = useRef(0);
  const lastScrollTopRef = useRef(0);
  const lastWheelEventAtRef = useRef(0);
  const handledWheelEventsRef = useRef<WeakSet<globalThis.WheelEvent>>(new WeakSet());
  const scrollbarDragActiveRef = useRef(false);
  const scrollbarDragUntilRef = useRef(0);
  const listScrollerWheelCleanupRef = useRef<(() => void) | null>(null);
  const scrollBottomWheelCleanupRef = useRef<(() => void) | null>(null);
  const lastWheelLockRef = useRef<{
    at: number;
    source: string;
    scrollTop: number;
  } | null>(null);
  const latestConversationScrollRef = useRef<{
    conversationId: string;
    latestMessageId: string;
  }>({
    conversationId: '',
    latestMessageId: '',
  });

  useEffect(() => {
    if (!notice) {
      return undefined;
    }
    const timer = window.setTimeout(onClearNotice, 4200);
    return () => window.clearTimeout(timer);
  }, [notice, onClearNotice]);
  const messageSnapshotRef = useRef<{ conversationId: string; ids: string[] }>({
    conversationId: '',
    ids: [],
  });
  const streamScrollFrameRef = useRef<number | null>(null);
  const outerResizeFollowFrameRef = useRef<number | null>(null);
  const scrollTraceSequenceRef = useRef(0);
  const activeScrollTraceIdRef = useRef('');
  const scrollTraceObserveUntilRef = useRef(0);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const [assistantStageReservationActive, setAssistantStageReservationActive] =
    useState(false);
  const [enteringUserMessageIds, setEnteringUserMessageIds] = useState<Set<string>>(
    () => new Set(),
  );
  const pendingSubmittedUserEntryMessageId = (() => {
    if (Date.now() > pendingSubmittedUserEntryUntilRef.current) return '';
    const previous = messageSnapshotRef.current;
    const previousIds = previous.conversationId === activeConversationId
      ? new Set(previous.ids)
      : new Set<string>();
    for (let index = renderMessages.length - 1; index >= 0; index -= 1) {
      const message = renderMessages[index];
      if (message?.role === 'user' && !previousIds.has(message.id)) {
        return message.id;
      }
    }
    return '';
  })();
  const shadowCanActivate = shadowAvailable && !sending && Boolean(activeConversationId) &&
    Boolean(selectedModelConfig) && Boolean(window.cardbushDesktop?.openShadowWindow) &&
    messages.some((message) => message.role === 'user');

  const openShadowPopup = useCallback(async () => {
    if (!shadowCanActivate || !selectedModelConfig) return;
    try {
      await window.cardbushDesktop?.openShadowWindow({
        sessionId: activeConversationId,
        sourceTurnId: activeTurnId,
        title,
        language,
        theme,
        accentColor: shadowAccentColor,
        themeVariables: shadowThemeVariables,
        modelConfig: selectedModelConfig,
        reasoningLevel,
        projectDir: activeProjectDir ?? '',
        initialMode: 'readonly',
      });
    } catch (error) {
      void window.cardbushDesktop?.writeDebugLog?.('shadow-window', {
        stage: 'open-failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [
    activeConversationId,
    activeProjectDir,
    activeTurnId,
    language,
    reasoningLevel,
    selectedModelConfig,
    shadowAccentColor,
    shadowThemeVariables,
    shadowCanActivate,
    theme,
    title,
  ]);
  const [composerDockHeight, setComposerDockHeight] = useState(0);
  const [quickContextBottomInset, setQuickContextBottomInset] = useState(0);
  const [activeScene, setActiveScene] = useState<CardlingScene | null>(null);
  const [availableScene, setAvailableScene] = useState<CardlingScene | null>(null);
  const [activeSceneInitialAutoPlay, setActiveSceneInitialAutoPlay] = useState(false);
  const activeSceneKeyRef = useRef('');
  const activeSceneRevisionRef = useRef('');
  const dismissedSceneKeysRef = useRef(new Set<string>());
  const autoPlayedSceneKeysRef = useRef(new Set<string>());
  const streamStatusHeight = 0;
  const setScrollBottomVisible = useCallback((visible: boolean) => {
    showScrollBottomRef.current = visible;
    setShowScrollBottom(visible);
  }, []);

  const releaseAssistantStageReservation = useCallback(() => {
    setAssistantStageReservationActive(false);
  }, []);

  useEffect(() => {
    if (!sending) {
      setAssistantStageReservationActive(false);
    }
  }, [sending]);

  const readBottomMetrics = useCallback((scroller: HTMLElement): ScrollBottomMetrics => {
    const absoluteBottomDistance = absoluteBottomScrollTop(scroller) - scroller.scrollTop;
    const visualBottomDistance =
      visualBottomScrollTop(scroller, composerDockHeight, streamStatusHeight) -
      scroller.scrollTop;
    const visualNearBottom =
      visualBottomDistance <= scrollBottomLockTolerance ||
      absoluteBottomDistance <= scrollBottomLockTolerance;
    const visualAtBottom =
      visualBottomDistance <= scrollBottomWheelLockTolerance ||
      absoluteBottomDistance <= scrollBottomWheelLockTolerance;
    return {
      visualNearBottom,
      visualAtBottom,
      visualBottomDistance,
      absoluteBottomDistance,
      absoluteAtBottom:
        absoluteBottomDistance <= scrollBottomWheelLockTolerance,
    };
  }, [composerDockHeight, streamStatusHeight]);

  const captureScrollGeometry = useCallback(
    (label: string, extra: Record<string, unknown> = {}) => {
      const scroller = listScrollerRef.current;
      const chatBody = chatBodyRef.current;
      const frame = chatBody?.querySelector('.chat-content-frame');
      const footer = scroller?.querySelector('.message-list-footer');
      const dock = composerDockRef.current;
      const button = scrollBottomButtonRef.current;
      const rect = (element: Element | null | undefined) => {
        if (!(element instanceof HTMLElement)) return null;
        const value = element.getBoundingClientRect();
        return {
          x: Math.round(value.x),
          y: Math.round(value.y),
          width: Math.round(value.width),
          height: Math.round(value.height),
          bottom: Math.round(value.bottom),
          right: Math.round(value.right),
        };
      };
      const metrics = scroller ? readBottomMetrics(scroller) : null;
      scrollDebug(label, {
        traceId:
          Date.now() <= scrollTraceObserveUntilRef.current
            ? activeScrollTraceIdRef.current || null
            : null,
        conversationId: activeConversationId,
        sending,
        showScrollBottom: showScrollBottomRef.current,
        autoFollow: autoFollowStreamRef.current,
        userDetached: userDetachedFromBottomRef.current,
        atBottom: atBottomRef.current,
        composerDockHeight,
        scrollTop: scroller ? Math.round(scroller.scrollTop) : null,
        scrollHeight: scroller?.scrollHeight ?? null,
        clientHeight: scroller?.clientHeight ?? null,
        offsetWidth: scroller?.offsetWidth ?? null,
        clientWidth: scroller?.clientWidth ?? null,
        absoluteBottomDistance: metrics
          ? Math.round(metrics.absoluteBottomDistance)
          : null,
        visualBottomDistance: metrics
          ? Math.round(metrics.visualBottomDistance)
          : null,
        scrollerRect: rect(scroller),
        chatBodyRect: rect(chatBody),
        frameRect: rect(frame),
        composerRect: rect(dock),
        footerRect: rect(footer),
        buttonRect: rect(button),
        ...extra,
      });
    },
    [activeConversationId, composerDockHeight, readBottomMetrics, sending],
  );

  const isLatestMessageTailVisible = useCallback(
    (scroller: HTMLElement, tolerance = 36) => {
      const latestMessage = renderMessages[renderMessages.length - 1];
      if (!latestMessage) {
        return true;
      }
      return isMessageTailVisible(scroller, latestMessage.id, {
        composerDockHeight: quickContextBottomInset,
        streamStatusHeight,
        tolerance,
      });
    },
    [quickContextBottomInset, renderMessages, streamStatusHeight],
  );

  const shouldShowScrollBottomForMetrics = useCallback(
    (scroller: HTMLElement, metrics: ScrollBottomMetrics) => {
      if (metrics.visualNearBottom || metrics.absoluteAtBottom) {
        return false;
      }
      return !isLatestMessageTailVisible(scroller);
    },
    [isLatestMessageTailVisible],
  );

  const shouldShowScrollBottomForScroller = useCallback(
    (scroller: HTMLElement | null) => {
      if (!scroller) {
        return false;
      }
      return shouldShowScrollBottomForMetrics(scroller, readBottomMetrics(scroller));
    },
    [readBottomMetrics, shouldShowScrollBottomForMetrics],
  );

  const nativeWheelEvent = useCallback(
    (event: WheelEvent<HTMLElement> | globalThis.WheelEvent) =>
      'nativeEvent' in event ? event.nativeEvent : event,
    [],
  );

  const wheelAlreadyHandled = useCallback(
    (event: WheelEvent<HTMLElement> | globalThis.WheelEvent) =>
      handledWheelEventsRef.current.has(nativeWheelEvent(event)),
    [nativeWheelEvent],
  );

  const markWheelHandled = useCallback(
    (event: WheelEvent<HTMLElement> | globalThis.WheelEvent) => {
      handledWheelEventsRef.current.add(nativeWheelEvent(event));
    },
    [nativeWheelEvent],
  );

  const wheelTargetIsListSurface = useCallback((target: EventTarget | null) => {
    if (!(target instanceof Node)) {
      return false;
    }
    return Boolean(
      listScrollerRef.current?.contains(target) ||
        scrollBottomButtonRef.current?.contains(target),
    );
  }, []);

  const isPointerOnVerticalScrollbar = useCallback(
    (scroller: HTMLElement, event: ReactPointerEvent<HTMLElement>) => {
      const rect = scroller.getBoundingClientRect();
      const nativeScrollbarWidth = Math.max(0, scroller.offsetWidth - scroller.clientWidth);
      const scrollbarHitWidth = Math.max(18, nativeScrollbarWidth + 8);
      return (
        scroller.scrollHeight > scroller.clientHeight + 1 &&
        event.clientX >= rect.right - scrollbarHitWidth &&
        event.clientX <= rect.right + 2 &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom
      );
    },
    [],
  );

  const nextSceneInitialAutoPlay = useCallback(
    (scene: CardlingScene, allowAutoPlay: boolean) => {
      const key = cardlingSceneKey(scene);
      if (
        !allowAutoPlay ||
        !sceneAutoPlayEnabled(scene) ||
        autoPlayedSceneKeysRef.current.has(key)
      ) {
        return false;
      }
      autoPlayedSceneKeysRef.current.add(key);
      return true;
    },
    [],
  );

  const showScene = useCallback(
    (scene: CardlingScene, options?: { autoPlay?: boolean }) => {
      const key = cardlingSceneKey(scene);
      const revision = cardlingSceneRevisionKey(scene);
      setAvailableScene((current) =>
        current && cardlingSceneRevisionKey(current) === revision ? current : scene,
      );
      if (activeSceneKeyRef.current !== key) {
        activeSceneKeyRef.current = key;
        activeSceneRevisionRef.current = revision;
        setActiveSceneInitialAutoPlay(
          nextSceneInitialAutoPlay(scene, Boolean(options?.autoPlay)),
        );
        setActiveScene(scene);
      } else if (activeSceneRevisionRef.current !== revision) {
        activeSceneRevisionRef.current = revision;
        setActiveSceneInitialAutoPlay(false);
        setActiveScene(scene);
      }
    },
    [nextSceneInitialAutoPlay],
  );

  const openScene = useCallback((scene: CardlingScene) => {
    dismissedSceneKeysRef.current.delete(cardlingSceneKey(scene));
    showScene(scene);
  }, [showScene]);

  const closeScene = useCallback(() => {
    setActiveScene((current) => {
      if (current) {
        dismissedSceneKeysRef.current.add(cardlingSceneKey(current));
      }
      activeSceneKeyRef.current = '';
      activeSceneRevisionRef.current = '';
      return null;
    });
    setActiveSceneInitialAutoPlay(false);
  }, []);

  const positionMessageAtReadingAnchor = useCallback(
    (messageId: string) => {
      const scroller = listScrollerRef.current;
      if (!scroller) {
        return;
      }
      const item = scroller.querySelector(
        `[data-message-id="${cssEscape(messageId)}"]`,
      );
      if (!(item instanceof HTMLElement)) {
        return;
      }
      const scrollerRect = scroller.getBoundingClientRect();
      const itemRect = item.getBoundingClientRect();
      const desiredTop = Math.round(
        Math.min(56, Math.max(34, scroller.clientHeight * 0.07)),
      );
      scroller.style.setProperty(
        '--submitted-user-reading-anchor',
        `${desiredTop}px`,
      );
      const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const nextTop = Math.max(
        0,
        Math.min(
          maxTop,
          scroller.scrollTop + itemRect.top - scrollerRect.top - desiredTop,
        ),
      );
      if (
        import.meta.env.DEV &&
        nextTop === 0 &&
        itemRect.top - scrollerRect.top < desiredTop - 8
      ) {
        console.debug('[cardbush:message-anchor]', {
          messageId,
          currentScrollTop: Math.round(scroller.scrollTop),
          nextTop,
          maxTop,
          desiredTop,
          itemTop: Math.round(itemRect.top - scrollerRect.top),
          itemHeight: Math.round(itemRect.height),
          scrollerHeight: scroller.clientHeight,
          scrollHeight: scroller.scrollHeight,
        });
      }
      scroller.scrollTo({
        top: nextTop,
        behavior: gentleAutoFollowScrollBehavior(),
      });
    },
    [],
  );

  const focusSubmittedUserMessage = useCallback(
    (_index: number, messageId: string) => {
      pendingSubmittedUserFocusRef.current = false;
      programmaticScrollUntilRef.current = Date.now() + 1200;
      manualScrollDetachUntilRef.current = 0;
      autoFollowStreamRef.current = true;
      userDetachedFromBottomRef.current = false;
      setScrollBottomVisible(false);
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          positionMessageAtReadingAnchor(messageId);
        });
      });
    },
    [positionMessageAtReadingAnchor, setScrollBottomVisible],
  );

  const ensureMessageBottomVisible = useCallback(
    (messageId: string) => {
      const scroller = listScrollerRef.current;
      if (!scroller) {
        return;
      }
      const item = scroller.querySelector(
        `[data-message-id="${cssEscape(messageId)}"]`,
      );
      if (!(item instanceof HTMLElement)) {
        return;
      }
      const scrollerRect = scroller.getBoundingClientRect();
      const stagedContent = item.classList.contains('assistant-render-stage')
        ? item.querySelector<HTMLElement>('.message-row.assistant')
        : null;
      const itemRect = (stagedContent ?? item).getBoundingClientRect();
      const visibleBottom =
        scrollerRect.bottom - Math.max(0, quickContextBottomInset) - streamStatusHeight - 18;
      if (itemRect.bottom <= visibleBottom) {
        return;
      }
      const delta = Math.ceil(itemRect.bottom - visibleBottom);
      scroller.scrollBy({
        top: delta,
        behavior: gentleAutoFollowScrollBehavior(),
      });
    },
    [quickContextBottomInset, streamStatusHeight],
  );

  const cancelScheduledStreamFollow = useCallback(() => {
    if (streamScrollFrameRef.current == null) {
      return;
    }
    window.cancelAnimationFrame(streamScrollFrameRef.current);
    streamScrollFrameRef.current = null;
  }, []);

  const scheduleActiveAssistantFollow = useCallback(
    (messageId: string, _index: number) => {
      if (streamScrollFrameRef.current != null) {
        window.cancelAnimationFrame(streamScrollFrameRef.current);
      }
      programmaticScrollUntilRef.current = Date.now() + 900;
      streamScrollFrameRef.current = window.requestAnimationFrame(() => {
        streamScrollFrameRef.current = null;
        if (
          !autoFollowStreamRef.current ||
          userDetachedFromBottomRef.current ||
          Date.now() < manualScrollDetachUntilRef.current
        ) {
          return;
        }
        const scroller = listScrollerRef.current;
        const item = scroller?.querySelector(
          `[data-message-id="${cssEscape(messageId)}"]`,
        );
        if (!(item instanceof HTMLElement)) {
          window.requestAnimationFrame(() => {
            if (
              autoFollowStreamRef.current &&
              !userDetachedFromBottomRef.current &&
              Date.now() >= manualScrollDetachUntilRef.current
            ) {
              ensureMessageBottomVisible(messageId);
            }
          });
          return;
        }
        ensureMessageBottomVisible(messageId);
      });
    },
    [composerDockHeight, ensureMessageBottomVisible, streamStatusHeight],
  );

  const restoreWheelLockedScrollTop = useCallback(
    (
      scroller: HTMLElement,
      lockedScrollTop: number,
    ) => {
      if (Math.abs(scroller.scrollTop - lockedScrollTop) >= 0.5) {
        scroller.scrollTop = lockedScrollTop;
      }
    },
    [],
  );

  const resolveWheelLockedScrollTop = useCallback(
    (
      source: string,
      scroller: HTMLElement,
      metrics: { visualNearBottom: boolean },
    ) => {
      const now = Date.now();
      const previous = lastWheelLockRef.current;
      const reusePrevious =
        previous &&
        now - previous.at < scrollBottomWheelFreezeMs &&
        metrics.visualNearBottom &&
        Math.abs(scroller.scrollTop - previous.scrollTop) <=
          scrollBottomLockTolerance * 2;
      const scrollTop = reusePrevious ? previous.scrollTop : scroller.scrollTop;
      const anchor = {
        at: now,
        source,
        scrollTop,
      };
      lastWheelLockRef.current = anchor;
      return scrollTop;
    },
    [],
  );

  const lockWheelDownAtBottom = useCallback(
    (source: 'list' | 'scroll-bottom-hotzone', event: WheelEvent<HTMLElement>) => {
      const scroller = listScrollerRef.current;
      if (!scroller || event.deltaY <= 0) {
        return false;
      }
      const metrics = readBottomMetrics(scroller);
      if (!metrics.visualAtBottom) {
        return false;
      }
      if (metrics.absoluteAtBottom) {
        return false;
      }
      event.preventDefault();
      event.stopPropagation();
      manualScrollDetachUntilRef.current = 0;
      autoFollowStreamRef.current = true;
      userDetachedFromBottomRef.current = false;
      setScrollBottomVisible(false);
      const lockedScrollTop = resolveWheelLockedScrollTop(source, scroller, metrics);
      scrollDebug('wheel-bottom-lock', {
        source,
        scrollTop: Math.round(scroller.scrollTop),
        lockedScrollTop: Math.round(lockedScrollTop),
        visualBottomDistance: Math.round(metrics.visualBottomDistance),
        absoluteBottomDistance: Math.round(metrics.absoluteBottomDistance),
        visualAtBottom: metrics.visualAtBottom,
      });
      restoreWheelLockedScrollTop(scroller, lockedScrollTop);
      return true;
    },
    [
      readBottomMetrics,
      resolveWheelLockedScrollTop,
      restoreWheelLockedScrollTop,
      setScrollBottomVisible,
    ],
  );

  const lockNativeWheelDownAtBottom = useCallback(
    (
      source: 'native-chat-body' | 'native-list' | 'native-scroll-bottom-hotzone',
      event: globalThis.WheelEvent,
    ) => {
      const scroller = listScrollerRef.current;
      if (!scroller || event.deltaY <= 0) {
        return false;
      }
      const metrics = readBottomMetrics(scroller);
      if (!metrics.visualAtBottom) {
        return false;
      }
      if (metrics.absoluteAtBottom) {
        return false;
      }
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      manualScrollDetachUntilRef.current = 0;
      autoFollowStreamRef.current = true;
      userDetachedFromBottomRef.current = false;
      setScrollBottomVisible(false);
      const lockedScrollTop = resolveWheelLockedScrollTop(source, scroller, metrics);
      scrollDebug('native-wheel-bottom-lock', {
        source,
        scrollTop: Math.round(scroller.scrollTop),
        lockedScrollTop: Math.round(lockedScrollTop),
        visualBottomDistance: Math.round(metrics.visualBottomDistance),
        absoluteBottomDistance: Math.round(metrics.absoluteBottomDistance),
        visualAtBottom: metrics.visualAtBottom,
      });
      restoreWheelLockedScrollTop(scroller, lockedScrollTop);
      return true;
    },
    [
      readBottomMetrics,
      resolveWheelLockedScrollTop,
      restoreWheelLockedScrollTop,
      setScrollBottomVisible,
    ],
  );

  const releaseWheelBottomFreeze = useCallback(
    (
      event: WheelEvent<HTMLElement> | globalThis.WheelEvent,
    ) => {
      if (event.deltaY >= 0) {
        return false;
      }
      const previous = lastWheelLockRef.current;
      if (!previous) {
        return false;
      }
      lastWheelLockRef.current = null;
      programmaticScrollUntilRef.current = 0;
      manualScrollDetachUntilRef.current = Date.now() + manualScrollDetachHoldMs;
      autoFollowStreamRef.current = false;
      userDetachedFromBottomRef.current = true;
      pendingSubmittedUserFocusRef.current = false;
      releaseAssistantStageReservation();
      cancelScheduledStreamFollow();
      setScrollBottomVisible(shouldShowScrollBottomForScroller(listScrollerRef.current));
      return true;
    },
    [
      cancelScheduledStreamFollow,
      releaseAssistantStageReservation,
      setScrollBottomVisible,
      shouldShowScrollBottomForScroller,
    ],
  );

  const markUserDetachedFromBottom = useCallback((reason = 'user-scroll') => {
    captureScrollGeometry('trace-detach', { reason });
    lastWheelLockRef.current = null;
    programmaticScrollUntilRef.current = 0;
    manualScrollDetachUntilRef.current = Date.now() + manualScrollDetachHoldMs;
    cancelScheduledStreamFollow();
    scrollDebug('detach', {
      reason,
      sending,
      atBottom: atBottomRef.current,
      scrollTop: Math.round(listScrollerRef.current?.scrollTop ?? 0),
    });
    userDetachedFromBottomRef.current = true;
    autoFollowStreamRef.current = false;
    pendingSubmittedUserFocusRef.current = false;
    releaseAssistantStageReservation();
    const shouldShow = shouldShowScrollBottomForScroller(listScrollerRef.current);
    if (!atBottomRef.current) {
      setScrollBottomVisible(shouldShow);
      return;
    }
    window.requestAnimationFrame(() => {
      if (userDetachedFromBottomRef.current && !atBottomRef.current) {
        setScrollBottomVisible(
          shouldShowScrollBottomForScroller(listScrollerRef.current),
        );
      }
    });
  }, [
    cancelScheduledStreamFollow,
    captureScrollGeometry,
    releaseAssistantStageReservation,
    sending,
    setScrollBottomVisible,
    shouldShowScrollBottomForScroller,
  ]);

  const handleListWheelCapture = useCallback(
    (event: WheelEvent<HTMLElement>) => {
      if (event.defaultPrevented || wheelAlreadyHandled(event)) {
        return;
      }
      lastWheelEventAtRef.current = Date.now();
      captureScrollGeometry('trace-wheel-input', {
        surface: 'list',
        deltaX: Math.round(event.deltaX),
        deltaY: Math.round(event.deltaY),
        deltaMode: event.deltaMode,
      });
      if (event.deltaY !== 0) {
        releaseAssistantStageReservation();
      }
      if (event.deltaY < 0) {
        if (releaseWheelBottomFreeze(event)) {
          markWheelHandled(event);
        }
        markUserDetachedFromBottom('wheel-up');
        markWheelHandled(event);
        return;
      }
      if (lockWheelDownAtBottom('list', event)) {
        markWheelHandled(event);
        return;
      }
    },
    [
      lockWheelDownAtBottom,
      captureScrollGeometry,
      markUserDetachedFromBottom,
      markWheelHandled,
      releaseAssistantStageReservation,
      releaseWheelBottomFreeze,
      wheelAlreadyHandled,
    ],
  );

  const handleScrollBottomWheelCapture = useCallback(
    (event: WheelEvent<HTMLElement>) => {
      if (event.defaultPrevented || wheelAlreadyHandled(event)) {
        return;
      }
      lastWheelEventAtRef.current = Date.now();
      captureScrollGeometry('trace-wheel-input', {
        surface: 'scroll-bottom-button',
        deltaX: Math.round(event.deltaX),
        deltaY: Math.round(event.deltaY),
        deltaMode: event.deltaMode,
      });
      if (event.deltaY !== 0) {
        releaseAssistantStageReservation();
      }
      if (event.deltaY < 0) {
        if (releaseWheelBottomFreeze(event)) {
          markWheelHandled(event);
        }
        markUserDetachedFromBottom('wheel-up-hotzone');
        markWheelHandled(event);
        return;
      }
      if (lockWheelDownAtBottom('scroll-bottom-hotzone', event)) {
        markWheelHandled(event);
        return;
      }
    },
    [
      lockWheelDownAtBottom,
      captureScrollGeometry,
      markUserDetachedFromBottom,
      markWheelHandled,
      releaseAssistantStageReservation,
      releaseWheelBottomFreeze,
      wheelAlreadyHandled,
    ],
  );

  const handleChatBodyWheelCapture = useCallback(
    (event: WheelEvent<HTMLElement>) => {
      if (
        event.defaultPrevented ||
        wheelAlreadyHandled(event) ||
        wheelTargetIsListSurface(event.target) ||
        event.target instanceof Element && Boolean(event.target.closest('.quick-context-rail'))
      ) {
        return;
      }
      lastWheelEventAtRef.current = Date.now();
      if (event.deltaY !== 0) {
        releaseAssistantStageReservation();
      }
      if (event.deltaY < 0) {
        if (releaseWheelBottomFreeze(event)) {
          markWheelHandled(event);
        }
        markUserDetachedFromBottom('wheel-up-body');
        markWheelHandled(event);
      }
    },
    [
      markUserDetachedFromBottom,
      markWheelHandled,
      releaseAssistantStageReservation,
      releaseWheelBottomFreeze,
      wheelAlreadyHandled,
      wheelTargetIsListSurface,
    ],
  );

  useEffect(() => {
    const chatBody = chatBodyRef.current;
    if (!chatBody) {
      return undefined;
    }
    const handleNativeWheel = (event: globalThis.WheelEvent) => {
      if (
        event.defaultPrevented ||
        wheelAlreadyHandled(event) ||
        wheelTargetIsListSurface(event.target) ||
        event.target instanceof Element && Boolean(event.target.closest('.quick-context-rail'))
      ) {
        return;
      }
      lastWheelEventAtRef.current = Date.now();
      if (event.deltaY !== 0) {
        releaseAssistantStageReservation();
      }
      if (releaseWheelBottomFreeze(event)) {
        markWheelHandled(event);
        return;
      }
      if (lockNativeWheelDownAtBottom('native-chat-body', event)) {
        markWheelHandled(event);
        return;
      }
    };
    chatBody.addEventListener('wheel', handleNativeWheel, {
      capture: true,
      passive: false,
    });
    return () => {
      chatBody.removeEventListener('wheel', handleNativeWheel, {
        capture: true,
      });
    };
  }, [
    lockNativeWheelDownAtBottom,
    markWheelHandled,
    releaseAssistantStageReservation,
    releaseWheelBottomFreeze,
    wheelAlreadyHandled,
    wheelTargetIsListSurface,
  ]);

  const lockStreamFollow = useCallback(
    (_reason: string) => {
      scrollDebug('lock-follow', {
        reason: _reason,
        sending,
        scrollTop: Math.round(listScrollerRef.current?.scrollTop ?? 0),
      });
      manualScrollDetachUntilRef.current = 0;
      autoFollowStreamRef.current = true;
      userDetachedFromBottomRef.current = false;
      pendingSubmittedUserFocusRef.current = false;
      if (showScrollBottomRef.current) {
        setScrollBottomVisible(false);
      }
    },
    [sending, setScrollBottomVisible],
  );

  const finishScrollbarDrag = useCallback(
    (reason: string) => {
      if (!scrollbarDragActiveRef.current) {
        return;
      }
      scrollbarDragActiveRef.current = false;
      const scroller = listScrollerRef.current;
      if (!scroller) {
        scrollbarDragUntilRef.current = Date.now() + 220;
        cancelScheduledStreamFollow();
        return;
      }
      const metrics = readBottomMetrics(scroller);
      scrollDebug('scrollbar-release', {
        reason,
        sending,
        scrollTop: Math.round(scroller.scrollTop),
        visualBottomDistance: Math.round(metrics.visualBottomDistance),
        visualNearBottom: metrics.visualNearBottom,
      });
      if (metrics.visualNearBottom) {
        scrollbarDragUntilRef.current = 0;
        lockStreamFollow(`${reason}:bottom`);
        return;
      }
      const shouldShow = shouldShowScrollBottomForMetrics(scroller, metrics);
      if (!shouldShow) {
        scrollbarDragUntilRef.current = 0;
        lockStreamFollow(`${reason}:tail-visible`);
        return;
      }
      scrollbarDragUntilRef.current = Date.now() + 220;
      autoFollowStreamRef.current = false;
      userDetachedFromBottomRef.current = true;
      pendingSubmittedUserFocusRef.current = false;
      cancelScheduledStreamFollow();
      setScrollBottomVisible(true);
    },
    [
      cancelScheduledStreamFollow,
      lockStreamFollow,
      readBottomMetrics,
      sending,
      setScrollBottomVisible,
      shouldShowScrollBottomForMetrics,
    ],
  );

  useEffect(() => {
    const handlePointerEnd = () => finishScrollbarDrag('scrollbar-pointer-end');
    window.addEventListener('pointerup', handlePointerEnd);
    window.addEventListener('pointercancel', handlePointerEnd);
    return () => {
      window.removeEventListener('pointerup', handlePointerEnd);
      window.removeEventListener('pointercancel', handlePointerEnd);
    };
  }, [finishScrollbarDrag]);

  const maybeLockStreamFollowFromScroll = useCallback(
    (scroller: HTMLElement, reason: string) => {
      if (!sending) {
        return;
      }
      const now = Date.now();
      const activeAssistant = streamingAssistantMessage(renderMessages, activeTurnId);
      const metrics = readBottomMetrics(scroller);
      const shouldShow = shouldShowScrollBottomForMetrics(scroller, metrics);
      if (
        userDetachedFromBottomRef.current &&
        now < manualScrollDetachUntilRef.current
      ) {
        if (!shouldShow) {
          lockStreamFollow(`${reason}:tail-visible-during-detach-hold`);
          return;
        }
        autoFollowStreamRef.current = false;
        pendingSubmittedUserFocusRef.current = false;
        setScrollBottomVisible(true);
        return;
      }
      if (metrics.visualAtBottom) {
        lockStreamFollow(`${reason}:bottom`);
        return;
      }
      if (userDetachedFromBottomRef.current) {
        if (!shouldShow) {
          lockStreamFollow(`${reason}:tail-visible`);
          return;
        }
        autoFollowStreamRef.current = false;
        pendingSubmittedUserFocusRef.current = false;
        setScrollBottomVisible(true);
        return;
      }
      if (metrics.visualNearBottom) {
        lockStreamFollow(`${reason}:near-bottom`);
        return;
      }
      const activeTailVisible = activeAssistant
        ? isMessageTailVisible(scroller, activeAssistant.message.id, {
            composerDockHeight: quickContextBottomInset,
            streamStatusHeight,
            tolerance: 36,
          })
        : false;
      if (activeTailVisible) {
        lockStreamFollow(`${reason}:active-tail`);
        return;
      }
      if (
        now >= programmaticScrollUntilRef.current &&
        (autoFollowStreamRef.current || !userDetachedFromBottomRef.current)
      ) {
        autoFollowStreamRef.current = false;
        userDetachedFromBottomRef.current = true;
        pendingSubmittedUserFocusRef.current = false;
        releaseAssistantStageReservation();
        setScrollBottomVisible(shouldShow);
      }
    },
    [
      activeTurnId,
      lockStreamFollow,
      quickContextBottomInset,
      readBottomMetrics,
      releaseAssistantStageReservation,
      renderMessages,
      sending,
      setScrollBottomVisible,
      shouldShowScrollBottomForMetrics,
      streamStatusHeight,
    ],
  );

  const handleListPointerDownCapture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (
        event.button !== 0 ||
        !(event.currentTarget instanceof HTMLElement) ||
        !isPointerOnVerticalScrollbar(event.currentTarget, event)
      ) {
        return;
      }
      const scroller = event.currentTarget;
      const metrics = readBottomMetrics(scroller);
      scrollbarDragActiveRef.current = true;
      scrollbarDragUntilRef.current = Date.now() + 4000;
      lastWheelLockRef.current = null;
      autoFollowStreamRef.current = false;
      userDetachedFromBottomRef.current = true;
      pendingSubmittedUserFocusRef.current = false;
      releaseAssistantStageReservation();
      cancelScheduledStreamFollow();
      setScrollBottomVisible(shouldShowScrollBottomForMetrics(scroller, metrics));
      scrollDebug('scrollbar-pointer-down', {
        sending,
        scrollTop: Math.round(scroller.scrollTop),
        visualBottomDistance: Math.round(metrics.visualBottomDistance),
        visualNearBottom: metrics.visualNearBottom,
      });
    },
    [
      cancelScheduledStreamFollow,
      isPointerOnVerticalScrollbar,
      readBottomMetrics,
      releaseAssistantStageReservation,
      sending,
      setScrollBottomVisible,
      shouldShowScrollBottomForMetrics,
    ],
  );

  const handleListScrollCapture = useCallback(
    (event: UIEvent<HTMLElement>) => {
      if (!(event.currentTarget instanceof HTMLElement)) {
        return;
      }
      const scroller = event.currentTarget;
      if (scroller.dataset.cardbushPreserveScroll === '1') {
        lastScrollTopRef.current = scroller.scrollTop;
        return;
      }
      const previousScrollTop = lastScrollTopRef.current;
      const scrollDelta = scroller.scrollTop - previousScrollTop;
      lastScrollTopRef.current = scroller.scrollTop;
      const metrics = readBottomMetrics(scroller);
      atBottomRef.current = metrics.visualAtBottom;
      const now = Date.now();
      const recentLock = lastWheelLockRef.current;
      const recentWheel = now - lastWheelEventAtRef.current <= 250;
      const scrollbarDragging =
        scrollbarDragActiveRef.current || now < scrollbarDragUntilRef.current;
      if (Date.now() <= scrollTraceObserveUntilRef.current) {
        captureScrollGeometry('trace-scroll-event', {
          scrollDelta: Math.round(scrollDelta),
          recentWheel,
          scrollbarDragging,
          programmaticRemainingMs: Math.max(
            0,
            programmaticScrollUntilRef.current - now,
          ),
        });
      }
      const likelyUserScrollWithoutWheel =
        sending &&
        scrollDelta > 0.5 &&
        now >= programmaticScrollUntilRef.current &&
        now - lastWheelEventAtRef.current > 120;
      if (scrollbarDragging) {
        lastWheelLockRef.current = null;
        autoFollowStreamRef.current = false;
        userDetachedFromBottomRef.current = true;
        pendingSubmittedUserFocusRef.current = false;
        releaseAssistantStageReservation();
        cancelScheduledStreamFollow();
        setScrollBottomVisible(shouldShowScrollBottomForMetrics(scroller, metrics));
        scrollDebug('scrollbar-scroll', {
          sending,
          delta: Math.round(scrollDelta),
          scrollTop: Math.round(scroller.scrollTop),
          visualBottomDistance: Math.round(metrics.visualBottomDistance),
          visualNearBottom: metrics.visualNearBottom,
        });
        return;
      }
      if (likelyUserScrollWithoutWheel && metrics.visualAtBottom) {
        lockStreamFollow('scroll:bottom-without-wheel');
        return;
      }
      if (
        sending &&
        scrollDelta < -0.5 &&
        (recentWheel || now >= programmaticScrollUntilRef.current)
      ) {
        lastWheelLockRef.current = null;
        programmaticScrollUntilRef.current = 0;
        manualScrollDetachUntilRef.current =
          Date.now() + manualScrollDetachHoldMs;
        autoFollowStreamRef.current = false;
        userDetachedFromBottomRef.current = true;
        pendingSubmittedUserFocusRef.current = false;
        releaseAssistantStageReservation();
        cancelScheduledStreamFollow();
        if (!shouldShowScrollBottomForMetrics(scroller, metrics)) {
          lockStreamFollow('scroll:tail-visible-after-up');
          return;
        }
        setScrollBottomVisible(true);
        return;
      }
      if (
        recentLock &&
        now - recentLock.at < scrollBottomWheelFreezeMs &&
        scroller.scrollTop < recentLock.scrollTop - 0.5 &&
        metrics.visualNearBottom
      ) {
        lastWheelLockRef.current = null;
        autoFollowStreamRef.current = false;
        userDetachedFromBottomRef.current = true;
        pendingSubmittedUserFocusRef.current = false;
        releaseAssistantStageReservation();
        cancelScheduledStreamFollow();
        if (!shouldShowScrollBottomForMetrics(scroller, metrics)) {
          lockStreamFollow('scroll:wheel-lock-tail-visible');
          return;
        }
        setScrollBottomVisible(true);
        return;
      }
      if (
        recentLock &&
        now - recentLock.at < scrollBottomWheelFreezeMs &&
        Math.abs(scroller.scrollTop - recentLock.scrollTop) >= 0.5 &&
        metrics.visualNearBottom
      ) {
        scroller.scrollTop = recentLock.scrollTop;
        return;
      }
      if (!sending) {
        if (
          userDetachedFromBottomRef.current &&
          now < manualScrollDetachUntilRef.current &&
          !metrics.absoluteAtBottom
        ) {
          autoFollowStreamRef.current = false;
          pendingSubmittedUserFocusRef.current = false;
          setScrollBottomVisible(shouldShowScrollBottomForMetrics(scroller, metrics));
          return;
        }
        if (now < programmaticScrollUntilRef.current) {
          if (metrics.visualNearBottom) {
            setScrollBottomVisible(false);
          }
          return;
        }
        if (!shouldShowScrollBottomForMetrics(scroller, metrics)) {
          autoFollowStreamRef.current = true;
          userDetachedFromBottomRef.current = false;
          setScrollBottomVisible(false);
        } else {
          autoFollowStreamRef.current = false;
          userDetachedFromBottomRef.current = true;
          pendingSubmittedUserFocusRef.current = false;
          setScrollBottomVisible(true);
        }
        return;
      }
      maybeLockStreamFollowFromScroll(scroller, 'scroll');
    },
    [
      maybeLockStreamFollowFromScroll,
      cancelScheduledStreamFollow,
      captureScrollGeometry,
      lockStreamFollow,
      readBottomMetrics,
      releaseAssistantStageReservation,
      sending,
      setScrollBottomVisible,
      shouldShowScrollBottomForMetrics,
    ],
  );

  useEffect(() => {
    const chatBody = chatBodyRef.current;
    if (loading || showWelcome) {
      setComposerDockHeight(0);
      setQuickContextBottomInset(0);
      chatBody?.style.removeProperty('--composer-surface-top');
      chatBody?.style.removeProperty('--composer-content-top');
      chatBody?.style.removeProperty('--composer-surface-center-x');
      chatBody?.style.removeProperty('--message-list-scrollbar-inset');
      chatBody?.style.removeProperty('--message-list-viewport-height');
      return undefined;
    }
    const dock = composerDockRef.current;
    if (!dock) {
      setComposerDockHeight(0);
      setQuickContextBottomInset(0);
      chatBody?.style.removeProperty('--composer-surface-top');
      chatBody?.style.removeProperty('--composer-content-top');
      chatBody?.style.removeProperty('--composer-surface-center-x');
      chatBody?.style.removeProperty('--message-list-scrollbar-inset');
      chatBody?.style.removeProperty('--message-list-viewport-height');
      return undefined;
    }
    let lastMeasurement = '';
    let measurementFrame: number | null = null;
    const updateHeight = () => {
      const dockRect = dock.getBoundingClientRect();
      const firstVisibleElement = dock.firstElementChild;
      const visibleTop = firstVisibleElement instanceof HTMLElement
        ? firstVisibleElement.getBoundingClientRect().top
        : dockRect.top;
      const nextDockHeight = Math.ceil(dockRect.height);
      const nextBottomInset = Math.ceil(Math.max(0, dockRect.bottom - visibleTop));
      if (chatBody) {
        const chatBodyRect = chatBody.getBoundingClientRect();
        chatBody.style.setProperty(
          '--composer-content-top',
          `${Math.max(0, visibleTop - chatBodyRect.top)}px`,
        );
      }
      const composerSurface = dock.querySelector<HTMLElement>(
        '.composer-surface, .interaction-card, .composer-stack',
      );
      if (chatBody && composerSurface) {
        const chatBodyRect = chatBody.getBoundingClientRect();
        const surfaceRect = composerSurface.getBoundingClientRect();
        chatBody.style.setProperty(
          '--composer-surface-top',
          `${Math.max(0, surfaceRect.top - chatBodyRect.top)}px`,
        );
        chatBody.style.setProperty(
          '--composer-surface-center-x',
          `${surfaceRect.left + surfaceRect.width / 2 - chatBodyRect.left}px`,
        );
      }
      const scroller = listScrollerRef.current;
      if (chatBody && scroller) {
        const scrollbarInset = Math.max(0, scroller.offsetWidth - scroller.clientWidth);
        chatBody.style.setProperty(
          '--message-list-scrollbar-inset',
          `${scrollbarInset}px`,
        );
        chatBody.style.setProperty(
          '--message-list-viewport-height',
          `${Math.max(0, scroller.clientHeight)}px`,
        );
      }
      const measurement = `${nextDockHeight}:${nextBottomInset}:${Math.round(dockRect.width)}:${listScrollerRef.current?.clientHeight ?? 0}`;
      if (measurement !== lastMeasurement) {
        lastMeasurement = measurement;
        captureScrollGeometry('trace-composer-measure', {
          nextDockHeight,
          nextBottomInset,
          measuredDockWidth: Math.round(dockRect.width),
        });
      }
      setComposerDockHeight(nextDockHeight);
      setQuickContextBottomInset(nextBottomInset);
    };
    const scheduleHeightUpdate = () => {
      if (measurementFrame != null) return;
      measurementFrame = window.requestAnimationFrame(() => {
        measurementFrame = null;
        updateHeight();
      });
    };
    updateHeight();
    const observer = new ResizeObserver(scheduleHeightUpdate);
    observer.observe(dock);
    if (chatBody) {
      observer.observe(chatBody);
    }
    if (listScrollerRef.current) {
      observer.observe(listScrollerRef.current);
    }
    if (dock.firstElementChild instanceof HTMLElement) {
      observer.observe(dock.firstElementChild);
    }
    const composerSurface = dock.querySelector<HTMLElement>(
      '.composer-surface, .interaction-card, .composer-stack',
    );
    if (composerSurface) {
      observer.observe(composerSurface);
    }
    const mutationObserver = new MutationObserver(scheduleHeightUpdate);
    mutationObserver.observe(dock, { childList: true });
    return () => {
      observer.disconnect();
      mutationObserver.disconnect();
      if (measurementFrame != null) {
        window.cancelAnimationFrame(measurementFrame);
      }
      chatBody?.style.removeProperty('--composer-surface-top');
      chatBody?.style.removeProperty('--composer-content-top');
      chatBody?.style.removeProperty('--composer-surface-center-x');
      chatBody?.style.removeProperty('--message-list-scrollbar-inset');
      chatBody?.style.removeProperty('--message-list-viewport-height');
    };
  }, [captureScrollGeometry, loading, pendingInteraction, showWelcome]);

  useEffect(() => {
    if (loading || showWelcome) return undefined;
    const chatBody = chatBodyRef.current;
    const chatPanel = chatBody?.closest('.chat-panel');
    const mainStage = chatBody?.closest('.main-stage');
    const frame = chatBody?.querySelector('.chat-content-frame');
    const scroller = listScrollerRef.current;
    const content = scroller?.querySelector('.message-list-content');
    const footer = scroller?.querySelector('.message-list-footer');
    const dock = composerDockRef.current;
    const dockContent = dock?.firstElementChild;
    const observed = [
      mainStage,
      chatPanel,
      chatBody,
      frame,
      scroller,
      content,
      footer,
      dock,
      dockContent,
    ].filter(
      (element): element is Element => element instanceof Element,
    );
    if (observed.length === 0) return undefined;
    let lastSignature = '';
    const observer = new ResizeObserver((entries) => {
      const signature = entries
        .map((entry) => {
          const target = entry.target as HTMLElement;
          return `${target.className}:${Math.round(entry.contentRect.width)}x${Math.round(entry.contentRect.height)}`;
        })
        .sort()
        .join('|');
      if (signature === lastSignature) return;
      lastSignature = signature;
      const beforeScrollTop = scroller?.scrollTop ?? null;
      const beforeScrollHeight = scroller?.scrollHeight ?? null;
      const beforeBottom = scroller
        ? absoluteBottomScrollTop(scroller) - scroller.scrollTop
        : null;
      captureScrollGeometry('trace-outer-resize', {
        entries: signature,
        beforeScrollTop: beforeScrollTop == null ? null : Math.round(beforeScrollTop),
        beforeScrollHeight,
        beforeBottom: beforeBottom == null ? null : Math.round(beforeBottom),
      });
      if (
        !scroller ||
        scroller.dataset.cardbushPreserveScroll === '1' ||
        scrollbarDragActiveRef.current ||
        Date.now() < scrollbarDragUntilRef.current ||
        Date.now() < manualScrollDetachUntilRef.current ||
        userDetachedFromBottomRef.current ||
        !autoFollowStreamRef.current
      ) {
        return;
      }
      if (outerResizeFollowFrameRef.current != null) {
        window.cancelAnimationFrame(outerResizeFollowFrameRef.current);
      }
      outerResizeFollowFrameRef.current = window.requestAnimationFrame(() => {
        outerResizeFollowFrameRef.current = null;
        if (
          scroller.dataset.cardbushPreserveScroll === '1' ||
          scrollbarDragActiveRef.current ||
          Date.now() < scrollbarDragUntilRef.current ||
          Date.now() < manualScrollDetachUntilRef.current ||
          userDetachedFromBottomRef.current ||
          !autoFollowStreamRef.current
        ) {
          captureScrollGeometry('trace-outer-resize-follow-abort');
          return;
        }
        const preparedStage = scroller.querySelector<HTMLElement>(
          '.message-list-item.assistant-render-stage',
        );
        const preparedMessageId = preparedStage?.dataset.messageId ?? '';
        if (preparedMessageId) {
          ensureMessageBottomVisible(preparedMessageId);
          lastScrollTopRef.current = scroller.scrollTop;
          setScrollBottomVisible(false);
          captureScrollGeometry('trace-outer-resize-follow', {
            strategy: 'assistant-render-stage',
            preparedMessageId,
            scrollTopBeforeCorrection: Math.round(scroller.scrollTop),
          });
          return;
        }
        const scrollTopBeforeCorrection = scroller.scrollTop;
        const targetScrollTop = absoluteBottomScrollTop(scroller);
        if (Math.abs(targetScrollTop - scrollTopBeforeCorrection) > 0.5) {
          programmaticScrollUntilRef.current = Date.now() + 520;
          scroller.scrollTo({
            top: targetScrollTop,
            behavior: gentleAutoFollowScrollBehavior(),
          });
        }
        lastScrollTopRef.current = scroller.scrollTop;
        atBottomRef.current = true;
        setScrollBottomVisible(false);
        captureScrollGeometry('trace-outer-resize-follow', {
          scrollTopBeforeCorrection: Math.round(scrollTopBeforeCorrection),
          targetScrollTop: Math.round(targetScrollTop),
          correction: Math.round(targetScrollTop - scrollTopBeforeCorrection),
        });
      });
    });
    observed.forEach((element) => observer.observe(element));
    return () => {
      observer.disconnect();
      if (outerResizeFollowFrameRef.current != null) {
        window.cancelAnimationFrame(outerResizeFollowFrameRef.current);
        outerResizeFollowFrameRef.current = null;
      }
    };
  }, [
    captureScrollGeometry,
    ensureMessageBottomVisible,
    loading,
    setScrollBottomVisible,
    showWelcome,
  ]);

  useEffect(() => {
    return () => {
      if (streamScrollFrameRef.current != null) {
        window.cancelAnimationFrame(streamScrollFrameRef.current);
      }
      if (outerResizeFollowFrameRef.current != null) {
        window.cancelAnimationFrame(outerResizeFollowFrameRef.current);
      }
      for (const timer of userMessageEntryTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      userMessageEntryTimersRef.current.clear();
      listScrollerWheelCleanupRef.current?.();
      listScrollerWheelCleanupRef.current = null;
      scrollBottomWheelCleanupRef.current?.();
      scrollBottomWheelCleanupRef.current = null;
    };
  }, []);

  useEffect(() => {
    const previous = messageSnapshotRef.current;
    const ids = renderMessages.map((message) => message.id);
    const previousIds = previous.conversationId === activeConversationId
      ? new Set(previous.ids)
      : new Set<string>();
    let submittedUserIndex = -1;
    for (let index = renderMessages.length - 1; index >= 0; index -= 1) {
      const message = renderMessages[index];
      if (message?.role === 'user' && !previousIds.has(message.id)) {
        submittedUserIndex = index;
        break;
      }
    }
    if (
      submittedUserIndex >= 0 &&
      Date.now() <= pendingSubmittedUserEntryUntilRef.current
    ) {
      const messageId = renderMessages[submittedUserIndex].id;
      pendingSubmittedUserEntryUntilRef.current = 0;
      setEnteringUserMessageIds((current) => {
        if (current.has(messageId)) return current;
        const next = new Set(current);
        next.add(messageId);
        return next;
      });
      const previousTimer = userMessageEntryTimersRef.current.get(messageId);
      if (previousTimer != null) window.clearTimeout(previousTimer);
      userMessageEntryTimersRef.current.set(
        messageId,
        window.setTimeout(() => {
          userMessageEntryTimersRef.current.delete(messageId);
          setEnteringUserMessageIds((current) => {
            if (!current.has(messageId)) return current;
            const next = new Set(current);
            next.delete(messageId);
            return next;
          });
        }, 260),
      );
    }
    if (previous.conversationId !== activeConversationId) {
      autoFollowStreamRef.current = true;
      userDetachedFromBottomRef.current = false;
      manualScrollDetachUntilRef.current = 0;
      atBottomRef.current = true;
      setScrollBottomVisible(false);
      messageSnapshotRef.current = { conversationId: activeConversationId, ids };
      if (
        renderMessages.length > 0 &&
        (pendingSubmittedUserFocusRef.current || sending)
      ) {
        for (let index = renderMessages.length - 1; index >= 0; index -= 1) {
          if (renderMessages[index]?.role === 'user') {
            focusSubmittedUserMessage(index, renderMessages[index].id);
            break;
          }
        }
      }
      return;
    }
    if (
      submittedUserIndex >= 0 &&
      (pendingSubmittedUserFocusRef.current ||
        (sending &&
          renderMessages.length > previous.ids.length &&
          !userDetachedFromBottomRef.current))
    ) {
      focusSubmittedUserMessage(
        submittedUserIndex,
        renderMessages[submittedUserIndex].id,
      );
    }
    messageSnapshotRef.current = { conversationId: activeConversationId, ids };
  }, [
    activeConversationId,
    focusSubmittedUserMessage,
    renderMessages,
    sending,
    setScrollBottomVisible,
  ]);

  useEffect(() => {
    setActiveScene(null);
    setAvailableScene(null);
    setActiveSceneInitialAutoPlay(false);
    activeSceneKeyRef.current = '';
    activeSceneRevisionRef.current = '';
  }, [activeConversationId]);

  useEffect(() => {
    const receiveSceneEvent = (event: Event) => {
      if (!(event instanceof CustomEvent) || !event.detail || typeof event.detail !== 'object') {
        return;
      }
      const detail = event.detail as Record<string, unknown>;
      const sessionId = String(detail.sessionId ?? detail.session_id ?? '').trim();
      const sceneId = String(detail.sceneId ?? detail.scene_id ?? '').trim();
      const type = String(detail.type ?? '');
      if (!sceneId || sessionId !== activeConversationId) return;
      if (type === 'scene_closed') {
        setAvailableScene((current) => current?.sceneId === sceneId ? null : current);
        setActiveScene((current) => current?.sceneId === sceneId ? null : current);
        return;
      }
      // Scene content is restored from streamed Runtime artifacts below. This
      // event only carries lifecycle identity and never triggers another service.
    };
    window.addEventListener('cardbush:scene-event', receiveSceneEvent);
    return () => window.removeEventListener('cardbush:scene-event', receiveSceneEvent);
  }, [activeConversationId]);

  useEffect(() => {
    const latestScene = latestCardlingSceneFromMessages(renderMessages);
    if (!latestScene) {
      return;
    }
    const key = cardlingSceneKey(latestScene);
    setAvailableScene(latestScene);
    if (activeSceneKeyRef.current === key) {
      showScene(latestScene);
      return;
    }
    const sceneTurnId = latestScene.turnId?.trim() ?? '';
    const currentTurnId = activeTurnId.trim();
    if (!sending || !sceneTurnId || !currentTurnId || sceneTurnId !== currentTurnId) {
      return;
    }
    if (dismissedSceneKeysRef.current.has(key)) {
      return;
    }
    showScene(latestScene, { autoPlay: true });
  }, [activeTurnId, renderMessages, sending, showScene]);

  useEffect(() => {
    if (
      loading ||
      showWelcome ||
      !sending ||
      !autoFollowStreamRef.current
    ) {
      return;
    }
    const activeAssistant =
      streamingAssistantMessage(renderMessages, activeTurnId) ??
      lastAssistantMessage(renderMessages);
    if (!activeAssistant) {
      return;
    }
    scheduleActiveAssistantFollow(
      activeAssistant.message.id,
      activeAssistant.index,
    );
  }, [
    activeTurnId,
    loading,
    renderMessages,
    scheduleActiveAssistantFollow,
    sending,
    showWelcome,
  ]);

  const activeAssistantForRender =
    streamingAssistantMessage(renderMessages, activeTurnId) ??
    (sending ? lastAssistantMessage(renderMessages) : null);

  const applyQuickLoad = useCallback(
    (payload: QuickLoadPayload) => {
      const loaded = quickPayloadText(payload);
      if (!loaded) {
        return;
      }
      const next = draft.trim()
        ? `${draft.trimEnd()}\n${loaded}`
        : loaded;
      onDraftChange(next);
    },
    [draft, onDraftChange],
  );

  const editQueuedMessage = useCallback(
    (item: QueuedChatMessage) => {
      onRemoveQueuedMessage(item.id);
      const next = draft.trim()
        ? `${draft.trimEnd()}\n${item.text.trim()}`
        : item.text;
      onDraftChange(next);
    },
    [draft, onDraftChange, onRemoveQueuedMessage],
  );

  const forceListToVisualBottom = useCallback(() => {
    const scroller = listScrollerRef.current;
    if (!scroller) {
      return;
    }
    scroller.scrollTop = visualBottomScrollTop(
      scroller,
      quickContextBottomInset,
      streamStatusHeight,
    );
  }, [composerDockHeight, streamStatusHeight]);

  const jumpToLatestMessage = useCallback(
    (_reason: string) => {
      cancelScheduledStreamFollow();
      scrollTraceSequenceRef.current += 1;
      activeScrollTraceIdRef.current = `${Date.now().toString(36)}-${scrollTraceSequenceRef.current}`;
      scrollTraceObserveUntilRef.current = Date.now() + 3000;
      captureScrollGeometry('trace-jump-start', { reason: _reason });
      programmaticScrollUntilRef.current = Date.now() + 500;
      manualScrollDetachUntilRef.current = 0;
      autoFollowStreamRef.current = true;
      userDetachedFromBottomRef.current = false;
      pendingSubmittedUserFocusRef.current = false;
      atBottomRef.current = true;
      lastWheelLockRef.current = null;
      setScrollBottomVisible(false);

      forceListToVisualBottom();
      streamScrollFrameRef.current = window.requestAnimationFrame(() => {
        streamScrollFrameRef.current = null;
        if (userDetachedFromBottomRef.current) {
          captureScrollGeometry('trace-jump-abort', {
            reason: 'user-detached',
          });
          return;
        }
        forceListToVisualBottom();
        atBottomRef.current = true;
        setScrollBottomVisible(false);
        captureScrollGeometry('trace-jump-complete', {
          strategy: 'native-message-list',
        });
      });
    },
    [
      cancelScheduledStreamFollow,
      captureScrollGeometry,
      forceListToVisualBottom,
      setScrollBottomVisible,
    ],
  );

  const scrollToBottom = useCallback(() => {
    if (messages.length === 0) {
      return;
    }
    jumpToLatestMessage('scroll-bottom-button');
  }, [jumpToLatestMessage, messages.length]);

  useEffect(() => {
    if (loading || showWelcome || messages.length === 0) {
      return;
    }
    const conversationKey = activeConversationId.trim() || '__new__';
    const latestMessageId = messages[messages.length - 1]?.id ?? '';
    if (!latestMessageId) {
      return;
    }
    const previous = latestConversationScrollRef.current;
    if (previous.conversationId === conversationKey) {
      return;
    }
    latestConversationScrollRef.current = {
      conversationId: conversationKey,
      latestMessageId,
    };
    jumpToLatestMessage('session-enter');
  }, [
    activeConversationId,
    jumpToLatestMessage,
    loading,
    messages,
    showWelcome,
  ]);

  const setListScrollerRef = useCallback(
    (ref: HTMLElement | Window | null) => {
      listScrollerWheelCleanupRef.current?.();
      listScrollerWheelCleanupRef.current = null;
      const nextScroller = ref instanceof HTMLElement ? ref : null;
      listScrollerRef.current = nextScroller;
      if (!nextScroller) {
        return;
      }
      lastScrollTopRef.current = nextScroller.scrollTop;
      const handleNativeWheel = (event: globalThis.WheelEvent) => {
        if (event.defaultPrevented || wheelAlreadyHandled(event)) {
          return;
        }
        lastWheelEventAtRef.current = Date.now();
        if (event.deltaY !== 0) {
          releaseAssistantStageReservation();
        }
        if (releaseWheelBottomFreeze(event)) {
          markWheelHandled(event);
          return;
        }
        if (lockNativeWheelDownAtBottom('native-list', event)) {
          markWheelHandled(event);
        }
      };
      nextScroller.addEventListener('wheel', handleNativeWheel, {
        capture: true,
        passive: false,
      });
      listScrollerWheelCleanupRef.current = () => {
        nextScroller.removeEventListener('wheel', handleNativeWheel, {
          capture: true,
        });
      };
    },
    [
      lockNativeWheelDownAtBottom,
      markWheelHandled,
      releaseAssistantStageReservation,
      releaseWheelBottomFreeze,
      wheelAlreadyHandled,
    ],
  );

  const setScrollBottomRef = useCallback(
    (ref: HTMLButtonElement | null) => {
      scrollBottomWheelCleanupRef.current?.();
      scrollBottomWheelCleanupRef.current = null;
      scrollBottomButtonRef.current = ref;
      if (!ref) {
        return;
      }
      const handleNativeWheel = (event: globalThis.WheelEvent) => {
        if (event.defaultPrevented || wheelAlreadyHandled(event)) {
          return;
        }
        lastWheelEventAtRef.current = Date.now();
        if (event.deltaY !== 0) {
          releaseAssistantStageReservation();
        }
        if (releaseWheelBottomFreeze(event)) {
          markWheelHandled(event);
          return;
        }
        if (lockNativeWheelDownAtBottom('native-scroll-bottom-hotzone', event)) {
          markWheelHandled(event);
        }
      };
      ref.addEventListener('wheel', handleNativeWheel, {
        capture: true,
        passive: false,
      });
      scrollBottomWheelCleanupRef.current = () => {
        ref.removeEventListener('wheel', handleNativeWheel, {
          capture: true,
        });
      };
    },
    [
      lockNativeWheelDownAtBottom,
      markWheelHandled,
      releaseAssistantStageReservation,
      releaseWheelBottomFreeze,
      wheelAlreadyHandled,
    ],
  );

  const handleComposerSend = useCallback(
    async (text: string) => {
      if (
        sending &&
        guidanceDeliveryMode === 'immediate' &&
        activeTurnId
      ) {
        const guidanceAnchor: ChatMessage = {
          ...(activeAssistantForRender?.message ?? {
            id: `active-turn-${activeTurnId}`,
            role: 'assistant',
            content: '',
            createdAt: new Date().toISOString(),
          }),
          conversationId: activeConversationId,
          turnId: activeTurnId,
        };
        await onGuideMessage(
          guidanceAnchor,
          text,
          'append_context',
        );
        return;
      }
      if (!sending) {
        pendingSubmittedUserEntryUntilRef.current = Date.now() + 2000;
        const shouldFollowSubmission =
          !showScrollBottomRef.current || !userDetachedFromBottomRef.current;
        pendingSubmittedUserFocusRef.current = shouldFollowSubmission;
        setAssistantStageReservationActive(shouldFollowSubmission);
        if (shouldFollowSubmission) {
          programmaticScrollUntilRef.current = Date.now() + 1200;
          autoFollowStreamRef.current = true;
          userDetachedFromBottomRef.current = false;
          setScrollBottomVisible(false);
        }
      }
      await onSend(text);
    },
    [
      activeAssistantForRender,
      activeConversationId,
      activeTurnId,
      guidanceDeliveryMode,
      onGuideMessage,
      onSend,
      sending,
      setScrollBottomVisible,
    ],
  );

  const [workSummaryVisible, setWorkSummaryVisible] = useState(false);
  const [workSummaryAnchorRight, setWorkSummaryAnchorRight] = useState(12);
  const openChangeReview = useCallback((filePath?: string) => {
    onOpenChangeReview(filePath);
  }, [onOpenChangeReview]);
  const chatBodyStyle = {
    '--composer-dock-height': `${composerDockHeight}px`,
    '--quick-context-bottom-inset': `${quickContextBottomInset}px`,
    '--stream-status-height': `${streamStatusHeight}px`,
    '--work-summary-anchor-right': `${workSummaryAnchorRight}px`,
  } as CSSProperties;
  const showWorkSummary = workSummaryVisible;
  const workSummaryPresence = useSoftPanelPresence(showWorkSummary);
  const updateRestoredWorkSummaryAnchor = useCallback((anchor?: HTMLElement | null) => {
    if (windowMaximized) return;
    const chatBody = chatBodyRef.current;
    const toggle = anchor ?? chatBody
      ?.closest('.chat-panel')
      ?.querySelector<HTMLElement>('[data-work-summary-toggle]');
    if (!chatBody || !toggle) return;
    const bodyBounds = chatBody.getBoundingClientRect();
    const toggleBounds = toggle.getBoundingClientRect();
    const summaryWidth = Math.min(336, Math.max(0, bodyBounds.width - 24));
    const maximumRight = Math.max(12, bodyBounds.width - summaryWidth - 12);
    setWorkSummaryAnchorRight(Math.min(
      maximumRight,
      Math.max(12, Math.round(bodyBounds.right - toggleBounds.right)),
    ));
  }, [windowMaximized]);
  useEffect(() => {
    if (!showWorkSummary || windowMaximized) return undefined;
    const refreshAnchor = () => updateRestoredWorkSummaryAnchor();
    refreshAnchor();
    window.addEventListener('resize', refreshAnchor);
    return () => window.removeEventListener('resize', refreshAnchor);
  }, [showWorkSummary, updateRestoredWorkSummaryAnchor, windowMaximized]);
  useEffect(() => {
    if (!showWorkSummary || windowMaximized) {
      return undefined;
    }
    const closeRestoredSummary = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      if (
        target.closest('.conversation-work-summary') ||
        target.closest('[data-work-summary-toggle]') ||
        target.closest('[data-change-review-toggle]') ||
        target.closest('.right-inspector')
      ) {
        return;
      }
      setWorkSummaryVisible(false);
    };
    const closeRestoredSummaryWithKeyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setWorkSummaryVisible(false);
      }
    };
    document.addEventListener('pointerdown', closeRestoredSummary);
    document.addEventListener('keydown', closeRestoredSummaryWithKeyboard);
    return () => {
      document.removeEventListener('pointerdown', closeRestoredSummary);
      document.removeEventListener('keydown', closeRestoredSummaryWithKeyboard);
    };
  }, [showWorkSummary, windowMaximized]);
  useEffect(() => {
    setWorkSummaryVisible(false);
  }, [activeConversationId]);
  if (import.meta.env.DEV && isComposerRuntimePreTestEnabled()) {
    return <ComposerRuntimePreTest language={language} />;
  }

  if (import.meta.env.DEV && isLoopHistoryPreTestEnabled()) {
    return <LoopHistoryPreTest language={language} />;
  }

  if (import.meta.env.DEV && isQuickContextPreTestEnabled()) {
    return <QuickContextPreTest language={language} />;
  }

  if (import.meta.env.DEV && LazyRuntimeStreamPreTest && isRuntimeStreamPreTestEnabled()) {
    return (
      <Suspense fallback={null}>
        <LazyRuntimeStreamPreTest
          language={language}
          mode={runtimeStreamPreTestMode() ?? 'fixture'}
          modelConfig={selectedModelConfig}
        />
      </Suspense>
    );
  }

  return (
    <div
      className={`chat-panel${sidebarCollapsed ? ' sidebar-collapsed' : ''}${!workSummaryPresence.mounted ? ' work-summary-hidden' : ' work-summary-requested'}${windowMaximized ? ' window-maximized' : ' window-restored'}`}
    >
      <TopBar
        title={title}
        sidebarCollapsed={sidebarCollapsed}
        language={language}
        conversationContentAvailable={renderMessages.length > 0}
        workSummaryVisible={showWorkSummary}
        reviewAvailable={changeReports.length > 0}
        onToggleWorkSummary={renderMessages.length > 0
          ? (anchor) => {
              if (showWorkSummary) {
                setWorkSummaryVisible(false);
                return;
              }
              updateRestoredWorkSummaryAnchor(anchor);
              setWorkSummaryVisible(true);
            }
          : undefined}
        onOpenReview={changeReports.length > 0 ? openChangeReview : undefined}
        onRevealSidebar={onRevealSidebar}
      />
      {notice && (
        <RuntimeStatusBanner
          language={language}
          tone="notice"
          message={notice}
          onDismiss={onClearNotice}
        />
      )}
      {(error || refreshError) && (
        <RuntimeStatusBanner
          language={language}
          tone="error"
          message={error || refreshError}
          actionLabel={language === 'zh' ? '重试' : 'Retry'}
          onAction={async () => {
            await refreshBackendWithFeedback({ silent: false });
            onClearError();
          }}
          onDismiss={() => {
            setRefreshError('');
            onClearError();
          }}
        />
      )}
      <div
        className="chat-body"
        ref={chatBodyRef}
        style={chatBodyStyle}
        onWheelCapture={handleChatBodyWheelCapture}
      >
        {!loading && workSummaryPresence.mounted && (
          <ConversationWorkSummary
            language={language}
            sessionId={activeConversationId}
            messages={renderMessages}
            changeReports={changeReports}
            onOpenChangeReview={openChangeReview}
            subagentObservabilityAvailable={subagentObservabilityAvailable}
            softVisible={workSummaryPresence.visible}
          />
        )}
        {!loading && !showWelcome && (
          <QuickContextRail
            language={language}
            messages={renderMessages}
            draft={draft}
            sessionId={activeConversationId}
            serverSearchAvailable={contextSearchAvailable}
          />
        )}
        <div className="chat-content-frame">
        {loading ? (
          <BackendLoading language={language} history={historyLoading} />
        ) : showWelcome ? (
          <WelcomeComposer
            key={activeConversationId || 'new-session'}
            language={language}
            onlyTalkMode={onlyTalkMode}
            draft={draft}
            onDraftChange={onDraftChange}
            sending={sending}
            stopping={stopping}
            guidanceDeliveryMode={guidanceDeliveryMode}
            cancelEnabled={Boolean(activeTurnId)}
            queuedMessageCount={queuedMessageCount}
            queuedMessagePreview={queuedMessagePreview}
            queuedMessages={queuedMessages}
            selectedModel={selectedModel}
            availableModels={availableModels}
            goalAvailable={goalAvailable}
            referencePlanAvailable={referencePlanAvailable}
            referencePlanMode={referencePlanMode}
            permissionMode={permissionMode}
            subagentPermissionRouting={subagentPermissionRouting}
            reasoningLevelAvailable={reasoningLevelAvailable}
            reasoningLevel={reasoningLevel}
            reasoningLevels={reasoningLevels}
            onModelChange={onModelChange}
            onReferencePlanModeChange={onReferencePlanModeChange}
            onPermissionModeChange={onPermissionModeChange}
            onSubagentPermissionRoutingChange={onSubagentPermissionRoutingChange}
            onReasoningLevelChange={onReasoningLevelChange}
            onConfigureModels={onConfigureModels}
            onCreateConversation={onCreateConversation}
            activeProjectDir={activeProjectDir}
            selectedProjectDir={selectedProjectDir}
            availableProjects={availableProjects}
            onProjectChange={onWelcomeProjectChange}
            projectContext={projectContext}
            skills={skills}
            disabledSkillNames={disabledSkillNames}
            visualInputAvailable={visualInputAvailable}
            visualInputEnabled={visualInputEnabled}
            gitAvailable={gitAvailable}
            onToggleSkill={onToggleSkill}
            onVisualInputEnabledChange={onVisualInputEnabledChange}
            onSaveProjectContext={onSaveProjectContext}
            onEditQueuedMessage={editQueuedMessage}
            onGuideQueuedMessage={(queuedId) =>
              onGuideQueuedMessage(queuedId, 'append_context')
            }
            onRemoveQueuedMessage={onRemoveQueuedMessage}
            onSend={handleComposerSend}
            onCancel={onCancel}
          />
        ) : (
          <div
            key={activeConversationId.trim() || 'new-session'}
            className="message-list"
            ref={setListScrollerRef}
            onWheelCapture={handleListWheelCapture}
            onPointerDownCapture={handleListPointerDownCapture}
            onTouchStartCapture={() => markUserDetachedFromBottom('touch')}
            onScrollCapture={handleListScrollCapture}
          >
            <MessageFileReferenceScope
              workspaceRoot={activeProjectDir}
              pathAliases={projectPathAliases}
            >
              <div className="message-list-content">
                {renderMessages.map((message, index) => (
                  <div
                    key={message.id}
                    className={`message-list-item${index === 0 ? ' first' : ''}${
                      message.role === 'user' && (
                        enteringUserMessageIds.has(message.id) ||
                        pendingSubmittedUserEntryMessageId === message.id
                      )
                        ? ' user-message-entering'
                        : ''
                    }${
                      sending &&
                      assistantStageReservationActive &&
                      message.role === 'assistant' &&
                      activeAssistantForRender?.message.id === message.id
                        ? ' assistant-render-stage'
                        : ''
                    }`}
                    data-message-id={message.id}
                    data-message-role={message.role}
                  >
                    <MessageBubble
                      key={message.id}
                      message={message}
                      language={language}
                      sending={sending}
                      activeTurnId={activeTurnId}
                      activeAssistantMessageId={
                        activeAssistantForRender?.message.id ?? ''
                      }
                      selectedModel={selectedModelConfig?.modelName ?? selectedModel}
                      goalObjective={activeGoal?.objective ?? ''}
                      onRegenerate={onRegenerate}
                      onEditUserMessage={onEditUserMessage}
                      onRetryMessage={onRetryMessage}
                      onRetryGuidance={onRetryGuidance}
                      onRevertChangeReport={onRevertChangeReport}
                      onOpenChangeReview={openChangeReview}
                      onOpenScene={openScene}
                      onAssistantFeedback={recordAssistantLogicFeedback}
                    />
                  </div>
                ))}
                {connectionRecovery && connectionRecovery.state !== 'recovered' && (
                  <ConversationConnectionNotice
                    language={language}
                    update={connectionRecovery}
                  />
                )}
              </div>
            </MessageFileReferenceScope>
            <MessageListFooter />
          </div>
        )}
        {activeScene && (
          <CardlingSceneHost
            scene={activeScene}
            language={language}
            initialAutoPlay={activeSceneInitialAutoPlay}
            llmRunning={sending}
            activeTurnId={activeTurnId}
            onSendFeedbackToLlm={onSend}
            onClose={closeScene}
          />
        )}
        {!activeScene && availableScene && !loading && (
          <button
            className="scene-reopen-button"
            type="button"
            onClick={() => openScene(availableScene)}
            title={language === 'zh' ? '继续交互场景' : 'Continue interactive scene'}
          >
            <Sparkles size={15} />
            <span>{language === 'zh' ? '继续场景' : 'Scene'}</span>
          </button>
        )}
        {!showWelcome && pendingInteraction && (
          <div
            className="composer-dock interaction-only permission-only"
            ref={composerDockRef}
          >
            <InteractionCard
              language={language}
              interaction={pendingInteraction}
              onReply={onReplyInteraction}
              onCancel={onCancelInteraction}
            />
          </div>
        )}
        {!showWelcome && !loading && !pendingInteraction && (
          <div
            className={`composer-dock${
              sending || activeGoal || currentTurnChangeSummary || queuedMessageCount > 0
                ? ' runtime-attached'
                : ''
            }`}
            ref={composerDockRef}
            style={{
              '--shadow-accent': shadowAccentColor,
            } as CSSProperties}
          >
            {(sending || activeGoal || currentTurnChangeSummary || queuedMessageCount > 0) && (
              <LiveComposerRuntimeRail
                activeConversationId={activeConversationId}
                thinkingVisible={thinkingVisible}
                language={language}
                running={sending || (activeGoal?.status === 'active' && !goalWaiting)}
                stopping={stopping}
                taskPlan={activeTaskPlan}
                goal={activeGoal}
                goalRounds={activeGoalRounds}
                goalCancelling={goalCancelling}
                goalWaiting={goalWaiting}
                changeReports={currentTurnChangeReports}
                changeSummary={currentTurnChangeSummary}
                queuedMessageCount={queuedMessageCount}
                queuedMessagePreview={queuedMessagePreview}
                queuedMessages={queuedMessages}
                onCancelGoal={onCancelGoal}
                onOpenChangeReview={openChangeReview}
                onEditQueuedMessage={editQueuedMessage}
                onGuideQueuedMessage={(queuedId) =>
                  onGuideQueuedMessage(queuedId, 'append_context')
                }
                onRemoveQueuedMessage={onRemoveQueuedMessage}
                onReorderQueuedMessage={onReorderQueuedMessage}
              />
            )}
            <Composer
              key={activeConversationId || 'active-session'}
              compact
              language={language}
              draft={draft}
              onDraftChange={onDraftChange}
              sending={sending}
              stopping={stopping}
              guidanceDeliveryMode={guidanceDeliveryMode}
              cancelEnabled={Boolean(activeTurnId)}
              queuedMessageCount={0}
              queuedMessagePreview=""
              queuedMessages={[]}
              selectedModel={selectedModel}
              availableModels={availableModels}
              goalAvailable={goalAvailable}
              referencePlanAvailable={referencePlanAvailable}
              referencePlanMode={referencePlanMode}
              permissionMode={permissionMode}
              subagentPermissionRouting={subagentPermissionRouting}
              reasoningLevelAvailable={reasoningLevelAvailable}
              reasoningLevel={reasoningLevel}
              reasoningLevels={reasoningLevels}
              onModelChange={onModelChange}
              onReferencePlanModeChange={onReferencePlanModeChange}
              onPermissionModeChange={onPermissionModeChange}
              onSubagentPermissionRoutingChange={onSubagentPermissionRoutingChange}
              onReasoningLevelChange={onReasoningLevelChange}
              onSend={handleComposerSend}
              onCancel={onCancel}
              shadowActive={false}
              shadowAvailable={shadowCanActivate}
              shadowAgentName={language === 'zh' ? '新窗口' : 'New window'}
              onToggleShadow={shadowCanActivate ? openShadowPopup : undefined}
              contextWindow={{
                usedTokens: contextWindowUsage?.usedTokens,
                maxTokens: contextWindowUsage
                  ? contextWindowUsage.maxTokens
                  : contextWindowMaxTokens,
                remainingTokens: contextWindowUsage?.remainingTokens,
                measuredAt: contextWindowUsage?.measuredAt,
              }}
              skills={skills}
              disabledSkillNames={disabledSkillNames}
              visualInputAvailable={visualInputAvailable}
              visualInputEnabled={visualInputEnabled}
              gitAvailable={gitAvailable}
              onToggleSkill={onToggleSkill}
              onVisualInputEnabledChange={onVisualInputEnabledChange}
              activeProjectDir={activeProjectDir}
              projectContext={projectContext}
              onQuickLoad={applyQuickLoad}
              onSaveProjectContext={onSaveProjectContext}
              onConfigureModels={onConfigureModels}
              onCreateConversation={onCreateConversation}
            />
          </div>
        )}
        </div>
        <button
          ref={setScrollBottomRef}
          className={`scroll-bottom ${
            loading || showWelcome || !showScrollBottom ? 'hidden' : ''
          }`}
          type="button"
          aria-label="scroll bottom"
          onWheelCapture={handleScrollBottomWheelCapture}
          onClick={scrollToBottom}
        >
          <ArrowDown size={16} strokeWidth={1.8} />
        </button>
      </div>
    </div>
  );
}
