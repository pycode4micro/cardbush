import { ArrowDown, Sparkles } from 'lucide-react';
import { ComposerReferenceContext } from '../composer/ComposerReferenceContext';
import { ExtractionSelector } from './ConversationExtraction';
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type UIEvent,
  type KeyboardEvent as ReactKeyboardEvent,
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
import { type ExperimentalGoal } from '../../backend/api';
import type { QueuedChatMessage } from '../../hooks/useCardbushChat';
import {
  normalizeChatMessagesForDisplay,
  normalizeActiveTurnTranscriptForDisplay,
} from '../chatMessages/transcript/messageProjection';
import { useSoftPanelPresence } from '../../hooks/useSoftPanelPresence';
import { useBatchedTranscript } from '../chatMessages/useBatchedTranscript';
import { isGuidanceSealedAssistantSegment, isTurnGuidanceMessage } from '../chatMessages/transcript/messageFacts';
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
  type ScrollBottomMetrics,
} from '../chatScroll';
import {
  MessageBubble,
  MessageFileReferenceScope,
  projectRenderableChatMessages,
} from '../chatMessages';
import { QuickContextRail } from './QuickContextRail';
import { createChatScrollMotion } from './chatScrollMotion';
import { submittedUserReadingOffset, updateResponseSpacer } from './responseSpacer';
import {
  captureConversationScrollPosition,
  restoreConversationScrollPosition,
  type ConversationScrollPosition,
} from './conversationScrollPosition';
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
  type ComposerRuntimeRailHandle,
} from '../composer';
import { summarizeChangeReports, type ConversationChangeReport } from '../tools';
import { recentReviewTurns } from '../sidebar/reviewModel';
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
import { observeWindowScrollDiagnostics, recordWindowScrollDiagnostic, windowScrollDiagnosticsActive } from './windowScrollDiagnostics';
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

function scrollDebugEnabled() {
  try {
    // Detailed scroll traces are intentionally session-scoped. A persisted
    // localStorage switch previously left synchronous IPC logging enabled in
    // ordinary GUI runs long after the original diagnosis had finished.
    return window.sessionStorage.getItem('cardbush_scroll_debug') === 'true';
  } catch {
    return false;
  }
}

function scrollDebug(label: string, data: Record<string, unknown>) {
  recordWindowScrollDiagnostic(label, data);
  if (!scrollDebugEnabled()) return;
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

export function ChatPanel({
  browserTabs = [],
  language,
  theme,
  title,
  sidebarCollapsed,
  windowMaximized,
  inspectorOpen,
  onToggleInspector,
  activeConversationId,
  activeProjectDir,
  projectPathAliases,
  selectedProjectDir,
  availableProjects,
  onWelcomeProjectChange,
  messages,
  transcriptDelivery = 'frame',
  activeGoal,
  goalAvailable,
  teamAvailable = false,
  goalCancelling,
  goalWaiting,
  changeReports,
  skills,
  disabledSkillNames,
  contextSearchAvailable,
  subagentObservabilityAvailable,
  shadowAvailable,
  shadowAccentColor,
  shadowThemeVariables,
  thinkingVisible,
  guidanceDeliveryMode,
  loading: backgroundLoading,
  historyLoading,
  sending,
  stopping,
  activeTurnId,
  connectionRecovery,
  queuedMessageCount,
  queuedMessagePreview,
  queuedMessages,
  pendingInteraction: suppliedPendingInteraction,
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
  onModelChange,
  onReferencePlanModeChange,
  onPermissionModeChange,
  onSubagentPermissionRoutingChange,
  onReasoningLevelChange,
  onConfigureModels,
  onCreateConversation,
  onOpenConversation,
  onToggleSkill,
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
  browserTabs?: import('../../shared/promptReferences').BrowserPromptReference[];
  language: AppLanguage;
  theme: ThemeMode;
  title: string;
  sidebarCollapsed: boolean;
  windowMaximized: boolean;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  activeConversationId: string;
  activeProjectDir?: string;
  projectPathAliases: Array<{ from: string; to: string }>;
  selectedProjectDir: string;
  availableProjects: ProjectItem[];
  onWelcomeProjectChange: (projectDir: string | null, reference?: string) => Promise<void>;
  messages: ChatMessage[];
  /** Opt-in display scheduling for the isolated streaming lab. */
  transcriptDelivery?: 'batched' | 'frame';
  activeGoal: ExperimentalGoal | null;
  goalAvailable: boolean;
  teamAvailable?: boolean;
  goalCancelling: boolean;
  goalWaiting: boolean;
  changeReports: ConversationChangeReport[];
  skills: SkillSummary[];
  disabledSkillNames: Set<string>;
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
  onModelChange: (value: string) => void;
  onReferencePlanModeChange: (value: ReferencePlanMode) => void;
  onPermissionModeChange: (value: PermissionMode) => void;
  onSubagentPermissionRoutingChange: (value: SubagentPermissionRouting) => void;
  onReasoningLevelChange: (value: ReasoningLevel) => void;
  onConfigureModels: () => void;
  onCreateConversation: () => void;
  onOpenConversation: (conversationId: string) => void;
  onToggleSkill: (skillName: string, enabled: boolean) => void;
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
  const pendingInteraction = suppliedPendingInteraction?.sessionId === activeConversationId
    ? suppliedPendingInteraction : null;
  const chatPanelRenderStartedAt = performance.now();
  useLayoutEffect(() => {
    recordUiPerformanceMetric('chat_panel_commit_ms', {
      sessionId: activeConversationId,
      value: performance.now() - chatPanelRenderStartedAt,
    });
  });
  const reversibleTurnIds = useMemo(() => new Set(recentReviewTurns(messages).map(turn => turn.id)), [messages]);
  const visibleMessages = useBatchedTranscript(messages, activeConversationId, activeTurnId, sending,
    stopping || Boolean(pendingInteraction) || Boolean(error) || goalWaiting, transcriptDelivery);
  const renderMessages = useMemo(() => {
    const normalized = normalizeChatMessagesForDisplay(visibleMessages);
    const activeTranscript = sending
      ? normalizeActiveTurnTranscriptForDisplay(normalized, activeTurnId)
      : normalized;
    return projectRenderableChatMessages(activeTranscript);
  }, [activeTurnId, visibleMessages, sending]);
  const lastAssistantByTurn = useMemo(() => {
    const latest = new Map<string, string>();
    for (const message of renderMessages) if (message.role === 'assistant' && message.turnId) latest.set(message.turnId, message.id);
    return latest;
  }, [renderMessages]);
  const completedGuidanceTurnMessages = useMemo(() => {
    const byTurn = new Map<string, ChatMessage[]>();
    for (const message of renderMessages) {
      if (message.role !== 'assistant' || !message.turnId || (sending && message.turnId === activeTurnId)) continue;
      const group = byTurn.get(message.turnId) ?? [];
      group.push(message);
      byTurn.set(message.turnId, group);
    }
    return new Map([...byTurn.values()]
      .filter(group => group.some(isGuidanceSealedAssistantSegment))
      .map(group => [group[group.length - 1].id, group]));
  }, [renderMessages, sending, activeTurnId]);
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
  const activeAssistantForRender = useMemo(() => {
    if (!sending) return null;
    const active = streamingAssistantMessage(renderMessages, activeTurnId);
    if (active && !['completed', 'stopped', 'failed'].includes(active.message.status ?? '')) return active;
    const latest = lastAssistantMessage(renderMessages);
    // Admission is marked running before persistence appends optimistic rows.
    // Never reuse a finished response as the new turn's streaming placeholder.
    return latest?.message.metadata?.optimistic_request_id && !latest.message.turnId
      && !['completed', 'stopped', 'failed'].includes(latest.message.status ?? '') ? latest : null;
  }, [activeTurnId, renderMessages, sending]);
  const activeRuntimeAssistant = useMemo(
    () => activeAssistantForRender?.message ?? null,
    [activeAssistantForRender],
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
  // Catalog/runtime startup is background work. Only an uncached, explicitly
  // selected conversation needs a history placeholder; keep mounted content on refresh.
  const loading = backgroundLoading && historyLoading && renderMessages.length === 0;
  const showWelcome = !loading && renderMessages.length === 0;
  const listScrollerRef = useRef<HTMLElement | null>(null);
  const chatBodyRef = useRef<HTMLDivElement>(null);
  const composerDockRef = useRef<HTMLDivElement>(null);
  const runtimeRailRef = useRef<ComposerRuntimeRailHandle>(null);
  const scrollBottomButtonRef = useRef<HTMLButtonElement>(null);
  const scrollMotion = useMemo(() => createChatScrollMotion(), []);
  const atBottomRef = useRef(true);
  const autoFollowStreamRef = useRef(true);
  const userDetachedFromBottomRef = useRef(false);
  const showScrollBottomRef = useRef(false);
  const pendingSubmittedUserFocusRef = useRef(false);
  const assistantStageAnchorRef = useRef('');
  const pendingSubmittedUserEntryUntilRef = useRef(0);
  const userMessageEntryTimersRef = useRef<Map<string, number>>(new Map());
  const programmaticScrollUntilRef = useRef(0);
  const manualScrollDetachUntilRef = useRef(0);
  const lastScrollTopRef = useRef(0);
  const lastWheelEventAtRef = useRef(0);
  const manualScrollDirectionRef = useRef(0);
  const handledWheelEventsRef = useRef<WeakSet<globalThis.WheelEvent>>(new WeakSet());
  const scrollbarDragActiveRef = useRef(false);
  const scrollbarDragUntilRef = useRef(0);
  const scrollBottomWheelCleanupRef = useRef<(() => void) | null>(null);
  const lastWheelLockRef = useRef<{
    at: number;
    source: string;
    scrollTop: number;
  } | null>(null);
  const conversationScrollPositionsRef = useRef(new Map<string, ConversationScrollPosition>());
  const scrollActivationRef = useRef<{
    scroller: HTMLElement;
    position: ConversationScrollPosition | undefined;
    restoring: boolean;
  } | null>(null);
  const scrollRestoreFrameRef = useRef<number | null>(null);
  const [scrollMountRevision, setScrollMountRevision] = useState(0);

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
  const outerResizeSizesRef = useRef(new WeakMap<Element, string>());
  const scrollTraceSequenceRef = useRef(0);
  const activeScrollTraceIdRef = useRef('');
  const scrollTraceObserveUntilRef = useRef(0);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
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
    if (showScrollBottomRef.current === visible) return;
    showScrollBottomRef.current = visible;
    setShowScrollBottom(visible);
  }, []);

  const releaseAssistantStageReservation = useCallback(() => {
    assistantStageAnchorRef.current = '';
    const scroller = listScrollerRef.current;
    if (scroller) updateResponseSpacer(scroller, '');
  }, []);

  const finishConversationScrollRestoration = useCallback(() => {
    const activation = scrollActivationRef.current;
    if (activation) {
      activation.restoring = false;
      delete activation.scroller.dataset.scrollRestoring;
    }
    if (scrollRestoreFrameRef.current != null) {
      window.cancelAnimationFrame(scrollRestoreFrameRef.current);
      scrollRestoreFrameRef.current = null;
    }
  }, []);

  useLayoutEffect(() => {
    if (!sending) {
      releaseAssistantStageReservation();
    }
  }, [sending, activeConversationId, scrollMountRevision, releaseAssistantStageReservation]);

  const readBottomMetrics = useCallback((scroller: HTMLElement): ScrollBottomMetrics => {
    const absoluteBottomDistance = absoluteBottomScrollTop(scroller) - scroller.scrollTop;
    const visualBottomDistance = absoluteBottomDistance;
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
  }, []);

  const captureScrollGeometry = useCallback(
    (label: string, extra: Record<string, unknown> = {}) => {
      // Disabled diagnostics must not force layout just to discard the result.
      if (!scrollDebugEnabled() && !windowScrollDiagnosticsActive()) return;
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
      const hideDistance = showScrollBottomRef.current ? 36 : scrollBottomLockTolerance;
      if (metrics.visualBottomDistance <= hideDistance || metrics.absoluteAtBottom) {
        return false;
      }
      // Far from the tail, no message geometry is needed on the scroll hot path.
      if (metrics.visualBottomDistance > scroller.clientHeight) return true;
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
      const footer = scroller.querySelector<HTMLElement>('.message-list-footer');
      const desiredTop = submittedUserReadingOffset(
        Math.max(0, scroller.clientHeight - (footer?.getBoundingClientRect().height ?? 0)),
        itemRect.height,
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
      scrollMotion.move(scroller, nextTop, 'submission');
    },
    [scrollMotion],
  );

  const focusSubmittedUserMessage = useCallback(
    (_index: number, messageId: string) => {
      const scroller = listScrollerRef.current;
      if (!scroller) return;
      pendingSubmittedUserFocusRef.current = false;
      programmaticScrollUntilRef.current = Date.now() + 1200;
      manualScrollDetachUntilRef.current = 0;
      autoFollowStreamRef.current = true;
      userDetachedFromBottomRef.current = false;
      setScrollBottomVisible(false);
      // Set geometry and scroll ownership in the same layout commit as the
      // optimistic message. Waiting two frames lets stream following jump first.
      positionMessageAtReadingAnchor(messageId);
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
      const itemRect = item.getBoundingClientRect();
      const visibleBottom =
        scrollerRect.bottom - Math.max(0, quickContextBottomInset) - streamStatusHeight - 18;
      if (itemRect.bottom <= visibleBottom) {
        return;
      }
      const delta = Math.ceil(itemRect.bottom - visibleBottom);
      scrollMotion.move(scroller, scroller.scrollTop + delta, 'follow');
    },
    [quickContextBottomInset, scrollMotion, streamStatusHeight],
  );

  const cancelScheduledStreamFollow = useCallback(() => {
    scrollMotion.cancel();
    for (const pending of [streamScrollFrameRef, outerResizeFollowFrameRef]) {
      if (pending.current != null) window.cancelAnimationFrame(pending.current);
      pending.current = null;
    }
  }, [scrollMotion]);

  const scheduleActiveAssistantFollow = useCallback(
    (messageId: string, _index: number) => {
      const scroller = listScrollerRef.current;
      if (!scroller || scrollActivationRef.current?.restoring) return;
      if (streamScrollFrameRef.current != null) {
        window.cancelAnimationFrame(streamScrollFrameRef.current);
      }
      programmaticScrollUntilRef.current = Date.now() + 900;
      streamScrollFrameRef.current = window.requestAnimationFrame(() => {
        streamScrollFrameRef.current = null;
        if (
          listScrollerRef.current !== scroller ||
          scrollActivationRef.current?.restoring ||
          !autoFollowStreamRef.current ||
          userDetachedFromBottomRef.current ||
          Date.now() < manualScrollDetachUntilRef.current
        ) {
          return;
        }
        const item = scroller.querySelector(
          `[data-message-id="${cssEscape(messageId)}"]`,
        );
        if (!(item instanceof HTMLElement)) {
          streamScrollFrameRef.current = window.requestAnimationFrame(() => {
            streamScrollFrameRef.current = null;
            if (
              listScrollerRef.current === scroller &&
              !scrollActivationRef.current?.restoring &&
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
    finishConversationScrollRestoration();
    const scroller = listScrollerRef.current;
    captureScrollGeometry('trace-detach', { reason });
    lastWheelLockRef.current = null;
    programmaticScrollUntilRef.current = 0;
    manualScrollDetachUntilRef.current = Date.now() + manualScrollDetachHoldMs;
    cancelScheduledStreamFollow();
    manualScrollDirectionRef.current = reason.startsWith('wheel-up') || reason === 'key-up' ? -1 : 0;
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
      if (listScrollerRef.current === scroller && userDetachedFromBottomRef.current && !atBottomRef.current) {
        setScrollBottomVisible(
          shouldShowScrollBottomForScroller(listScrollerRef.current),
        );
      }
    });
  }, [
    cancelScheduledStreamFollow,
    captureScrollGeometry,
    finishConversationScrollRestoration,
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
      if (event.deltaY !== 0) manualScrollDirectionRef.current = Math.sign(event.deltaY);
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
      if (event.deltaY > 0 && scrollMotion.isActive()) {
        markUserDetachedFromBottom('wheel-down');
        manualScrollDirectionRef.current = 1;
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
      scrollMotion,
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
      if (event.deltaY !== 0) manualScrollDirectionRef.current = Math.sign(event.deltaY);
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
      if (metrics.visualAtBottom) {
        scrollbarDragUntilRef.current = 0;
        lockStreamFollow(`${reason}:bottom`);
        return;
      }
      const shouldShow = shouldShowScrollBottomForMetrics(scroller, metrics);
      scrollbarDragUntilRef.current = Date.now() + 220;
      autoFollowStreamRef.current = false;
      userDetachedFromBottomRef.current = true;
      pendingSubmittedUserFocusRef.current = false;
      cancelScheduledStreamFollow();
      setScrollBottomVisible(shouldShow);
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
    (scroller: HTMLElement, reason: string, scrollDelta: number) => {
      if (!sending) {
        return;
      }
      const now = Date.now();
      const activeAssistant = streamingAssistantMessage(renderMessages, activeTurnId);
      const metrics = readBottomMetrics(scroller);
      const shouldShow = shouldShowScrollBottomForMetrics(scroller, metrics);
      // Button visibility is not permission to move the reader. A small upward
      // gesture stays detached even when the last paragraph is still visible.
      if (userDetachedFromBottomRef.current) {
        if (metrics.visualAtBottom && scrollDelta > 0.5 && manualScrollDirectionRef.current >= 0) {
          lockStreamFollow(`${reason}:user-returned-to-bottom`);
          return;
        }
        autoFollowStreamRef.current = false;
        pendingSubmittedUserFocusRef.current = false;
        setScrollBottomVisible(shouldShow);
        return;
      }
      if (metrics.visualAtBottom) {
        lockStreamFollow(`${reason}:bottom`);
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
      finishConversationScrollRestoration();
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
      finishConversationScrollRestoration,
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
      if (event.target !== scroller) return;
      if (scroller !== listScrollerRef.current) return;
      if (scrollActivationRef.current?.restoring) {
        lastScrollTopRef.current = scroller.scrollTop;
        return;
      }
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
      if (scrollMotion.isActive() && !userDetachedFromBottomRef.current) return;
      const likelyUserScrollWithoutWheel =
        sending &&
        scrollDelta > 0.5 &&
        manualScrollDirectionRef.current >= 0 &&
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
        !scrollMotion.isActive() &&
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
        manualScrollDirectionRef.current = -1;
        setScrollBottomVisible(shouldShowScrollBottomForMetrics(scroller, metrics));
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
        setScrollBottomVisible(shouldShowScrollBottomForMetrics(scroller, metrics));
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
        if (userDetachedFromBottomRef.current) {
          if (metrics.visualAtBottom && scrollDelta > 0.5 && manualScrollDirectionRef.current >= 0) {
            lockStreamFollow('scroll:user-returned-to-bottom');
            return;
          }
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
      maybeLockStreamFollowFromScroll(scroller, 'scroll', scrollDelta);
    },
    [
      maybeLockStreamFollowFromScroll,
      cancelScheduledStreamFollow,
      captureScrollGeometry,
      lockStreamFollow,
      readBottomMetrics,
      releaseAssistantStageReservation,
      sending,
      scrollMotion,
      setScrollBottomVisible,
      shouldShowScrollBottomForMetrics,
    ],
  );

  useLayoutEffect(() => {
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
    const observer = new ResizeObserver((entries) => {
      // Deliveries contain only the targets reported in this batch. Comparing
      // whole batches mistakes a different subset (or a new observer's initial
      // delivery) for a resize and nudges an otherwise unchanged conversation.
      // Keep each target's measurement across effect restarts; session entry
      // already has its own synchronous scroll restoration.
      let resized = false;
      const signature = entries
        .map((entry) => {
          const target = entry.target as HTMLElement;
          const size = `${Math.round(entry.contentRect.width)}x${Math.round(entry.contentRect.height)}`;
          const previous = outerResizeSizesRef.current.get(target);
          outerResizeSizesRef.current.set(target, size);
          if (previous !== undefined && previous !== size) resized = true;
          return `${target.className}:${size}`;
        })
        .sort()
        .join('|');
      if (!resized) return;
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
        listScrollerRef.current !== scroller ||
        scrollActivationRef.current?.restoring ||
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
          listScrollerRef.current !== scroller ||
          scrollActivationRef.current?.restoring ||
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
        const preparedMessageId = assistantStageAnchorRef.current
          ? scroller.querySelector<HTMLElement>('.message-list-item:last-child')?.dataset.messageId ?? ''
          : '';
        if (preparedMessageId) {
          ensureMessageBottomVisible(preparedMessageId);
          lastScrollTopRef.current = scroller.scrollTop;
          setScrollBottomVisible(false);
          captureScrollGeometry('trace-outer-resize-follow', {
            strategy: 'response-tail-spacer',
            preparedMessageId,
            scrollTopBeforeCorrection: Math.round(scroller.scrollTop),
          });
          return;
        }
        const scrollTopBeforeCorrection = scroller.scrollTop;
        const targetScrollTop = absoluteBottomScrollTop(scroller);
        if (Math.abs(targetScrollTop - scrollTopBeforeCorrection) > 0.5) {
          programmaticScrollUntilRef.current = Date.now() + 520;
          scrollMotion.move(scroller, targetScrollTop, 'follow');
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
    scrollMotion,
    setScrollBottomVisible,
    showWelcome,
  ]);

  useEffect(() => {
    return () => {
      scrollMotion.cancel();
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
      scrollBottomWheelCleanupRef.current?.();
      scrollBottomWheelCleanupRef.current = null;
    };
  }, [scrollMotion]);

  useLayoutEffect(() => {
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
      previous.conversationId === activeConversationId &&
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
      pendingSubmittedUserFocusRef.current = false;
      pendingSubmittedUserEntryUntilRef.current = 0;
      messageSnapshotRef.current = { conversationId: activeConversationId, ids };
      return;
    }
    if (
      !loading &&
      !scrollActivationRef.current?.restoring &&
      submittedUserIndex >= 0 &&
      (pendingSubmittedUserFocusRef.current ||
        (sending &&
          renderMessages.length > previous.ids.length &&
          !userDetachedFromBottomRef.current))
    ) {
      const message = renderMessages[submittedUserIndex];
      const scroller = listScrollerRef.current;
      if (isTurnGuidanceMessage(message)) {
        // Guidance extends this turn. Keep its reading position and consume the
        // existing tail reservation, revealing the new bubble only if needed.
        if (scroller) updateResponseSpacer(scroller, assistantStageAnchorRef.current);
        ensureMessageBottomVisible(message.id);
      } else {
        assistantStageAnchorRef.current = message.renderKey ?? message.id;
        if (scroller) updateResponseSpacer(scroller, assistantStageAnchorRef.current);
        focusSubmittedUserMessage(submittedUserIndex, message.id);
      }
    }
    messageSnapshotRef.current = { conversationId: activeConversationId, ids };
  }, [
    activeConversationId,
    ensureMessageBottomVisible,
    focusSubmittedUserMessage,
    loading,
    renderMessages,
    sending,
    setScrollBottomVisible,
  ]);

  useLayoutEffect(() => {
    const scroller = listScrollerRef.current;
    if (scroller) updateResponseSpacer(scroller, assistantStageAnchorRef.current);
  }, [renderMessages, quickContextBottomInset, streamStatusHeight, scrollMountRevision]);

  useEffect(() => {
    const scroller = listScrollerRef.current;
    if (!scroller) return;
    let frame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (frame != null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        updateResponseSpacer(scroller, assistantStageAnchorRef.current);
      });
    });
    for (const node of [scroller, scroller.querySelector('.message-list-content'), scroller.querySelector('.message-list-footer')]) {
      if (node) observer.observe(node);
    }
    return () => {
      observer.disconnect();
      if (frame != null) window.cancelAnimationFrame(frame);
    };
  }, [activeConversationId, scrollMountRevision]);

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
    const activeAssistant = activeAssistantForRender;
    if (!activeAssistant) {
      return;
    }
    scheduleActiveAssistantFollow(
      activeAssistant.message.id,
      activeAssistant.index,
    );
  }, [
    activeAssistantForRender,
    activeTurnId,
    loading,
    renderMessages,
    scheduleActiveAssistantFollow,
    sending,
    showWelcome,
  ]);

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

  const jumpToLatestMessage = useCallback(
    (_reason: string) => {
      const scroller = listScrollerRef.current;
      if (!scroller) return;
      finishConversationScrollRestoration();
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

      scrollMotion.move(scroller, () => absoluteBottomScrollTop(scroller), 'jump', () => {
        if (listScrollerRef.current !== scroller || userDetachedFromBottomRef.current) {
          captureScrollGeometry('trace-jump-abort', {
            reason: 'user-detached',
          });
          return;
        }
        lastScrollTopRef.current = scroller.scrollTop;
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
      scrollMotion,
      finishConversationScrollRestoration,
      setScrollBottomVisible,
    ],
  );

  const scrollToBottom = useCallback(() => {
    if (messages.length === 0) {
      return;
    }
    listScrollerRef.current?.focus({ preventScroll: true });
    jumpToLatestMessage('scroll-bottom-button');
  }, [jumpToLatestMessage, messages.length]);

  const handleListKeyDownCapture = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey ||
        event.target instanceof Element && event.target.closest('input, textarea, [contenteditable="true"], [role="textbox"]')) return;
    const up = ['ArrowUp', 'PageUp', 'Home'].includes(event.key) || event.key === ' ' && event.shiftKey;
    const down = ['ArrowDown', 'PageDown', 'End', ' '].includes(event.key);
    if (!up && !down) return;
    markUserDetachedFromBottom(up ? 'key-up' : 'key-down');
    manualScrollDirectionRef.current = up ? -1 : 1;
  }, [markUserDetachedFromBottom]);

  // The ref belongs to this conversation's DOM lifetime. Event subscriptions
  // change independently, so a new token/callback never saves or restores it.
  const setListScrollerRef = useMemo(() => {
    let attachedScroller: HTMLElement | null = null;
    return (scroller: HTMLDivElement | null) => {
      if (scroller === attachedScroller) return;
      if (attachedScroller) {
        const activation = scrollActivationRef.current;
        const position = activation?.restoring && activation.position
          ? activation.position
          : captureConversationScrollPosition(
              attachedScroller,
              autoFollowStreamRef.current && !userDetachedFromBottomRef.current,
            );
        conversationScrollPositionsRef.current.set(activeConversationId, position);
        scrollDebug('session-scroll-save', { conversationId: activeConversationId, position });
      }
      cancelScheduledStreamFollow();
      for (const frame of [outerResizeFollowFrameRef, scrollRestoreFrameRef]) {
        if (frame.current != null) window.cancelAnimationFrame(frame.current);
        frame.current = null;
      }
      attachedScroller = scroller;
      listScrollerRef.current = scroller;
      scrollActivationRef.current = null;
      if (!scroller) return;
      const position = conversationScrollPositionsRef.current.get(activeConversationId);
      const freshSubmission = messageSnapshotRef.current.conversationId === activeConversationId
        && pendingSubmittedUserFocusRef.current;
      scrollActivationRef.current = { scroller, position, restoring: !freshSubmission };
      if (!freshSubmission) scroller.dataset.scrollRestoring = 'true';
      // Ref replay can remount a keyed child without rerunning its parent's
      // effects (StrictMode). Every activation must own a restoration commit.
      setScrollMountRevision((revision) => revision + 1);
      autoFollowStreamRef.current = position?.followLatest ?? true;
      userDetachedFromBottomRef.current = !autoFollowStreamRef.current;
      atBottomRef.current = autoFollowStreamRef.current;
      manualScrollDetachUntilRef.current = 0;
      programmaticScrollUntilRef.current = 0;
      lastWheelEventAtRef.current = 0;
      manualScrollDirectionRef.current = 0;
      lastWheelLockRef.current = null;
      scrollbarDragActiveRef.current = false;
      scrollbarDragUntilRef.current = 0;
      lastScrollTopRef.current = scroller.scrollTop;
      if (!freshSubmission) {
        pendingSubmittedUserFocusRef.current = false;
        pendingSubmittedUserEntryUntilRef.current = 0;
        assistantStageAnchorRef.current = position?.responseAnchorKey ?? '';
        if (position?.submittedUserReadingAnchor) {
          scroller.style.setProperty('--submitted-user-reading-anchor', position.submittedUserReadingAnchor);
        }
      }
      setScrollBottomVisible(false);
    };
  }, [activeConversationId, cancelScheduledStreamFollow, setScrollBottomVisible]);

  const diagnosticStateRef = useRef<() => Record<string, unknown>>(() => ({}));
  diagnosticStateRef.current = () => ({
    conversationId: activeConversationId, sending, loading, messageCount: renderMessages.length,
    autoFollow: autoFollowStreamRef.current, userDetached: userDetachedFromBottomRef.current,
    atBottom: atBottomRef.current, restoring: scrollActivationRef.current?.restoring,
    composerDockHeight, quickContextBottomInset, pendingInteraction: Boolean(pendingInteraction),
    manualDetachRemainingMs: Math.max(0, manualScrollDetachUntilRef.current - Date.now()),
    programmaticRemainingMs: Math.max(0, programmaticScrollUntilRef.current - Date.now()),
    pendingFollow: streamScrollFrameRef.current != null, pendingResizeFollow: outerResizeFollowFrameRef.current != null,
  });
  useEffect(() => {
    const scroller = listScrollerRef.current;
    if (!scroller) return;
    return observeWindowScrollDiagnostics(scroller, () => diagnosticStateRef.current());
  }, [activeConversationId, scrollMountRevision, loading, showWelcome]);

  useLayoutEffect(() => {
    const activation = scrollActivationRef.current;
    if (!activation?.restoring) return;
    const restore = () => {
      if (scrollActivationRef.current !== activation || !activation.restoring) return;
      restoreConversationScrollPosition(activation.scroller, activation.position, quickContextBottomInset);
      lastScrollTopRef.current = activation.scroller.scrollTop;
      scrollDebug('session-scroll-restore', {
        conversationId: activeConversationId,
        position: activation.position,
        scrollTop: activation.scroller.scrollTop,
      });
      const metrics = readBottomMetrics(activation.scroller);
      atBottomRef.current = metrics.visualAtBottom;
      setScrollBottomVisible(shouldShowScrollBottomForMetrics(activation.scroller, metrics));
    };
    restore();
    // Composer measurements may cause one synchronous layout commit. Settle it
    // before handing subsequent live updates back to the ordinary follow path.
    scrollRestoreFrameRef.current = window.requestAnimationFrame(() => {
      scrollRestoreFrameRef.current = null;
      if (scrollActivationRef.current !== activation) return;
      restore();
      delete activation.scroller.dataset.scrollRestoring;
      activation.restoring = false;
    });
    return () => {
      if (scrollRestoreFrameRef.current != null) window.cancelAnimationFrame(scrollRestoreFrameRef.current);
      scrollRestoreFrameRef.current = null;
    };
  }, [
    activeConversationId,
    scrollMountRevision,
    loading,
    showWelcome,
    renderMessages,
    quickContextBottomInset,
    readBottomMetrics,
    setScrollBottomVisible,
    shouldShowScrollBottomForMetrics,
  ]);

  useEffect(() => {
    const scroller = listScrollerRef.current;
    if (!scroller) return undefined;
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
    scroller.addEventListener('wheel', handleNativeWheel, {
      capture: true,
      passive: false,
    });
    return () => {
      scroller.removeEventListener('wheel', handleNativeWheel, {
        capture: true,
      });
    };
  }, [
    activeConversationId,
    loading,
    showWelcome,
    lockNativeWheelDownAtBottom,
    markWheelHandled,
    releaseAssistantStageReservation,
    releaseWheelBottomFreeze,
    wheelAlreadyHandled,
  ]);

  const setScrollBottomRef = useCallback(
    (ref: HTMLButtonElement | null) => {
      scrollBottomWheelCleanupRef.current?.();
      scrollBottomWheelCleanupRef.current = null;
      scrollBottomButtonRef.current = ref;
      if (!ref) {
        return;
      }
      const handleNativeWheel = (event: globalThis.WheelEvent) => {
        if (event.ctrlKey || event.deltaY === 0 || event.defaultPrevented || wheelAlreadyHandled(event)) return;
        const scroller = listScrollerRef.current;
        if (!scroller) return;
        // The floating button is outside the scroller. Route its wheel input
        // explicitly so it cannot become a dead spot above the composer.
        event.preventDefault();
        markWheelHandled(event);
        lastWheelEventAtRef.current = Date.now();
        markUserDetachedFromBottom(event.deltaY < 0 ? 'wheel-up-hotzone' : 'wheel-down-hotzone');
        manualScrollDirectionRef.current = Math.sign(event.deltaY);
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroller.clientHeight : 1;
        scroller.scrollBy({ top: event.deltaY * unit, behavior: 'instant' });
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
      markUserDetachedFromBottom,
      markWheelHandled,
      wheelAlreadyHandled,
    ],
  );

  const handleComposerSend = useCallback(
    async (text: string, options?: { immediate?: boolean }) => {
      if (
        sending &&
        (options?.immediate || guidanceDeliveryMode === 'immediate') &&
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
        finishConversationScrollRestoration();
        pendingSubmittedUserEntryUntilRef.current = Date.now() + 2000;
        const shouldFollowSubmission =
          !showScrollBottomRef.current || !userDetachedFromBottomRef.current;
        pendingSubmittedUserFocusRef.current = shouldFollowSubmission;
        releaseAssistantStageReservation();
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
      finishConversationScrollRestoration,
      releaseAssistantStageReservation,
      onGuideMessage,
      onSend,
      sending,
      setScrollBottomVisible,
    ],
  );

  const [workSummaryVisible, setWorkSummaryVisible] = useState(false);
  const [workSummaryDocked, setWorkSummaryDocked] = useState(false);
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
  const updateWorkSummaryLayout = useCallback((anchor?: HTMLElement | null) => {
    const chatBody = chatBodyRef.current;
    const toggle = anchor ?? chatBody
      ?.closest('.chat-panel')
      ?.querySelector<HTMLElement>('[data-work-summary-toggle]');
    if (!chatBody || !toggle) return;
    const bodyBounds = chatBody.getBoundingClientRect();
    const toggleBounds = toggle.getBoundingClientRect();
    // Measure the whole chat pane, not the content frame that we shrink.
    // 1100px leaves about 600px of readable text beside the 336px summary.
    setWorkSummaryDocked(bodyBounds.width >= 1100);
    const maximumRight = Math.max(12, bodyBounds.width - 24);
    setWorkSummaryAnchorRight(Math.min(
      maximumRight,
      Math.max(12, Math.round(bodyBounds.right - toggleBounds.right)),
    ));
  }, []);
  useLayoutEffect(() => {
    const chatBody = chatBodyRef.current;
    if (!workSummaryPresence.mounted || !chatBody) return undefined;
    updateWorkSummaryLayout();
    // Sidebars can resize the chat without a window resize. Also remeasure
    // when the inspector toggle disappears, moving the summary button.
    const observer = new ResizeObserver(() => updateWorkSummaryLayout());
    observer.observe(chatBody);
    return () => observer.disconnect();
  }, [workSummaryPresence.mounted, inspectorOpen, updateWorkSummaryLayout]);
  useEffect(() => {
    if (!showWorkSummary || workSummaryDocked) {
      return undefined;
    }
    const closeOverlaySummary = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      if (
        target.closest('.conversation-work-summary') ||
        target.closest('[data-work-summary-toggle]') ||
        target.closest('[data-inspector-toggle]') ||
        target.closest('.right-inspector')
      ) {
        return;
      }
      setWorkSummaryVisible(false);
    };
    const closeOverlaySummaryWithKeyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setWorkSummaryVisible(false);
      }
    };
    document.addEventListener('pointerdown', closeOverlaySummary);
    document.addEventListener('keydown', closeOverlaySummaryWithKeyboard);
    return () => {
      document.removeEventListener('pointerdown', closeOverlaySummary);
      document.removeEventListener('keydown', closeOverlaySummaryWithKeyboard);
    };
  }, [showWorkSummary, workSummaryDocked]);
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
    <ComposerReferenceContext.Provider value={{ sessionId: activeConversationId, browserTabs, messages, projects: availableProjects, onWorkspaceSelect: sending || Boolean(activeTurnId) || queuedMessageCount > 0 ? undefined : onWelcomeProjectChange }}>
    <div
      className={`chat-panel${sidebarCollapsed ? ' sidebar-collapsed' : ''}${!workSummaryPresence.mounted ? ' work-summary-hidden' : ' work-summary-requested'}${workSummaryPresence.visible ? ' work-summary-visible' : ''}${workSummaryDocked ? ' work-summary-docked' : ' work-summary-overlay'}${windowMaximized ? ' window-maximized' : ' window-restored'}`}
    >
      <TopBar
        title={title}
        language={language}
        conversationContentAvailable={renderMessages.length > 0}
        workSummaryVisible={showWorkSummary}
        inspectorOpen={inspectorOpen}
        onToggleWorkSummary={renderMessages.length > 0
          ? (anchor) => {
              if (showWorkSummary) {
                setWorkSummaryVisible(false);
                return;
              }
              updateWorkSummaryLayout(anchor);
              setWorkSummaryVisible(true);
            }
          : undefined}
        onToggleInspector={onToggleInspector}
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
            workspaceRoot={activeProjectDir}
            pathAliases={projectPathAliases}
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
            fileDropTarget={chatBodyRef}
            language={language}
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
            teamAvailable={teamAvailable}
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
            onOpenConversation={onOpenConversation}
            selectedProjectDir={selectedProjectDir}
            availableProjects={availableProjects}
            onProjectChange={onWelcomeProjectChange}
            skills={skills}
            disabledSkillNames={disabledSkillNames}
            onToggleSkill={onToggleSkill}
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
            tabIndex={0}
            aria-label={language === 'zh' ? '会话消息' : 'Conversation messages'}
            onKeyDownCapture={handleListKeyDownCapture}
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
                    key={message.renderKey ?? message.id}
                    className={`message-list-item${index === 0 ? ' first' : ''}${
                      sending && activeTurnId && message.turnId === activeTurnId ? ' live-turn' : ''
                    }${
                      message.role === 'user' && (
                        enteringUserMessageIds.has(message.id) ||
                        pendingSubmittedUserEntryMessageId === message.id
                      )
                        ? ' user-message-entering'
                        : ''
                    }${
                      sending && message.role === 'assistant' &&
                      activeAssistantForRender?.message.id === message.id
                        ? ' streaming'
                        : ''
                    }`}
                    data-message-id={message.id}
                    data-message-render-key={message.renderKey ?? message.id}
                    data-message-role={message.role}
                  >
                    {(message.role === 'user' || (message.role === 'assistant' && lastAssistantByTurn.get(message.turnId ?? '') === message.id)) &&
                      <ExtractionSelector message={message} sessionId={activeConversationId} />}
                    <MessageBubble
                      message={message}
                      changeSummaryMessages={completedGuidanceTurnMessages.get(message.id)}
                      language={language}
                      sending={sending}
                      activeTurnId={activeTurnId}
                      canRevertWorkspace={reversibleTurnIds.has(message.turnId ?? '')}
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
            <div className="assistant-response-spacer" aria-hidden="true" />
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
            className={`composer-dock interaction-only ${pendingInteraction.type === 'solution_selection' ? 'solution-only' : 'permission-only'}`}
            ref={composerDockRef}
          >
            <InteractionCard
              key={pendingInteraction.id}
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
              sending || activeGoal || queuedMessageCount > 0
                ? ' runtime-attached'
                : ''
            }`}
            ref={composerDockRef}
            style={{
              '--shadow-accent': shadowAccentColor,
            } as CSSProperties}
          >
            {(sending || activeGoal || queuedMessageCount > 0) && (
              <LiveComposerRuntimeRail
                key={`runtime:${activeConversationId}`}
                ref={runtimeRailRef}
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
              fileDropTarget={chatBodyRef}
              compact
              language={language}
              draft={draft}
              onDraftChange={onDraftChange}
              sending={sending}
              stopping={stopping}
              guidanceDeliveryMode={guidanceDeliveryMode}
              cancelEnabled={Boolean(activeTurnId)}
              queuedMessageCount={queuedMessageCount}
              onShowQueue={() => runtimeRailRef.current?.showQueue()}
              queuedMessagePreview=""
              queuedMessages={queuedMessages}
              onGuideQueuedMessage={(queuedId) => onGuideQueuedMessage(queuedId, 'append_context')}
              selectedModel={selectedModel}
              availableModels={availableModels}
              teamAvailable={teamAvailable}
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
              onToggleSkill={onToggleSkill}
              onQuickLoad={applyQuickLoad}
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
          aria-label={language === 'zh' ? '回到底部' : 'Back to bottom'}
          title={language === 'zh' ? '回到底部' : 'Back to bottom'}
          aria-hidden={loading || showWelcome || !showScrollBottom}
          tabIndex={loading || showWelcome || !showScrollBottom ? -1 : 0}
          onClick={scrollToBottom}
        >
          <ArrowDown size={18} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
    </div>
    </ComposerReferenceContext.Provider>
  );
}
