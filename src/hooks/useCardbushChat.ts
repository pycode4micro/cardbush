import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RuntimeRemoteError } from '@cardbush/bush-runtime-electron';

import {
  cancelInteraction,
  createConversation,
  deleteConversationApi,
  editMessage,
  fetchConversations,
  fetchGoalRuntimeStatus,
  fetchExperimentalGoals,
  fetchMessages,
  fetchPendingInteraction,
  fetchSessionContextWindowUsage,
  fetchSessionWorkspaceChanges,
  fetchSkillDetail,
  fetchSkills,
  fetchSessionMessages,
  fetchTeamFlow,
  isPendingInteractionConflictError,
  replyInteraction,
  sendGuidance,
  sendTeamFlowAction,
  stopTurn,
  streamChat,
  streamTurnEvents,
  updateConversation,
  updateExperimentalGoal,
  type SceneStreamEvent,
  type TeamWorkflowStreamEvent,
  type ExperimentalGoal,
  type SessionLatestTurn,
} from '../backend/api';
import type {
  AppLanguage,
  AssistantRevision,
  AssistantStreamChunk,
  ChatAttachment,
  ChatMessage,
  ConversationSummary,
  ManagedModelConfig,
  SkillDetail,
  SkillSummary,
  ChatToolExecution,
  PendingInteraction,
  InteractionReplyAnswer,
  PermissionMode,
  SubagentPermissionRouting,
  ReasoningLevel,
  ReferencePlanMode,
  RuntimeContextWindowUsage,
  RuntimeConnectionUpdate,
  SessionAttentionKind,
  SessionAttentionState,
  TerminalRuntime,
  TeamFlowActionType,
  TeamFlowActionOption,
  TeamFlowLayer,
  TeamFlowNode,
  TeamFlowState,
  TeamFlowStreamEvent,
  TaskPlanStreamUpdate,
  StreamExecutionUpdate,
  SubagentDispatchEvent,
  TurnTerminalSnapshot,
} from '../types';
import { keepFirstPendingInteraction } from '../features/interactions/pendingInteractionQueue';
import { emitSubagentDispatch } from '../features/subagents/subagentObservabilityEvents';
import {
  assistantTurnTimingFingerprint,
  persistAssistantTurnTiming,
} from '../features/chatMessages/assistantTurnTiming';
import {
  isCardbushForeground,
  persistSessionAttentionState,
  readSessionAttentionState,
} from '../features/sessionAttention';
import {
  basename,
  isAbsoluteLocalPath,
  isAudioPath,
  isImagePath,
  isVideoPath,
  samePath,
  stripWrappingQuotes,
} from '../shared/localPaths';
import { truncateText } from '../shared/text';
import { SessionReadFence, canApplySessionSnapshot } from '../shared/sessionReadFence';
import {
  applyGoalToolUpdate,
  goalToolUpdateFromExecution,
} from '../shared/goalState';
import {
  conversationProjectDir,
  conversationWorkspaceRoot,
} from '../features/conversationWorkspace';
import { reorderScopedQueue } from '../features/composer/queueOrdering';
import {
  conversationProjectId,
  conversationProjectPathAliases,
  conversationScopeKey,
  remapProjectPath,
  type ConversationScope,
} from '../features/conversationScope';

import {
  mergeLoadedMessagesPreservingLocalState,
  mergeFinalStreamMessages,
  mergeMessages,
  mergePolledMessagesPreservingLocalState,
} from '../features/chatMessages/transcript/messageProjection';
import {
  mergeWorkspaceChangeExecutions,
} from '../features/chatMessages/transcript/toolExecutionMerge';
import {
  ensureBackgroundTurnAssistant,
  appendAssistantDelta,
  applyAssistantSegmentBoundary,
  applyAssistantRevision,
  appendToolExecution,
  applyTaskPlanUpdate,
  markLocalAssistantTurnCompleted,
  markOptimisticChatRequestAccepted,
  assignTurnToLocalMessages,
  applyTurnTerminalSnapshot,
  markOptimisticChatRequestFailed,
  markLocalMessageTurnStarted,
  applyAssistantStreamRoute,
  optimisticGuidanceMessage,
  reconcileOptimisticGuidance,
  removeOptimisticGuidance,
  markOptimisticGuidanceFailed,
  markOptimisticGuidancePending,
} from '../features/chatMessages/transcript/liveMessageUpdates';
import {
  createSegmentedAssistantStreamBuffers,
} from '../features/chatMessages/transcript/assistantStreamBuffer';
import {
  hasCompletedAssistantForTurn,
  findUserMessageForAssistantRegenerate,
  persistedChatMessageId,
  messageIdentityMatches,
  uniqueMessageIds,
  findPersistedEditableUserMessage,
} from '../features/chatMessages/transcript/messageFacts';

// Keep existing helper imports working; new consumers should use the transcript modules.
export {
  markOptimisticChatRequestAccepted,
  markOptimisticChatRequestFailed,
  appendAssistantDelta,
  appendAssistantTextAfterToolBoundary,
  applyAssistantSegmentBoundary,
  optimisticGuidanceMessage,
  reconcileOptimisticGuidance,
  applyAssistantRevision,
  applyTurnTerminalSnapshot,
  appendToolExecution,
} from '../features/chatMessages/transcript/liveMessageUpdates';
export {
  createAssistantStreamDeltaBuffer,
} from '../features/chatMessages/transcript/assistantStreamBuffer';
export {
  mergeFinalStreamMessages,
  mergeLoadedMessagesPreservingLocalState,
  normalizeChatMessagesForDisplay,
  normalizeActiveTurnTranscriptForDisplay,
} from '../features/chatMessages/transcript/messageProjection';

export type QueuedChatMessage = {
  id: string;
  text: string;
  conversation?: ConversationSummary;
  createdAt: string;
  teamId?: string;
  teamName?: string;
};

export function useCardbushChat(
  managedModelConfigs: ManagedModelConfig[] = [],
  availableModels: ManagedModelConfig[] = [],
  requestContext: {
    runtimeReady?: boolean;
    language?: AppLanguage;
    projectContexts?: Record<string, string>;
    disabledSkillNames?: Set<string>;
    disabledToolNames?: Set<string>;
    standardImageInputEnabled?: boolean;
    browserPrivacyMode?: boolean;
    teamModeEnabled?: boolean;
    selectedTeamId?: string;
    selectedTeamName?: string;
    terminalRuntime?: TerminalRuntime;
    reasoningTraceVisible?: boolean;
    interactiveRequestsAvailable?: boolean;
    reasoningLevelSelection?: boolean;
    reasoningLevels?: ReasoningLevel[];
    defaultReasoningLevel?: ReasoningLevel;
    contextWindowUsageAvailable?: boolean;
    workspaceChangesAvailable?: boolean;
    defaultProjectId?: string;
    defaultProjectDir?: string;
  } = {},
) {
  const languageRef = useRef<AppLanguage>(requestContext.language ?? 'zh');
  languageRef.current = requestContext.language ?? 'zh';
  const localize = useCallback(
    (zh: string, en: string) => (languageRef.current === 'zh' ? zh : en),
    [],
  );
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [preparedConversationsByScope, setPreparedConversationsByScope] = useState<
    Record<string, ConversationSummary>
  >({});
  const [activeConversationId, setActiveConversationId] = useState('');
  const [messagesByConversation, setMessagesByConversation] = useState<
    Record<string, ChatMessage[]>
  >({});
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [messageHistoryLoadingIds, setMessageHistoryLoadingIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [runningByConversation, setRunningByConversation] = useState<
    Record<string, { activeTurnId: string; stopping: boolean }>
  >({});
  const [processingConversationIds, setProcessingConversationIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [attentionByConversation, setAttentionByConversation] = useState<
    Record<string, SessionAttentionState>
  >(readSessionAttentionState);
  const [teamFlowsByConversation, setTeamFlowsByConversation] = useState<
    Record<string, TeamFlowState | null>
  >({});
  const [teamFlowLoadingByConversation, setTeamFlowLoadingByConversation] = useState<
    Record<string, boolean>
  >({});
  const [teamFlowActionByConversation, setTeamFlowActionByConversation] = useState<
    Record<string, TeamFlowActionType | ''>
  >({});
  const [contextWindowUsageByConversation, setContextWindowUsageByConversation] =
    useState<Record<string, RuntimeContextWindowUsage>>({});
  const [goalByConversation, setGoalByConversation] = useState<
    Record<string, ExperimentalGoal | null>
  >({});
  const [goalAvailable, setGoalAvailable] = useState(false);
  const [goalLatestTurnByConversation, setGoalLatestTurnByConversation] = useState<
    Record<string, SessionLatestTurn | undefined>
  >({});
  const [goalCancellingByConversation, setGoalCancellingByConversation] = useState<
    Record<string, boolean>
  >({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [connectionRecoveryByConversation, setConnectionRecoveryByConversation] =
    useState<Record<string, RuntimeConnectionUpdate | undefined>>({});
  const [pendingInteraction, setPendingInteraction] =
    useState<PendingInteraction | null>(null);
  const [selectedModel, setSelectedModelState] = useState(() =>
    readInitialSelectedModel(availableModels),
  );
  const [referencePlanMode, setReferencePlanModeState] = useState<ReferencePlanMode>(
    readInitialReferencePlanMode,
  );
  const [permissionMode, setPermissionModeState] = useState<PermissionMode>(
    readInitialPermissionMode,
  );
  const [subagentPermissionRouting, setSubagentPermissionRoutingState] =
    useState<SubagentPermissionRouting>(readInitialSubagentPermissionRouting);
  const [reasoningLevel, setReasoningLevelState] = useState<ReasoningLevel>(() =>
    readInitialReasoningLevel(
      requestContext.reasoningLevels,
      requestContext.defaultReasoningLevel,
    ),
  );
  const controllersRef = useRef<Record<string, AbortController>>({});
  const goalTurnControllersRef = useRef<
    Record<string, { turnId: string; controller: AbortController }>
  >({});
  const goalTurnCursorRef = useRef<
    Record<string, { sequence: number; lastEventId: string }>
  >({});
  const activeTurnIdsRef = useRef<Record<string, string>>({});
  const terminalTurnIdsRef = useRef<Set<string>>(new Set());
  const stoppingRequestsRef = useRef<Set<string>>(new Set());
  const contextWindowUsageRequestsRef = useRef<Map<string, {
    promise: Promise<void>;
    ticket: ReturnType<SessionReadFence['begin']>;
  }>>(new Map());
  const contextUsageReadsRef = useRef(new SessionReadFence());
  const historyReadsRef = useRef(new SessionReadFence());
  const messagesByConversationRef = useRef(messagesByConversation);
  messagesByConversationRef.current = messagesByConversation;
  const liveTranscriptSessionsRef = useRef(new Set<string>());
  const historyLoadingRequestsRef = useRef(new Map<string, Set<symbol>>());
  const activeConversationIdRef = useRef(activeConversationId);
  const conversationsRef = useRef(conversations);
  const preparedConversationsRef = useRef(preparedConversationsByScope);
  const conversationCreationPromisesRef = useRef<
    Map<string, Promise<ConversationSummary>>
  >(new Map());
  const attentionByConversationRef = useRef(attentionByConversation);
  activeConversationIdRef.current = activeConversationId;
  conversationsRef.current = conversations;
  preparedConversationsRef.current = preparedConversationsByScope;
  attentionByConversationRef.current = attentionByConversation;
  const sendingSessionsRef = useRef<Set<string>>(new Set());
  const queuedMessagesRef = useRef<QueuedChatMessage[]>([]);
  const guidanceFallbackIdsRef = useRef<Set<string>>(new Set());
  const guidanceRequestIdsRef = useRef<Set<string>>(new Set());
  const sendMessageRef = useRef<
    (text: string, conversation?: ConversationSummary, teamId?: string, teamName?: string) => Promise<void>
  >(async () => undefined);
  const [queuedMessages, setQueuedMessages] = useState<QueuedChatMessage[]>([]);
  const activeConversationIdForState = activeConversationId.trim();
  const messagesLoading = Boolean(
    activeConversationIdForState &&
      messageHistoryLoadingIds.has(activeConversationIdForState),
  );
  const activeQueuedMessages = queuedMessages.filter(
    (item) => queuedMessageConversationId(item) === activeConversationIdForState,
  );
  const sending = Boolean(
    activeConversationIdForState &&
      sendingSessionsRef.current.has(activeConversationIdForState),
  );
  const activeTurnId = activeConversationIdForState
    ? runningByConversation[activeConversationIdForState]?.activeTurnId ?? ''
    : '';
  const stopping = Boolean(
    activeConversationIdForState &&
      runningByConversation[activeConversationIdForState]?.stopping,
  );
  const activeConnectionRecovery = activeConversationIdForState
    ? connectionRecoveryByConversation[activeConversationIdForState]
    : undefined;
  const setMessageHistoryLoading = useCallback((sessionId: string, pending: boolean) => {
    const normalized = sessionId.trim();
    if (!normalized) return;
    setMessageHistoryLoadingIds((current) => {
      const alreadyPending = current.has(normalized);
      if (alreadyPending === pending) return current;
      const next = new Set(current);
      if (pending) next.add(normalized);
      else next.delete(normalized);
      return next;
    });
  }, []);
  const beginHistoryRead = useCallback((sessionId: string) => ({
    ticket: historyReadsRef.current.begin(sessionId),
    baseline: messagesByConversationRef.current[sessionId],
  }), []);
  const beginHistoryLoading = useCallback((sessionId: string) => {
    const identity = Symbol(sessionId);
    const pending = historyLoadingRequestsRef.current.get(sessionId) ?? new Set<symbol>();
    pending.add(identity);
    historyLoadingRequestsRef.current.set(sessionId, pending);
    setMessageHistoryLoading(sessionId, true);
    return () => {
      if (!pending.delete(identity) || pending.size > 0) return;
      historyLoadingRequestsRef.current.delete(sessionId);
      setMessageHistoryLoading(sessionId, false);
    };
  }, [setMessageHistoryLoading]);
  const isHistoryReadCurrent = useCallback((
    read: ReturnType<typeof beginHistoryRead>,
    current = messagesByConversationRef.current,
    allowLive = false,
  ) => (allowLive || !liveTranscriptSessionsRef.current.has(read.ticket.sessionId))
    && canApplySessionSnapshot(
      historyReadsRef.current, read.ticket, read.baseline, current[read.ticket.sessionId],
    ), []);
  const applyHistoryRead = useCallback((
    read: ReturnType<typeof beginHistoryRead>,
    loaded: ChatMessage[],
    merge = mergeLoadedMessagesPreservingLocalState,
    allowLive = false,
  ) => {
    setMessagesByConversation((current) => {
      if (!isHistoryReadCurrent(read, current, allowLive)) return current;
      const sessionId = read.ticket.sessionId;
      return { ...current, [sessionId]: merge(current[sessionId] ?? [], loaded) };
    });
  }, [isHistoryReadCurrent]);
  const assistantTimingFingerprint = useMemo(
    () => assistantTurnTimingFingerprint(messagesByConversation),
    [messagesByConversation],
  );

  useEffect(() => {
    if (!assistantTimingFingerprint) return;
    persistAssistantTurnTiming(messagesByConversation);
  }, [assistantTimingFingerprint]);

  const clearSessionAttention = useCallback((
    sessionId: string,
    expectedKind?: SessionAttentionKind,
  ) => {
    const normalized = sessionId.trim();
    const currentAttention = attentionByConversationRef.current[normalized];
    if (!normalized || !currentAttention || (expectedKind && currentAttention.kind !== expectedKind)) {
      return;
    }
    const next = { ...attentionByConversationRef.current };
    delete next[normalized];
    attentionByConversationRef.current = next;
    setAttentionByConversation(next);
  }, []);

  const markSessionAttention = useCallback((
    sessionId: string,
    kind: SessionAttentionKind,
    body: string,
    turnId = '',
  ) => {
    const normalized = sessionId.trim();
    if (!normalized) return;
    if (
      kind === 'completed' &&
      activeConversationIdRef.current === normalized &&
      isCardbushForeground()
    ) {
      clearSessionAttention(normalized, 'completed');
      return;
    }
    const existing = attentionByConversationRef.current[normalized];
    const normalizedTurnId = turnId.trim();
    if (existing?.kind === kind && normalizedTurnId && existing.turnId === normalizedTurnId) {
      return;
    }
    const conversation = conversationsRef.current.find((item) => item.id === normalized);
    const title = conversation?.title?.trim() || localize('CardBush 会话', 'CardBush session');
    const attention: SessionAttentionState = {
      sessionId: normalized,
      kind,
      title,
      body: body.trim() || (kind === 'waiting'
        ? localize('需要你的确认，点击继续处理。', 'Your input is required. Click to continue.')
        : kind === 'error'
          ? localize('任务遇到问题，点击查看详情。', 'The task needs attention. Click to view details.')
          : localize('任务已完成，点击查看结果。', 'Task complete. Click to view the result.')),
      turnId: normalizedTurnId || undefined,
      updatedAt: new Date().toISOString(),
    };
    const next = {
      ...attentionByConversationRef.current,
      [normalized]: attention,
    };
    attentionByConversationRef.current = next;
    setAttentionByConversation(next);
    void window.cardbushDesktop?.notifySessionAttention?.(attention).catch(() => undefined);
  }, [clearSessionAttention, localize]);

  useEffect(() => {
    persistSessionAttentionState(attentionByConversation);
    void window.cardbushDesktop
      ?.setSessionAttentionCount?.(Object.keys(attentionByConversation).length)
      .catch(() => undefined);
  }, [attentionByConversation]);

  useEffect(() => {
    if (loading || conversations.length === 0) return;
    const knownIds = new Set(conversations.map((item) => item.id));
    const staleIds = Object.keys(attentionByConversationRef.current).filter(
      (sessionId) => !knownIds.has(sessionId),
    );
    if (staleIds.length === 0) return;
    const next = { ...attentionByConversationRef.current };
    for (const sessionId of staleIds) delete next[sessionId];
    attentionByConversationRef.current = next;
    setAttentionByConversation(next);
  }, [conversations, loading]);

  useEffect(() => {
    const clearVisibleCompletion = () => {
      if (!isCardbushForeground()) return;
      clearSessionAttention(activeConversationIdRef.current, 'completed');
    };
    window.addEventListener('focus', clearVisibleCompletion);
    document.addEventListener('visibilitychange', clearVisibleCompletion);
    clearVisibleCompletion();
    return () => {
      window.removeEventListener('focus', clearVisibleCompletion);
      document.removeEventListener('visibilitychange', clearVisibleCompletion);
    };
  }, [activeConversationId, clearSessionAttention]);

  useEffect(() => () => {
    for (const { controller } of Object.values(goalTurnControllersRef.current)) {
      controller.abort();
    }
    goalTurnControllersRef.current = {};
  }, []);

  const applyConnectionRecoveryUpdate = useCallback((
    fallbackSessionId: string,
    update: RuntimeConnectionUpdate,
  ) => {
    const targetSessionId = update.sessionId.trim() || fallbackSessionId;
    setConnectionRecoveryByConversation((current) => ({
      ...current,
      [targetSessionId]: update.state === 'recovered'
        ? undefined
        : {
            ...update,
            sessionId: targetSessionId,
          },
    }));
  }, []);

  const clearConnectionRecovery = useCallback((sessionId: string) => {
    const normalized = sessionId.trim();
    if (!normalized) return;
    setConnectionRecoveryByConversation((current) => {
      if (!current[normalized]) return current;
      const next = { ...current };
      delete next[normalized];
      return next;
    });
  }, []);

  const enqueueMessage = useCallback((item: QueuedChatMessage) => {
    queuedMessagesRef.current = [...queuedMessagesRef.current, item];
    setQueuedMessages(queuedMessagesRef.current);
  }, []);

  const removeQueuedMessage = useCallback((queuedId: string) => {
    queuedMessagesRef.current = queuedMessagesRef.current.filter(
      (item) => item.id !== queuedId,
    );
    setQueuedMessages(queuedMessagesRef.current);
  }, []);

  const reorderQueuedMessage = useCallback((queuedId: string, targetQueuedId: string) => {
    const reordered = reorderScopedQueue(
      queuedMessagesRef.current,
      queuedId,
      targetQueuedId,
      (item) => item.id,
      queuedMessageConversationId,
    );
    if (reordered === queuedMessagesRef.current) {
      return;
    }
    queuedMessagesRef.current = reordered;
    setQueuedMessages(reordered);
  }, []);

  const dequeueMessageForConversation = useCallback((conversationId: string) => {
    const normalized = conversationId.trim();
    const index = queuedMessagesRef.current.findIndex(
      (item) => queuedMessageConversationId(item) === normalized,
    );
    if (index < 0) {
      return undefined;
    }
    const next = queuedMessagesRef.current[index];
    const rest = [
      ...queuedMessagesRef.current.slice(0, index),
      ...queuedMessagesRef.current.slice(index + 1),
    ];
    queuedMessagesRef.current = rest;
    setQueuedMessages(rest);
    return next;
  }, []);

  const persistAutoConversationTitle = useCallback(
    (conversation: ConversationSummary, sourceText: string) => {
      const sessionId = conversation.id.trim();
      const nextTitle = conversationTitleFromUserText(sourceText);
      if (
        !sessionId ||
        !nextTitle ||
        shouldAutoTitleConversation(nextTitle, sessionId) ||
        !shouldAutoTitleConversation(conversation.title, sessionId)
      ) {
        return;
      }

      setConversations((current) =>
        current.map((item) =>
          item.id === sessionId && shouldAutoTitleConversation(item.title, item.id)
            ? { ...item, title: nextTitle }
            : item,
        ),
      );

      const sync = (attempt: number) => {
        void updateConversation({ sessionId, title: nextTitle })
          .then((synced) => {
            setConversations((current) =>
              current.map((item) =>
                item.id === sessionId
                  ? {
                      ...item,
                      ...synced,
                      id: sessionId,
                      title: mergeSyncedConversationTitle(item.title, synced.title, sessionId),
                    }
                  : item,
              ),
            );
          })
          .catch(() => {
            if (attempt >= 2) {
              return;
            }
            window.setTimeout(() => sync(attempt + 1), 250 * (attempt + 1));
          });
      };
      sync(0);
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    if (requestContext.runtimeReady === false) {
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }
    async function load() {
      setLoading(true);
      try {
        const [loadedConversations, loadedSkills] = await Promise.all([
          fetchConversations(),
          fetchSkills().catch(() => []),
        ]);
        if (cancelled) {
          return;
        }
        setConversations((current) =>
          mergeLoadedConversationsPreservingLocalTitles(current, loadedConversations),
        );
        setActiveConversationId((current) =>
          loadedConversations.some((item) => item.id === current)
            ? current
            : Object.values(preparedConversationsRef.current).some(
                (item) => item.id === current,
              )
              ? current
              : '',
        );
        setMessagesByConversation((current) => {
          const validIds = new Set(loadedConversations.map((item) => item.id));
          return Object.fromEntries(
            Object.entries(current).filter(([conversationId]) =>
              validIds.has(conversationId),
            ),
          );
        });
        setSkills(loadedSkills);
        setError(null);
      } catch (caught) {
        if (!cancelled) {
          setConversations([]);
          setActiveConversationId('');
          setMessagesByConversation({});
          setSkills([]);
          setError(errorMessage(caught));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [requestContext.runtimeReady]);

  useEffect(() => {
    setSelectedModelState((current) => {
      const selected = modelConfigFor(availableModels, current);
      if (selected) {
        if (selected.id !== current) {
          window.localStorage.setItem('cardbush.selected_model', selected.id);
        }
        return selected.id;
      }
      const next = availableModels[0]?.id ?? '';
      if (next) {
        window.localStorage.setItem('cardbush.selected_model', next);
      } else {
        window.localStorage.removeItem('cardbush.selected_model');
      }
      return next;
    });
  }, [availableModels]);

  const setSelectedModel = useCallback((model: string) => {
    setSelectedModelState(model);
    window.localStorage.setItem('cardbush.selected_model', model);
  }, []);


  const setReferencePlanMode = useCallback((mode: ReferencePlanMode) => {
    const normalized = normalizeReferencePlanMode(mode);
    setReferencePlanModeState(normalized);
    window.localStorage.setItem('cardbush.reference_plan_mode', normalized);
    window.localStorage.setItem('cardbush.reference_plan_mode_explicit', 'true');
  }, []);

  const setPermissionMode = useCallback((mode: PermissionMode) => {
    const normalized = normalizePermissionMode(mode);
    setPermissionModeState(normalized);
    window.localStorage.setItem('cardbush.permission_mode', normalized);
  }, []);

  const setSubagentPermissionRouting = useCallback((routing: SubagentPermissionRouting) => {
    const normalized = normalizeSubagentPermissionRouting(routing);
    setSubagentPermissionRoutingState(normalized);
    window.localStorage.setItem('cardbush.subagent_permission_routing', normalized);
  }, []);

  const setReasoningLevel = useCallback((level: ReasoningLevel) => {
    setReasoningLevelState(level);
    window.localStorage.setItem('cardbush.reasoning_level', level);
  }, []);

  useEffect(() => {
    const levels = normalizeReasoningLevels(requestContext.reasoningLevels);
    setReasoningLevelState((current) => {
      if (levels.includes(current)) {
        return current;
      }
      const next = normalizeReasoningLevel(
        requestContext.defaultReasoningLevel,
        levels,
      );
      window.localStorage.setItem('cardbush.reasoning_level', next);
      return next;
    });
  }, [requestContext.defaultReasoningLevel, requestContext.reasoningLevels]);

  const refreshMeasuredContextWindowUsage = useCallback((
    sessionId: string,
    latestTurn?: SessionLatestTurn,
  ) => {
    const normalizedSessionId = sessionId.trim();
    const turnId = latestTurn?.turnId.trim() ?? '';
    if (!normalizedSessionId || requestContext.contextWindowUsageAvailable !== true) {
      return Promise.resolve();
    }
    if (!turnId) {
      // An empty old history response cannot clear an active request's meter.
      if (liveTranscriptSessionsRef.current.has(normalizedSessionId)) return Promise.resolve();
      const ticket = contextUsageReadsRef.current.begin(normalizedSessionId);
      setContextWindowUsageByConversation((current) => {
        if (!contextUsageReadsRef.current.isCurrent(ticket)) return current;
        if (!(normalizedSessionId in current)) return current;
        const next = { ...current };
        delete next[normalizedSessionId];
        return next;
      });
      return Promise.resolve();
    }

    const requestKey = `${normalizedSessionId}:${turnId}`;
    const pending = contextWindowUsageRequestsRef.current.get(requestKey);
    if (pending && contextUsageReadsRef.current.isCurrent(pending.ticket)) return pending.promise;
    // History has no facts for an uncommitted active Turn. Its final stream
    // receipt remains authoritative until that Turn has settled.
    if (liveTranscriptSessionsRef.current.has(normalizedSessionId)) return Promise.resolve();
    const ticket = contextUsageReadsRef.current.begin(normalizedSessionId);

    const request = fetchSessionContextWindowUsage(normalizedSessionId)
      .then((usage) => {
        const targetSessionId = (usage.sessionId || normalizedSessionId).trim();
        if (targetSessionId !== normalizedSessionId) return;
        setContextWindowUsageByConversation((current) =>
          contextUsageReadsRef.current.isCurrent(ticket) ? {
            ...current,
            [targetSessionId]: { ...usage, sessionId: targetSessionId },
          } : current,
        );
      })
      .catch(() => undefined)
      .finally(() => {
        if (contextWindowUsageRequestsRef.current.get(requestKey)?.promise === request) {
          contextWindowUsageRequestsRef.current.delete(requestKey);
        }
      });
    contextWindowUsageRequestsRef.current.set(requestKey, { promise: request, ticket });
    return request;
  }, [requestContext.contextWindowUsageAvailable]);

  useEffect(() => {
    const sessionId = activeConversationId.trim();
    if (!sessionId || messagesByConversation[sessionId]) {
      return;
    }
    let cancelled = false;
    const finishLoading = beginHistoryLoading(sessionId);
    async function loadMessages() {
      const historyRead = beginHistoryRead(sessionId);
      try {
        const [result, workspaceChanges] = await Promise.all([
          fetchSessionMessages(sessionId, { includeSuperseded: true }),
          requestContext.workspaceChangesAvailable === true
            ? fetchSessionWorkspaceChanges(sessionId).catch(() => [])
            : Promise.resolve([]),
        ]);
        if (!cancelled && isHistoryReadCurrent(historyRead)) {
          const loadedMessages = mergeWorkspaceChangeExecutions(
            result.messages,
            workspaceChanges,
          );
          applyHistoryRead(historyRead, loadedMessages);
          persistAutoConversationTitle(
            result.conversation,
            firstUserTitleSource(loadedMessages, ''),
          );
          void refreshMeasuredContextWindowUsage(
            sessionId,
            result.latestTurn,
          );
          if (result.conversation.projectDir || result.conversation.workspaceContext) {
            setConversations((current) =>
              current.map((item) =>
                item.id === sessionId
                  ? {
                      ...item,
                      projectDir: result.conversation.projectDir,
                      workspaceContext: result.conversation.workspaceContext,
                    }
                  : item,
              ),
            );
          }
          setError(null);
        }
      } catch (caught) {
        if (!cancelled && isHistoryReadCurrent(historyRead)) {
          setError(errorMessage(caught));
          applyHistoryRead(historyRead, []);
        }
      } finally {
        finishLoading();
      }
    }
    void loadMessages();
    return () => {
      cancelled = true;
      finishLoading();
    };
  }, [
    activeConversationId,
    messagesByConversation,
    persistAutoConversationTitle,
    refreshMeasuredContextWindowUsage,
    requestContext.workspaceChangesAvailable,
    setMessageHistoryLoading,
    beginHistoryRead,
    isHistoryReadCurrent,
    applyHistoryRead,
    beginHistoryLoading,
  ]);

  const activeConversation = useMemo(
    () =>
      conversations.find((item) => item.id === activeConversationId) ??
      Object.values(preparedConversationsByScope).find(
        (item) => item.id === activeConversationId,
      ),
    [activeConversationId, conversations, preparedConversationsByScope],
  );

  const activeMessages = activeConversationId
    ? messagesByConversation[activeConversationId] ?? []
    : [];
  const activeTeamFlow = activeConversationId
    ? teamFlowsByConversation[activeConversationId] ?? null
    : null;
  const activeTeamFlowLoading = activeConversationId
    ? teamFlowLoadingByConversation[activeConversationId] === true
    : false;
  const activeTeamFlowAction = activeConversationId
    ? teamFlowActionByConversation[activeConversationId] ?? ''
    : '';
  const activeContextWindowUsage = activeConversationId
    ? contextWindowUsageByConversation[activeConversationId]
    : undefined;
  const activeGoal = activeConversationId
    ? goalByConversation[activeConversationId] ?? null
    : null;
  const activeGoalCancelling = activeConversationId
    ? goalCancellingByConversation[activeConversationId] === true
    : false;
  const activeGoalWaiting =
    activeGoal?.status === 'active' &&
    !sending;

  useEffect(() => {
    let cancelled = false;
    void fetchGoalRuntimeStatus()
      .then((status) => {
        if (!cancelled) {
          setGoalAvailable(status.enabled === true);
          if (status.enabled !== true) {
            setGoalByConversation({});
          }
        }
      })
      .catch(() => {
        if (!cancelled) {
          setGoalAvailable(false);
          setGoalByConversation({});
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshGoal = useCallback(async (sessionId: string) => {
    const normalized = sessionId.trim();
    if (!normalized || !goalAvailable) {
      return null;
    }
    try {
      const goals = await fetchExperimentalGoals(normalized);
      const current = currentExperimentalGoal(goals) ?? null;
      setGoalByConversation((state) => ({ ...state, [normalized]: current }));
      return current;
    } catch {
      // Preserve the last confirmed state across transient sidecar failures.
      return null;
    }
  }, [goalAvailable]);

  const applyGoalExecution = useCallback((
    sessionId: string,
    execution: ChatToolExecution,
  ) => {
    const update = goalToolUpdateFromExecution(execution);
    if (!update) {
      return;
    }
    setGoalByConversation((state) => {
      const current = state[sessionId];
      const next = applyGoalToolUpdate(current, update);
      return next === current ? state : { ...state, [sessionId]: next };
    });
  }, []);

  useEffect(() => {
    const sessionId = activeConversationId.trim();
    if (!sessionId || !goalAvailable) {
      return;
    }
    void refreshGoal(sessionId);
  }, [activeConversationId, goalAvailable, refreshGoal]);

  const mergeContextWindowUsage = useCallback(
    (sessionId: string, usage: RuntimeContextWindowUsage) => {
      const normalized = (usage.sessionId || sessionId).trim();
      if (!normalized) {
        return;
      }
      contextUsageReadsRef.current.invalidate(normalized);
      setContextWindowUsageByConversation((current) => ({
        ...current,
        [normalized]: { ...usage, sessionId: normalized },
      }));
    },
    [],
  );

  const markSessionRunning = useCallback((sessionId: string, turnId = '') => {
    const normalized = sessionId.trim();
    if (!normalized) {
      return;
    }
    clearSessionAttention(normalized);
    contextUsageReadsRef.current.invalidate(normalized);
    historyReadsRef.current.invalidate(normalized);
    liveTranscriptSessionsRef.current.add(normalized);
    sendingSessionsRef.current.add(normalized);
    if (turnId.trim()) {
      activeTurnIdsRef.current[normalized] = turnId.trim();
    }
    setProcessingConversationIds((current) => {
      if (current.has(normalized)) return current;
      const next = new Set(current);
      next.add(normalized);
      return next;
    });
    setRunningByConversation((current) => ({
      ...current,
      [normalized]: {
        activeTurnId: turnId.trim() || current[normalized]?.activeTurnId || '',
        stopping: current[normalized]?.stopping ?? false,
      },
    }));
  }, [clearSessionAttention]);

  const markSessionDone = useCallback((sessionId: string) => {
    const normalized = sessionId.trim();
    if (!normalized) return;
    if (liveTranscriptSessionsRef.current.delete(normalized)) {
      // A read begun before the commit must not become eligible just because
      // the live flag has now cleared. A new terminal read can still proceed.
      historyReadsRef.current.invalidate(normalized);
      contextUsageReadsRef.current.invalidate(normalized);
    }
    setProcessingConversationIds((current) => {
      if (!current.has(normalized)) return current;
      const next = new Set(current);
      next.delete(normalized);
      return next;
    });
  }, []);

  const markSessionStopping = useCallback((sessionId: string, value: boolean) => {
    const normalized = sessionId.trim();
    if (!normalized) return;
    setRunningByConversation((current) => {
      const running = current[normalized];
      if (!running || running.stopping === value) return current;
      return {
        ...current,
        [normalized]: { ...running, stopping: value },
      };
    });
  }, []);

  const clearSessionRunning = useCallback((sessionId: string) => {
    const normalized = sessionId.trim();
    if (!normalized) {
      return;
    }
    sendingSessionsRef.current.delete(normalized);
    stoppingRequestsRef.current.delete(normalized);
    delete activeTurnIdsRef.current[normalized];
    markSessionDone(normalized);
    setRunningByConversation((current) => {
      if (!(normalized in current)) {
        return current;
      }
      const next = { ...current };
      delete next[normalized];
      return next;
    });
  }, [markSessionDone]);

  const isSessionSending = useCallback(
    (sessionId: string) => sendingSessionsRef.current.has(sessionId.trim()),
    [],
  );

  const reloadConversations = useCallback(async () => {
    const loadedConversations = await fetchConversations();
    setConversations((current) =>
      mergeLoadedConversationsPreservingLocalTitles(current, loadedConversations),
    );
    setActiveConversationId((current) =>
      loadedConversations.some((item) => item.id === current)
        ? current
        : Object.values(preparedConversationsRef.current).some(
            (item) => item.id === current,
          )
          ? current
          : '',
    );
  }, []);

  const reloadSkills = useCallback(async () => {
    const loadedSkills = await fetchSkills();
    setSkills(loadedSkills);
    return loadedSkills;
  }, []);


  const loadSkillDetail = useCallback(
    (skillName: string): Promise<SkillDetail> => fetchSkillDetail(skillName),
    [],
  );

  const loadTeamFlow = useCallback(
    async (sessionId = activeConversationId, options?: { silent?: boolean }) => {
      const normalized = sessionId.trim();
      if (!normalized || requestContext.teamModeEnabled !== true) {
        return null;
      }
      if (!options?.silent) {
        setTeamFlowLoadingByConversation((current) => ({
          ...current,
          [normalized]: true,
        }));
      }
      try {
        const flow = await fetchTeamFlow(normalized);
        setTeamFlowsByConversation((current) => ({
          ...current,
          [normalized]: flow,
        }));
        return flow;
      } catch (caught) {
        if (!isNotFoundLikeError(caught)) {
          if (!options?.silent) {
            setError(errorMessage(caught));
          }
        }
        setTeamFlowsByConversation((current) => ({
          ...current,
          [normalized]: null,
        }));
        return null;
      } finally {
        if (!options?.silent) {
          setTeamFlowLoadingByConversation((current) => ({
            ...current,
            [normalized]: false,
          }));
        }
      }
    },
    [activeConversationId, requestContext.teamModeEnabled],
  );

  const mergeTeamFlowStreamEvent = useCallback(
    (sessionId: string, event: TeamFlowStreamEvent) => {
      const normalized = (event.sessionId ?? sessionId).trim();
      if (!normalized) {
        return;
      }
      setTeamFlowsByConversation((current) => ({
        ...current,
        [normalized]: mergeTeamFlowEvent(current[normalized], event, normalized),
      }));
    },
    [],
  );

  const subscribeGoalTurn = useCallback((sessionId: string, turnId: string) => {
    const normalizedSessionId = sessionId.trim();
    const normalizedTurnId = turnId.trim();
    if (!normalizedSessionId || !normalizedTurnId || controllersRef.current[normalizedSessionId]) {
      return;
    }
    const current = goalTurnControllersRef.current[normalizedSessionId];
    if (current?.turnId === normalizedTurnId) {
      return;
    }
    current?.controller.abort();
    const controller = new AbortController();
    goalTurnControllersRef.current[normalizedSessionId] = {
      turnId: normalizedTurnId,
      controller,
    };
    const assistantId = `goal-turn-${normalizedTurnId}`;
    const initialCursor = goalTurnCursorRef.current[normalizedTurnId] ?? {
      sequence: 0,
      lastEventId: '',
    };
    const ensureAssistant = (createdAt?: string) => {
      setMessagesByConversation((state) =>
        ensureBackgroundTurnAssistant(
          state,
          normalizedSessionId,
          assistantId,
          normalizedTurnId,
          createdAt,
        ),
      );
    };
    const streamBuffer = createSegmentedAssistantStreamBuffers(
      (delta, route, release) => {
        ensureAssistant(route.createdAt);
        setMessagesByConversation((state) =>
          appendAssistantDelta(
            state,
            normalizedSessionId,
            assistantId,
            delta,
            route,
            release,
          ),
        );
      },
      { shouldAnimate: () => activeConversationIdRef.current === normalizedSessionId },
    );
    markSessionRunning(normalizedSessionId, normalizedTurnId);
    void streamTurnEvents({
      sessionId: normalizedSessionId,
      turnId: normalizedTurnId,
      afterSequence: initialCursor.sequence,
      lastEventId: initialCursor.lastEventId,
      signal: controller.signal,
      onEventCursor: (cursor) => {
        const previous = goalTurnCursorRef.current[normalizedTurnId];
        goalTurnCursorRef.current[normalizedTurnId] = {
          sequence: Math.max(previous?.sequence ?? 0, cursor.sequence),
          lastEventId: cursor.eventId || previous?.lastEventId || '',
        };
      },
      onStart: (start) => {
        ensureAssistant(start.createdAt);
        markSessionRunning(normalizedSessionId, start.turnId || normalizedTurnId);
      },
      onDelta: (delta, chunk) => streamBuffer.push(delta, chunk),
      onAssistantSegmentCompleted: (content, chunk) => {
        void streamBuffer.completeSegment(content, chunk);
      },
      onExecution: (update) => {
        if (isTurnGuidanceBoundary(update)) {
          ensureAssistant();
          setMessagesByConversation((state) =>
            applyAssistantSegmentBoundary(
              state,
              normalizedSessionId,
              assistantId,
              update,
            ),
          );
        }
      },
      onAssistantRevision: (revision) => {
        if (revision.channel && revision.channel !== 'assistant') return;
        ensureAssistant();
        const route = {
          messageId: revision.messageId ?? '',
          assistantSegmentIndex: revision.assistantSegmentIndex,
          turnId: revision.turnId ?? normalizedTurnId,
        };
        const animateFinal = revision.reason === 'assistant_final' && Boolean(revision.content);
        streamBuffer.flushToolBoundary(animateFinal ? route : undefined);
        streamBuffer.reset(route, animateFinal ? '' : revision.content ?? '');
        setMessagesByConversation((state) =>
          applyAssistantRevision(
            state,
            normalizedSessionId,
            assistantId,
            animateFinal ? { ...revision, content: '' } : revision,
          ),
        );
        if (animateFinal) {
          void streamBuffer.completeRoute(revision.content ?? '', route);
        }
      },
      onToolExecution: (execution) => {
        void streamBuffer.releaseToolBoundary().then(() => {
          ensureAssistant();
          applyGoalExecution(normalizedSessionId, execution);
          setMessagesByConversation((state) =>
            appendToolExecution(
              state,
              normalizedSessionId,
              assistantId,
              execution,
            ),
          );
        });
      },
      onTaskPlanUpdate: (update) => {
        ensureAssistant();
        setMessagesByConversation((state) =>
          applyTaskPlanUpdate(
            state,
            normalizedSessionId,
            assistantId,
            update,
          ),
        );
      },
      onInteractiveRequest: (interaction) => {
        setPendingInteraction((current) => keepFirstPendingInteraction(
          current,
          {
            ...interaction,
            sessionId: interaction.sessionId ?? normalizedSessionId,
          },
          activeConversationIdRef.current,
        ));
        markSessionAttention(
          normalizedSessionId,
          'waiting',
          localize('目标需要你的确认，点击继续处理。', 'The goal needs your input. Click to continue.'),
          interaction.turnId ?? normalizedTurnId,
        );
      },
      onFinalAssistantText: (text, chunk) => {
        ensureAssistant(chunk.createdAt);
        void streamBuffer.completeRoute(text, chunk).then(() => {
          setMessagesByConversation((state) =>
            markLocalAssistantTurnCompleted(
              state,
              normalizedSessionId,
              assistantId,
              new Date().toISOString(),
              chunk,
              text,
            ),
          );
        });
      },
      onDone: (terminal) => {
        clearConnectionRecovery(normalizedSessionId);
        markSessionDone(normalizedSessionId);
        setPendingInteraction((current) =>
          current?.sessionId === normalizedSessionId ? null : current,
        );
        if (!terminal.stopped && terminal.status === 'completed') {
          void streamBuffer.releaseTerminal();
        } else {
          void streamBuffer.flushAllStreaming();
        }
      },
      onMessages: (nextMessages, finalSnapshot) => {
        void (finalSnapshot
          ? streamBuffer.releaseTerminal()
          : streamBuffer.flushAllStreaming()).then(() => {
          setMessagesByConversation((state) =>
            finalSnapshot
              ? mergeFinalStreamMessages(state, normalizedSessionId, nextMessages, {
                  turnId: normalizedTurnId,
                  temporaryMessageIds: [assistantId],
                  toolSourceMessageId: assistantId,
                })
              : mergeMessages(state, normalizedSessionId, nextMessages),
          );
        });
      },
      onTeamFlowEvent: (event) => mergeTeamFlowStreamEvent(normalizedSessionId, event),
      onSubagentDispatch: (event) => emitSubagentDispatch({
        ...event,
        parentSessionId: event.parentSessionId || normalizedSessionId,
      }),
      onThinking: (event) => {
        if (requestContext.reasoningTraceVisible !== true) return;
        window.dispatchEvent(new CustomEvent('cardbush:thinking', {
          detail: { ...event, sessionId: normalizedSessionId },
        }));
      },
      onConnectionState: (update) =>
        applyConnectionRecoveryUpdate(normalizedSessionId, update),
      onContextWindowUsage: (usage) =>
        mergeContextWindowUsage(normalizedSessionId, usage),
      onWorkflowEvent: (event) => {
        window.dispatchEvent(new CustomEvent('cardbush:workflow-event', {
          detail: { ...event, sessionId: event.sessionId || normalizedSessionId },
        }));
      },
      onSceneEvent: (event) => {
        window.dispatchEvent(new CustomEvent('cardbush:scene-event', {
          detail: { ...event, sessionId: event.sessionId || normalizedSessionId },
        }));
      },
      onReplayReset: () => {
        delete goalTurnCursorRef.current[normalizedTurnId];
      },
    })
      .catch((caught) => {
        if (!controller.signal.aborted) {
          console.warn('[cardbush:goal] turn event stream ended', {
            sessionId: normalizedSessionId,
            turnId: normalizedTurnId,
            error: errorMessage(caught),
          });
        }
      })
      .finally(async () => {
        await streamBuffer.flushAllStreaming();
        streamBuffer.dispose();
        const historyRead = beginHistoryRead(normalizedSessionId);
        const loaded = await fetchSessionMessages(normalizedSessionId, {
          includeSuperseded: true,
        }).catch(() => null);
        const allowLive = loaded?.latestTurn?.turnId === normalizedTurnId;
        if (loaded && isHistoryReadCurrent(historyRead, undefined, allowLive)) {
          applyHistoryRead(historyRead, loaded.messages, undefined, allowLive);
          setGoalLatestTurnByConversation((state) => ({
            ...state,
            [normalizedSessionId]: loaded.latestTurn,
          }));
        }
        const refreshedGoal = await refreshGoal(normalizedSessionId);
        let turnStillRunning = false;
        if (
          goalTurnControllersRef.current[normalizedSessionId]?.controller === controller
        ) {
          delete goalTurnControllersRef.current[normalizedSessionId];
          if (!controllersRef.current[normalizedSessionId]) {
            clearSessionRunning(normalizedSessionId);
          }
        }
        if (!turnStillRunning && refreshedGoal?.status === 'complete') {
          markSessionAttention(
            normalizedSessionId,
            'completed',
            truncateText(refreshedGoal.statusReason || refreshedGoal.objective, 180),
            normalizedTurnId,
          );
        } else if (!turnStillRunning && refreshedGoal?.status === 'blocked') {
          markSessionAttention(
            normalizedSessionId,
            'waiting',
            truncateText(refreshedGoal.statusReason || refreshedGoal.objective, 180),
            normalizedTurnId,
          );
        }
      });
  }, [
    applyConnectionRecoveryUpdate,
    applyGoalExecution,
    clearConnectionRecovery,
    clearSessionRunning,
    localize,
    markSessionAttention,
    markSessionDone,
    markSessionRunning,
    mergeContextWindowUsage,
    mergeTeamFlowStreamEvent,
    refreshGoal,
    beginHistoryRead,
    isHistoryReadCurrent,
    applyHistoryRead,
  ]);

  const refreshActiveSession = useCallback(async (options?: { silent?: boolean }) => {
    const sessionId = activeConversationId.trim();
    if (!sessionId) {
      await reloadConversations();
      return;
    }
    const historyRead = beginHistoryRead(sessionId);
    const finishLoading = options?.silent ? () => undefined : beginHistoryLoading(sessionId);
    try {
      const [result, workspaceChanges] = await Promise.all([
        fetchSessionMessages(sessionId, { includeSuperseded: true }),
        requestContext.workspaceChangesAvailable === true
          ? fetchSessionWorkspaceChanges(sessionId).catch(() => [])
          : Promise.resolve([]),
      ]);
      if (!isHistoryReadCurrent(historyRead)) return;
      const loadedMessages = mergeWorkspaceChangeExecutions(
        result.messages,
        workspaceChanges,
      );
      applyHistoryRead(historyRead, loadedMessages);
      persistAutoConversationTitle(
        result.conversation,
        firstUserTitleSource(loadedMessages, ''),
      );
      await refreshMeasuredContextWindowUsage(sessionId, result.latestTurn);
      await loadTeamFlow(sessionId, { silent: true }).catch(() => null);
      await refreshGoal(sessionId);
      await reloadConversations().catch(() => undefined);
      if (!options?.silent) {
        setError(null);
      }
    } catch (caught) {
      if (!isHistoryReadCurrent(historyRead)) return;
      await reloadConversations().catch(() => undefined);
      if (!options?.silent) {
        setError(errorMessage(caught));
      }
      throw caught;
    } finally {
      finishLoading();
    }
  }, [
    activeConversationId,
    loadTeamFlow,
    refreshGoal,
    refreshMeasuredContextWindowUsage,
    reloadConversations,
    persistAutoConversationTitle,
    requestContext.workspaceChangesAvailable,
    setMessageHistoryLoading,
    beginHistoryRead,
    isHistoryReadCurrent,
    applyHistoryRead,
    beginHistoryLoading,
  ]);

  useEffect(() => {
    const sessionId = activeConversationId.trim();
    if (!sessionId) {
      setPendingInteraction(null);
      return;
    }
    setPendingInteraction((current) =>
      current?.sessionId === sessionId ? current : null,
    );
    let cancelled = false;
    fetchPendingInteraction(sessionId)
      .then((interaction) => {
        if (!cancelled) {
          setPendingInteraction(interaction);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [activeConversationId]);

  useEffect(() => {
    const sessionId = activeConversationId.trim();
    const goalId = activeGoal?.goalId.trim() ?? '';
    if (
      !goalAvailable ||
      !sessionId ||
      !goalId ||
      activeGoal?.status !== 'active'
    ) {
      return;
    }

    let cancelled = false;
    let timer: number | undefined;

    const schedule = (delay = goalPollingDelayMs()) => {
      if (cancelled) return;
      timer = window.setTimeout(() => void poll(), delay);
    };

    const poll = async () => {
      const historyRead = beginHistoryRead(sessionId);
      try {
        const [sessionRequest, goalsRequest, interactionRequest] =
          await Promise.allSettled([
            fetchSessionMessages(sessionId, { includeSuperseded: true }),
            fetchExperimentalGoals(sessionId),
            fetchPendingInteraction(sessionId),
          ]);
        if (cancelled) return;

        if (sessionRequest.status === 'fulfilled' && isHistoryReadCurrent(historyRead)) {
          const sessionResult = sessionRequest.value;
          applyHistoryRead(historyRead, sessionResult.messages, mergePolledMessagesPreservingLocalState);
          setGoalLatestTurnByConversation((current) => ({
            ...current,
            [sessionId]: sessionResult.latestTurn,
          }));
          if (!controllersRef.current[sessionId]) {
            clearSessionRunning(sessionId);
          }
        }

        if (goalsRequest.status === 'fulfilled') {
          const goals = goalsRequest.value;
          const latestGoal =
            goals.find((item) => item.goalId === goalId) ??
            currentExperimentalGoal(goals) ??
            null;
          setGoalByConversation((current) => ({
            ...current,
            [sessionId]: latestGoal,
          }));
        }

        if (interactionRequest.status === 'fulfilled') {
          const interaction = interactionRequest.value;
          setPendingInteraction((current) =>
            !current || current.sessionId === sessionId ? interaction : current,
          );
        }
      } finally {
        schedule();
      }
    };

    const handleVisibilityChange = () => {
      if (timer) window.clearTimeout(timer);
      schedule(document.visibilityState === 'visible' ? 0 : goalPollingDelayMs());
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    schedule(goalPollingDelayMs());
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [
    activeConversationId,
    activeGoal?.goalId,
    activeGoal?.status,
    clearSessionRunning,
    goalAvailable,
    markSessionRunning,
    subscribeGoalTurn,
    beginHistoryRead,
    isHistoryReadCurrent,
    applyHistoryRead,
  ]);

  useEffect(() => {
    if (requestContext.teamModeEnabled !== true) {
      return;
    }
    void loadTeamFlow(activeConversationId, { silent: true });
  }, [activeConversationId, loadTeamFlow, requestContext.teamModeEnabled]);

  const openConversation = useCallback(
    (conversationId: string) => {
      const normalized = conversationId.trim();
      if (
        !normalized ||
        (!conversations.some((item) => item.id === normalized) &&
          !Object.values(preparedConversationsRef.current).some(
            (item) => item.id === normalized,
          ))
      ) {
        return;
      }
      setMessageHistoryLoading(
        normalized,
        conversations.some((item) => item.id === normalized) &&
          messagesByConversation[normalized] === undefined,
      );
      setActiveConversationId(normalized);
      clearSessionAttention(normalized, 'completed');
    },
    [
      clearSessionAttention,
      conversations,
      messagesByConversation,
      setMessageHistoryLoading,
    ],
  );

  const clearConversationSelection = useCallback(() => {
    const current = activeConversationIdRef.current.trim();
    if (current) setMessageHistoryLoading(current, false);
    setActiveConversationId('');
    setPendingInteraction(null);
    setError(null);
  }, [setMessageHistoryLoading]);

  const prepareConversation = useCallback((
    projectDir?: string,
    initialTitle?: string,
    projectId?: string,
  ) => {
    const normalizedProjectDir = projectDir?.trim() || undefined;
    const normalizedProjectId = projectId?.trim() || undefined;
    const scope: ConversationScope = normalizedProjectDir
      ? {
          mode: 'project',
          projectId: normalizedProjectId,
          projectDir: normalizedProjectDir,
        }
      : { mode: 'task' };
    const scopeKey = conversationScopeKey(scope);
    const existing = preparedConversationsRef.current[scopeKey];
    const draft = existing ?? localConversation(
      normalizedProjectDir,
      initialTitle,
      normalizedProjectId,
    );
    if (!existing) {
      const next = {
        ...preparedConversationsRef.current,
        [scopeKey]: draft,
      };
      preparedConversationsRef.current = next;
      setPreparedConversationsByScope(next);
    }
    setMessagesByConversation((current) => ({
      ...current,
      [draft.id]: current[draft.id] ?? [],
    }));
    setMessageHistoryLoading(draft.id, false);
    setActiveConversationId(draft.id);
    setError(null);
    return draft;
  }, [setMessageHistoryLoading]);

  const persistPreparedConversation = useCallback(async (
    conversation: ConversationSummary,
  ): Promise<ConversationSummary> => {
    const prepared = Object.values(preparedConversationsRef.current).find(
      (item) => item.id === conversation.id,
    );
    if (!prepared) return conversation;
    const inFlight = conversationCreationPromisesRef.current.get(prepared.id);
    if (inFlight) return inFlight;

    const creation = (async () => {
      let created: ConversationSummary;
      try {
        created = await createConversation({
          sessionId: prepared.id,
          title: prepared.title,
          projectId: conversationProjectId(prepared) || undefined,
          projectDir: conversationProjectDir(prepared) || undefined,
        });
      } catch (caught) {
        const existing = (await fetchConversations().catch(() => []))
          .find((item) => item.id === prepared.id);
        if (!existing) throw caught;
        created = existing;
      }
      const synced: ConversationSummary = {
        ...prepared,
        ...created,
        id: prepared.id,
        projectId:
          created.projectId ?? (conversationProjectId(prepared) || undefined),
        projectDir:
          created.projectDir ?? (conversationProjectDir(prepared) || undefined),
        title: mergeSyncedConversationTitle(
          prepared.title,
          created.title,
          prepared.id,
        ),
      };
      setConversations((current) => [
        synced,
        ...current.filter((item) => item.id !== synced.id),
      ]);
      const nextPrepared = Object.fromEntries(
        Object.entries(preparedConversationsRef.current)
          .filter(([, item]) => item.id !== prepared.id),
      );
      preparedConversationsRef.current = nextPrepared;
      setPreparedConversationsByScope(nextPrepared);
      return synced;
    })();
    conversationCreationPromisesRef.current.set(prepared.id, creation);
    try {
      return await creation;
    } catch (caught) {
      setError(errorMessage(caught));
      throw caught;
    } finally {
      if (conversationCreationPromisesRef.current.get(prepared.id) === creation) {
        conversationCreationPromisesRef.current.delete(prepared.id);
      }
    }
  }, []);

  const startConversation = useCallback(async (
    projectDir?: string,
    initialTitle?: string,
    projectId?: string,
  ) => {
    const optimistic = localConversation(projectDir, initialTitle, projectId);
    setConversations((current) => [
      optimistic,
      ...current.filter((item) => item.id !== optimistic.id),
    ]);
    setMessagesByConversation((current) => ({
      ...current,
      [optimistic.id]: current[optimistic.id] ?? [],
    }));
    setMessageHistoryLoading(optimistic.id, false);
    setActiveConversationId(optimistic.id);
    setError(null);

    void createConversation({
      sessionId: optimistic.id,
      title: optimistic.title,
      projectId,
      projectDir,
    })
      .then((created) => {
        const synced = {
          ...created,
          id: optimistic.id,
          projectId: created.projectId ?? projectId,
          projectDir: created.projectDir ?? projectDir,
        };
        setConversations((current) =>
          current.map((item) =>
            item.id === optimistic.id
              ? {
                  ...item,
                  ...synced,
                  id: optimistic.id,
                  title: mergeSyncedConversationTitle(item.title, synced.title, optimistic.id),
                }
              : item,
          ),
        );
      })
      .catch(() => undefined);

    return optimistic;
  }, [setMessageHistoryLoading]);

  const deleteConversation = useCallback(async (conversationId: string) => {
    try {
      await deleteConversationApi(conversationId);
    } catch (caught) {
      setError(errorMessage(caught));
      return;
    }
    historyReadsRef.current.invalidate(conversationId.trim());
    contextUsageReadsRef.current.invalidate(conversationId.trim());
    clearSessionAttention(conversationId);
    setMessageHistoryLoading(conversationId, false);
    setConversations((current) => current.filter((item) => item.id !== conversationId));
    setActiveConversationId((active) => active === conversationId ? '' : active);
    setMessagesByConversation((current) => {
      const next = { ...current };
      delete next[conversationId];
      return next;
    });
  }, [clearSessionAttention, setMessageHistoryLoading]);

  const renameConversation = useCallback(async (conversationId: string, title: string) => {
    const normalizedId = conversationId.trim();
    const nextTitle = title.trim();
    if (!normalizedId || !nextTitle) return false;
    const previous = conversationsRef.current.find((item) => item.id === normalizedId);
    if (!previous) return false;
    if (previous.title.trim() === nextTitle) return true;
    setConversations((current) =>
      current.map((item) =>
        item.id === normalizedId ? { ...item, title: nextTitle } : item,
      ),
    );
    try {
      const synced = await updateConversation({ sessionId: normalizedId, title: nextTitle });
      setConversations((current) =>
        current.map((item) =>
          item.id === normalizedId
            ? {
                ...item,
                ...synced,
                id: normalizedId,
                title: synced.title?.trim() || nextTitle,
              }
            : item,
        ),
      );
      setError(null);
      return true;
    } catch (caught) {
      setConversations((current) =>
        current.map((item) =>
          item.id === normalizedId && item.title === nextTitle
            ? { ...item, title: previous.title }
            : item,
        ),
      );
      setError(errorMessage(caught));
      return false;
    }
  }, []);

  const setConversationProject = useCallback(async (
    conversationId: string,
    projectDir: string | null,
    projectId?: string | null,
  ) => {
    const sessionId = conversationId.trim();
    if (!sessionId) return;
    const normalizedProjectDir = projectDir?.trim() || undefined;
    const normalizedProjectId = projectId === undefined
      ? undefined
      : projectId?.trim() || null;
    const preparedEntry = Object.entries(preparedConversationsRef.current)
      .find(([, item]) => item.id === sessionId);
    if (preparedEntry) {
      const [previousScopeKey, draft] = preparedEntry;
      const updatedDraft: ConversationSummary = {
        ...draft,
        projectId: normalizedProjectId || undefined,
        projectDir: normalizedProjectDir,
        workspaceContext: undefined,
        metadata: {
          ...(draft.metadata ?? {}),
          workspace_mode: normalizedProjectDir ? 'project' : 'task',
          project_id: normalizedProjectId,
        },
      };
      const nextScopeKey = conversationScopeKey(normalizedProjectDir
        ? {
            mode: 'project',
            projectId: normalizedProjectId || undefined,
            projectDir: normalizedProjectDir,
          }
        : { mode: 'task' });
      const nextPrepared = { ...preparedConversationsRef.current };
      delete nextPrepared[previousScopeKey];
      nextPrepared[nextScopeKey] = updatedDraft;
      preparedConversationsRef.current = nextPrepared;
      setPreparedConversationsByScope(nextPrepared);
      setError(null);
      return;
    }
    const previous = conversationsRef.current.find((item) => item.id === sessionId);
    setConversations((current) =>
      current.map((item) => {
        if (item.id !== sessionId) return item;
        return {
          ...item,
          projectId:
            normalizedProjectId === undefined
              ? item.projectId
              : normalizedProjectId || undefined,
          projectDir: normalizedProjectDir,
          workspaceContext: undefined,
        };
      }),
    );
    try {
      const synced = await updateConversation({
        sessionId,
        projectId: normalizedProjectDir
          ? normalizedProjectId
          : null,
        projectDir: normalizedProjectDir ?? null,
      });
      setConversations((current) =>
        current.map((item) =>
          item.id === sessionId
            ? {
                ...item,
                ...synced,
                id: sessionId,
                projectId:
                  synced.projectId ?? normalizedProjectId ?? item.projectId,
                projectDir: synced.projectDir ?? normalizedProjectDir,
              }
            : item,
        ),
      );
    } catch (caught) {
      if (previous) {
        const snapshot = previous;
        setConversations((current) =>
          current.map((item) => item.id === sessionId ? snapshot : item),
        );
      }
      setError(errorMessage(caught));
      throw caught;
    }
  }, []);

  const relocateProjectConversations = useCallback(async (
    projectId: string,
    previousProjectDir: string,
    nextProjectDir: string,
  ) => {
    const normalizedProjectId = projectId.trim();
    const previousRoot = previousProjectDir.trim();
    const nextRoot = nextProjectDir.trim();
    if (!normalizedProjectId || !previousRoot || !nextRoot) {
      throw new Error('Project relocation requires an id and both paths.');
    }
    const targets = conversationsRef.current.filter((conversation) => {
      const sessionProjectId = conversationProjectId(conversation);
      if (sessionProjectId) return sessionProjectId === normalizedProjectId;
      const sessionProjectDir = conversationProjectDir(conversation);
      return Boolean(sessionProjectDir && samePath(sessionProjectDir, previousRoot));
    });
    const completed: ConversationSummary[] = [];
    try {
      for (const snapshot of targets) {
        const aliases = appendProjectPathAlias(
          snapshot.metadata?.project_path_aliases,
          previousRoot,
          nextRoot,
        );
        const synced = await updateConversation({
          sessionId: snapshot.id,
          projectId: normalizedProjectId,
          projectDir: nextRoot,
          metadata: { project_path_aliases: aliases },
        });
        completed.push(snapshot);
        setConversations((current) => current.map((item) =>
          item.id === snapshot.id
            ? {
                ...item,
                ...synced,
                id: snapshot.id,
                projectId: normalizedProjectId,
                projectDir: nextRoot,
                workspaceContext: undefined,
              }
            : item,
        ));
      }
    } catch (caught) {
      for (const snapshot of completed.reverse()) {
        await updateConversation({
          sessionId: snapshot.id,
          projectId: conversationProjectId(snapshot) || null,
          projectDir: conversationProjectDir(snapshot) || null,
          metadata: {
            project_path_aliases: snapshot.metadata?.project_path_aliases ?? null,
          },
        }).catch(() => undefined);
      }
      setConversations((current) => current.map((item) =>
        completed.find((snapshot) => snapshot.id === item.id) ?? item,
      ));
      throw caught;
    }

    const nextPrepared = Object.fromEntries(
      Object.entries(preparedConversationsRef.current).map(([scopeKey, draft]) => {
        const draftProjectId = conversationProjectId(draft);
        const draftProjectDir = conversationProjectDir(draft);
        if (
          draftProjectId !== normalizedProjectId &&
          !(draftProjectDir && samePath(draftProjectDir, previousRoot))
        ) {
          return [scopeKey, draft];
        }
        const updated: ConversationSummary = {
          ...draft,
          projectId: normalizedProjectId,
          projectDir: nextRoot,
          metadata: {
            ...(draft.metadata ?? {}),
            project_id: normalizedProjectId,
          },
        };
        const nextScopeKey = conversationScopeKey({
          mode: 'project',
          projectId: normalizedProjectId,
          projectDir: nextRoot,
        });
        return [nextScopeKey, updated];
      }),
    );
    preparedConversationsRef.current = nextPrepared;
    setPreparedConversationsByScope(nextPrepared);
    return targets.length;
  }, []);

  const recoverInterruptedSession = useCallback(async ({
    sessionId,
    turnId,
    signal,
    reason,
  }: {
    sessionId: string;
    turnId?: string;
    signal: AbortSignal;
    reason: string;
  }) => {
    let failedAttempts = 0;
    const deadline = Date.now() + 10 * 60 * 1000;
    while (!signal.aborted && Date.now() < deadline) {
      const nextRetryMs = failedAttempts > 0
        ? Math.min(800 * (2 ** (failedAttempts - 1)), 5000)
        : 0;
      setConnectionRecoveryByConversation((current) => ({
        ...current,
        [sessionId]: {
          state: 'retrying',
          source: 'network',
          sessionId,
          turnId,
          attempt: failedAttempts + 1,
          nextRetryMs,
          reason,
          createdAt: new Date().toISOString(),
        },
      }));
      if (nextRetryMs > 0) {
        await waitForRecoveryDelay(nextRetryMs);
      }
      if (signal.aborted) {
        return false;
      }
      try {
        const historyRead = beginHistoryRead(sessionId);
        const sessionResult = await fetchSessionMessages(sessionId, {
          includeSuperseded: true,
        });
        if (signal.aborted) return false;
        // A committed terminal for this exact Turn may reconcile a disconnected
        // live projection. An older Turn may not replace that projection.
        const allowLive = Boolean(turnId && sessionResult.latestTurn?.turnId === turnId);
        if (!isHistoryReadCurrent(historyRead, undefined, allowLive)) {
          failedAttempts += 1;
          if (failedAttempts >= 5) break;
          continue;
        }
        applyHistoryRead(historyRead, sessionResult.messages, undefined, allowLive);
        setGoalLatestTurnByConversation((current) => ({
          ...current,
          [sessionId]: sessionResult.latestTurn,
        }));
        failedAttempts = 0;
        setConnectionRecoveryByConversation((current) => ({
          ...current,
          [sessionId]: undefined,
        }));
        void reloadConversations().catch(() => undefined);
        return true;
      } catch {
        failedAttempts += 1;
        if (failedAttempts >= 5) {
          break;
        }
      }
    }
    if (!signal.aborted) {
      setConnectionRecoveryByConversation((current) => ({
        ...current,
        [sessionId]: {
          state: 'failed',
          source: 'network',
          sessionId,
          turnId,
          attempt: Math.max(1, failedAttempts),
          reason,
          createdAt: new Date().toISOString(),
        },
      }));
    }
    return false;
  }, [reloadConversations, beginHistoryRead, isHistoryReadCurrent, applyHistoryRead]);

  const sendMessage = useCallback(
    async (text: string, queuedConversation?: ConversationSummary, queuedTeamId?: string, queuedTeamName?: string) => {
      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }
      const outbound = splitStreamAttachmentMentions(trimmed);
      const optimisticAttachments = await chatAttachmentsFromOutbound(outbound);
      const attachments = streamAttachmentsForVision(
        outbound,
        requestContext.standardImageInputEnabled === true,
      );
      const visibleUserInput =
        outbound.displayInput ||
        optimisticAttachments.map((attachment) => attachment.name).join(', ') ||
        outbound.userInput;
      if (!selectedModel.trim()) {
        setError(localize('请先在设置中配置模型', 'Configure a model in Settings first'));
        return;
      }
      const candidate =
        queuedConversation ??
        activeConversation ??
        prepareConversation(
          requestContext.defaultProjectDir?.trim() || undefined,
          conversationTitleFromUserText(visibleUserInput),
          requestContext.defaultProjectId?.trim() || undefined,
        );
      const sessionId = candidate.id;
      const turnTeamId = (queuedTeamId ?? requestContext.selectedTeamId)?.trim() || undefined;
      const turnTeamName = (queuedTeamName ?? requestContext.selectedTeamName)?.trim() || undefined;
      setConnectionRecoveryByConversation((current) => ({
        ...current,
        [sessionId]: undefined,
      }));
      const previousMessages = messagesByConversation[sessionId] ?? [];
      const titleSource = firstUserTitleSource(previousMessages, visibleUserInput);
      if (isSessionSending(sessionId)) {
        enqueueMessage({
          id: `queued-${crypto.randomUUID()}`,
          text: trimmed,
          conversation: candidate,
          createdAt: new Date().toISOString(),
          teamId: turnTeamId,
          teamName: turnTeamName,
        });
        return;
      }
      markSessionRunning(sessionId);
      let conversation: ConversationSummary;
      try {
        conversation = await persistPreparedConversation(candidate);
      } catch {
        clearSessionRunning(sessionId);
        return;
      }
      const projectDir = conversationProjectRequestDir(conversation);
      const workspaceDir = conversationWorkspaceRoot(conversation);
      const projectUserPrompt = mergedRequestContextPrompt(
        projectDir ? requestContext.projectContexts?.[projectKey(projectDir)]?.trim() : '',
        requestContext.teamModeEnabled === true,
      );
      const userMessageId = `user-${crypto.randomUUID()}`;
      const submittedAt = new Date().toISOString();
      const userMessage: ChatMessage = {
        id: userMessageId,
        clientMessageId: userMessageId,
        role: 'user',
        content: outbound.displayInput,
        conversationId: sessionId,
        createdAt: submittedAt,
        attachments:
          optimisticAttachments.length > 0 ? optimisticAttachments : undefined,
        status: 'pending',
        metadata: {
          message_delivery: 'pending',
          ...(turnTeamId ? { team_id: turnTeamId, team_name: turnTeamName ?? turnTeamId } : {}),
        },
      };
      const assistantId = `assistant-${crypto.randomUUID()}`;
      const assistantMessage: ChatMessage = {
        id: assistantId,
        role: 'assistant',
        content: '',
        conversationId: sessionId,
        createdAt: submittedAt,
        metadata: {
          optimistic_request_id: userMessage.id,
        },
      };

      setMessagesByConversation((current) => ({
        ...current,
        [sessionId]: [...(current[sessionId] ?? []), userMessage, assistantMessage],
      }));
      setConversations((current) =>
        upsertConversationPreview(
          current,
          conversation,
          visibleUserInput,
          titleSource,
        ),
      );
      persistAutoConversationTitle(conversation, titleSource);
      setError(null);
      const controller = new AbortController();
      const streamBuffer = createSegmentedAssistantStreamBuffers(
        (delta, route, release) => {
          setMessagesByConversation((current) =>
            appendAssistantDelta(current, sessionId, assistantId, delta, route, release),
          );
        },
        { shouldAnimate: () => activeConversationIdRef.current === sessionId },
      );
      controllersRef.current[sessionId] = controller;
      let finalSnapshotPromise: Promise<void> | null = null;
      let finalAssistantText = '';
      let streamStarted = false;
      let terminalSnapshot: TurnTerminalSnapshot | null = null;

      try {
        await streamChat({
          sessionId,
          userInput: outbound.userInput,
          submittedAt,
          model: selectedModelName(managedModelConfigs, selectedModel),
          modelConfig: modelConfigFor(managedModelConfigs, selectedModel),
          projectDir,
          workspaceDir,
          projectUserPrompt,
          allowedSkills: skills
            .map((skill) => skill.name)
            .filter((name) => !requestContext.disabledSkillNames?.has(name)),
          referencePlanMode,
          permissionMode,
          subagentPermissionRouting,
          reasoningLevel,
          reasoningTraceVisible: requestContext.reasoningTraceVisible === true,
          interactiveRequestsEnabled:
            requestContext.interactiveRequestsAvailable === true,
          standardImageInputEnabled: requestContext.standardImageInputEnabled === true,
          browserPrivacyMode: requestContext.browserPrivacyMode === true,
          teamModeEnabled: requestContext.teamModeEnabled === true,
          teamId: turnTeamId,
          terminalRuntime: requestContext.terminalRuntime,
          disabledTools: normalizeDisabledToolNames(requestContext.disabledToolNames),
          images: attachments.images,
          files: attachments.files,
          attachments: optimisticAttachments,
          signal: controller.signal,
          onStart: (start) => {
            streamStarted = true;
            markSessionRunning(sessionId, start.turnId);
            void refreshGoal(sessionId);
            setMessagesByConversation((current) =>
              markOptimisticChatRequestAccepted(
                assignTurnToLocalMessages(current, sessionId, start.turnId, [
                  userMessage.id,
                  assistantId,
                ], {
                  messageId: start.messageId ?? '',
                  assistantSegmentIndex: start.assistantSegmentIndex,
                  turnId: start.turnId,
                  createdAt: start.createdAt,
                }),
                sessionId,
                userMessage.id,
              ),
            );
          },
          onDelta: (delta, chunk) => {
            streamBuffer.push(delta, chunk);
          },
          onAssistantSegmentCompleted: (content, chunk) => {
            void streamBuffer.completeSegment(content, chunk);
          },
          onExecution: (update) => {
            if (isTurnGuidanceBoundary(update)) {
              setMessagesByConversation((current) =>
                applyAssistantSegmentBoundary(
                  current,
                  sessionId,
                  assistantId,
                  update,
                ),
              );
            }
          },
          onAssistantRevision: (revision) => {
            if (revision.channel && revision.channel !== 'assistant') {
              return;
            }
            // A revision is a hard assistant-segment boundary. Drain any token
            // text already received for the prior segment before resetting its
            // animation buffer, otherwise a short pre-tool sentence can vanish.
            const route = {
              messageId: revision.messageId ?? '',
              assistantSegmentIndex: revision.assistantSegmentIndex,
              turnId: revision.turnId ?? activeTurnIdsRef.current[sessionId] ?? '',
            };
            const animateFinal = revision.reason === 'assistant_final' && Boolean(revision.content);
            streamBuffer.flushToolBoundary(animateFinal ? route : undefined);
            streamBuffer.reset(route, animateFinal ? '' : revision.content ?? '');
            setMessagesByConversation((current) =>
              applyAssistantRevision(
                current,
                sessionId,
                assistantId,
                animateFinal ? { ...revision, content: '' } : revision,
              ),
            );
            if (animateFinal) {
              finalSnapshotPromise = streamBuffer.completeRoute(revision.content ?? '', route);
            }
          },
          onToolExecution: (execution) => {
            void streamBuffer.releaseToolBoundary().then(() => {
              applyGoalExecution(sessionId, execution);
              setMessagesByConversation((current) =>
                appendToolExecution(current, sessionId, assistantId, execution),
              );
            });
          },
          onContextWindowUsage: (usage) => {
            mergeContextWindowUsage(sessionId, usage);
          },
          onTaskPlanUpdate: (update) => {
            setMessagesByConversation((current) =>
              applyTaskPlanUpdate(current, sessionId, assistantId, update),
            );
          },
          onInteractiveRequest: (interaction) => {
            setPendingInteraction((current) => keepFirstPendingInteraction(
              current,
              {
                ...interaction,
                sessionId: interaction.sessionId ?? sessionId,
              },
              activeConversationIdRef.current,
            ));
            markSessionAttention(
              sessionId,
              'waiting',
              localize('需要你的确认，点击继续处理。', 'Your input is required. Click to continue.'),
              interaction.turnId ?? activeTurnIdsRef.current[sessionId] ?? '',
            );
          },
          onFinalAssistantText: (text, chunk) => {
            finalAssistantText = text;
            finalSnapshotPromise = streamBuffer.completeRoute(text, chunk).then(() => {
              setMessagesByConversation((current) =>
                markLocalAssistantTurnCompleted(
                  current,
                  sessionId,
                  assistantId,
                  new Date().toISOString(),
                  chunk,
                  text,
                ),
              );
            });
          },
          onDone: (terminal) => {
            clearConnectionRecovery(sessionId);
            markSessionDone(sessionId);
            setPendingInteraction((current) =>
              current?.sessionId === sessionId ? null : current,
            );
            terminalSnapshot = withTerminalTurnId(
              terminal,
              activeTurnIdsRef.current[sessionId],
            );
            if (terminalSnapshot.turnId) {
              terminalTurnIdsRef.current.add(terminalSnapshot.turnId);
            }
            const terminalReveal = !terminalSnapshot.stopped && terminalSnapshot.status === 'completed'
              ? streamBuffer.releaseTerminal()
              : streamBuffer.flushAllStreaming();
            finalSnapshotPromise ??= terminalReveal;
            setMessagesByConversation((current) =>
              applyTurnTerminalSnapshot(
                current,
                sessionId,
                assistantId,
                terminalSnapshot!,
              ),
            );
          },
          onMessages: (nextMessages, finalSnapshot) => {
            if (finalSnapshot) {
              const turnId = activeTurnIdsRef.current[sessionId];
              finalSnapshotPromise = streamBuffer.releaseTerminal().then(() => {
                setMessagesByConversation((current) =>
                  mergeFinalStreamMessages(current, sessionId, nextMessages, {
                    turnId,
                    temporaryMessageIds: [userMessage.id, assistantId],
                    toolSourceMessageId: assistantId,
                  }),
                );
              });
              return;
            }
            void streamBuffer.flushAllStreaming().then(() => {
              setMessagesByConversation((current) =>
                mergeMessages(current, sessionId, nextMessages),
              );
            });
          },
          onTeamFlowEvent: (event) => {
            mergeTeamFlowStreamEvent(sessionId, event);
          },
          onSubagentDispatch: (event) => {
            emitSubagentDispatch({
              ...event,
              parentSessionId: event.parentSessionId || sessionId,
            });
          },
          onThinking: (event) => {
            if (requestContext.reasoningTraceVisible !== true) return;
            window.dispatchEvent(new CustomEvent('cardbush:thinking', {
              detail: { ...event, sessionId },
            }));
          },
          onConnectionState: (update) => {
            applyConnectionRecoveryUpdate(sessionId, update);
          },
          onWorkflowEvent: (event) => {
            window.dispatchEvent(new CustomEvent('cardbush:workflow-event', {
              detail: { ...event, sessionId: event.sessionId || sessionId },
            }));
          },
          onSceneEvent: (event) => {
            window.dispatchEvent(new CustomEvent('cardbush:scene-event', {
              detail: { ...event, sessionId: event.sessionId || sessionId },
            }));
          },
        });
        if (finalSnapshotPromise) {
          await finalSnapshotPromise;
        }
        await loadTeamFlow(sessionId, { silent: true }).catch(() => null);
        const historyRead = beginHistoryRead(sessionId);
        const loadedMessages = await fetchMessages(sessionId, {
          includeSuperseded: true,
        }).catch(() => null);
        if (loadedMessages && loadedMessages.length > 0) {
          applyHistoryRead(historyRead, loadedMessages);
        }
        const refreshedGoal = await refreshGoal(sessionId);
        if (refreshedGoal?.status !== 'active') {
          markSessionAttention(
            sessionId,
            'completed',
            truncateText(finalAssistantText.replace(/\s+/g, ' ').trim(), 180),
            activeTurnIdsRef.current[sessionId] ?? '',
          );
        }
        void reloadConversations().catch(() => undefined);
      } catch (caught) {
        if (isPendingInteractionConflictError(caught)) {
          setMessagesByConversation((current) => ({
            ...current,
            [sessionId]: (current[sessionId] ?? []).filter(
              (item) => item.id !== userMessage.id && item.id !== assistantId,
            ),
          }));
          setError(null);
          return;
        }
        if (!streamStarted) {
          setMessagesByConversation((current) =>
            markOptimisticChatRequestFailed(
              current,
              sessionId,
              userMessage.id,
              assistantId,
            ),
          );
          if (!controller.signal.aborted) {
            setError(errorMessage(caught));
            markSessionAttention(
              sessionId,
              'error',
              errorMessage(caught),
              activeTurnIdsRef.current[sessionId] ?? '',
            );
          }
          console.warn('[cardbush:chat] request ended before SSE start', {
            sessionId,
            clientMessageId: userMessage.id,
            aborted: controller.signal.aborted,
            error: errorMessage(caught),
          });
          return;
        }
        if (!controller.signal.aborted) {
          const turnId = activeTurnIdsRef.current[sessionId];
          if (isNetworkTransportError(caught)) {
            const recovered = await recoverInterruptedSession({
              sessionId,
              turnId,
              signal: controller.signal,
              reason: rawErrorMessage(caught),
            });
            setError(recovered ? null : errorMessage(caught));
            if (recovered) {
              const refreshedGoal = await refreshGoal(sessionId);
              if (refreshedGoal?.status !== 'active') {
                markSessionAttention(
                  sessionId,
                  'completed',
                  truncateText(finalAssistantText.replace(/\s+/g, ' ').trim(), 180),
                  turnId,
                );
              }
            } else {
              markSessionAttention(sessionId, 'error', errorMessage(caught), turnId);
            }
            return;
          }
          const historyRead = beginHistoryRead(sessionId);
          const loadedMessages = await fetchMessages(sessionId, {
            includeSuperseded: true,
          }).catch(() => null);
          if (loadedMessages && loadedMessages.length > 0) {
            applyHistoryRead(historyRead, loadedMessages, undefined,
              hasCompletedAssistantForTurn(loadedMessages, turnId));
            void reloadConversations().catch(() => undefined);
          }
          if (loadedMessages && hasCompletedAssistantForTurn(loadedMessages, turnId)) {
            setError(null);
            markSessionAttention(
              sessionId,
              'completed',
              truncateText(finalAssistantText.replace(/\s+/g, ' ').trim(), 180),
              turnId,
            );
          } else {
            setError(errorMessage(caught));
            markSessionAttention(sessionId, 'error', errorMessage(caught), turnId);
          }
        }
      } finally {
        await streamBuffer.flushAllStreaming();
        streamBuffer.dispose();
        const terminalTurnId = activeTurnIdsRef.current[sessionId] ?? '';
        if (controllersRef.current[sessionId] === controller) {
          delete controllersRef.current[sessionId];
          clearSessionRunning(sessionId);
        }
        if (terminalTurnId) terminalTurnIdsRef.current.delete(terminalTurnId);
        const nextQueued = dequeueMessageForConversation(sessionId);
        if (nextQueued) {
          window.setTimeout(() => {
            void sendMessageRef.current(
              nextQueued.text,
              nextQueued.conversation,
              nextQueued.teamId,
              nextQueued.teamName,
            );
          }, 0);
        }
      }
    },
    [
      activeConversation,
      applyGoalExecution,
      beginHistoryRead,
      applyHistoryRead,
      applyConnectionRecoveryUpdate,
      clearConnectionRecovery,
      clearSessionRunning,
      dequeueMessageForConversation,
      enqueueMessage,
      isSessionSending,
      loadTeamFlow,
      localize,
      markSessionAttention,
      markSessionDone,
      markSessionRunning,
      mergeTeamFlowStreamEvent,
      mergeContextWindowUsage,
      reloadConversations,
      refreshGoal,
      recoverInterruptedSession,
      managedModelConfigs,
      messagesByConversation,
      persistAutoConversationTitle,
      requestContext.disabledSkillNames,
      requestContext.disabledToolNames,
      requestContext.browserPrivacyMode,
      requestContext.defaultProjectDir,
      requestContext.defaultProjectId,
      requestContext.interactiveRequestsAvailable,
      requestContext.reasoningTraceVisible,
      requestContext.teamModeEnabled,
      requestContext.selectedTeamId,
      requestContext.selectedTeamName,
      requestContext.standardImageInputEnabled,
      requestContext.projectContexts,
      referencePlanMode,
      permissionMode,
      persistPreparedConversation,
      prepareConversation,
      subagentPermissionRouting,
      reasoningLevel,
      selectedModel,
      skills,
    ],
  );

  const retryFailedUserMessage = useCallback(
    async (message: ChatMessage) => {
      if (String(message.metadata?.message_delivery ?? '').trim() !== 'failed') {
        return;
      }
      const sessionId =
        message.conversationId?.trim() || activeConversationId.trim();
      if (!sessionId || isSessionSending(sessionId)) {
        return;
      }
      const conversation =
        conversations.find((item) => item.id === sessionId) ??
        (activeConversation?.id === sessionId ? activeConversation : undefined);
      if (!conversation) {
        setError(localize('未找到原会话，无法重试消息', 'The original conversation was not found, so the message cannot be retried'));
        return;
      }
      const projectPathAliases = conversationProjectPathAliases(conversation);
      const attachmentMentions = (message.attachments ?? [])
        .map((attachment) => attachment.path?.trim() ?? '')
        .filter(Boolean)
        .map((pathValue) => `@${remapProjectPath(pathValue, projectPathAliases)}`);
      const retryText = [...attachmentMentions, message.content.trim()]
        .filter(Boolean)
        .join('\n');
      if (!retryText) {
        return;
      }
      setMessagesByConversation((current) => ({
        ...current,
        [sessionId]: (current[sessionId] ?? []).filter(
          (candidate) => candidate.id !== message.id,
        ),
      }));
      await sendMessage(retryText, conversation);
    },
    [
      activeConversation,
      activeConversationId,
      conversations,
      isSessionSending,
      sendMessage,
    ],
  );

  useEffect(() => {
    sendMessageRef.current = sendMessage;
  }, [sendMessage]);

  const runControlAssistantStream = useCallback(
    async ({
      conversation,
      initialMessages,
      rollbackMessages,
      tempAssistant,
      startedMessageIds,
      temporaryMessageIds,
      stream,
    }: {
      conversation: ConversationSummary;
      initialMessages: ChatMessage[];
      rollbackMessages: ChatMessage[];
      tempAssistant: ChatMessage;
      startedMessageIds?: string[];
      temporaryMessageIds?: string[];
      stream: (
        controller: AbortController,
        handlers: {
          onStart: (start: import('../types').StreamStart) => void;
          onDelta: (delta: string, chunk: AssistantStreamChunk) => void;
          onAssistantSegmentCompleted: (
            content: string,
            chunk: AssistantStreamChunk,
          ) => void;
          onExecution: (update: StreamExecutionUpdate) => void;
          onAssistantRevision: (revision: AssistantRevision) => void;
          onToolExecution: (execution: ChatToolExecution) => void;
          onContextWindowUsage: (usage: RuntimeContextWindowUsage) => void;
          onTaskPlanUpdate: (update: TaskPlanStreamUpdate) => void;
          onInteractiveRequest: (interaction: PendingInteraction) => void;
          onFinalAssistantText: (text: string, chunk: AssistantStreamChunk) => void;
          onDone: (terminal: TurnTerminalSnapshot) => void;
          onMessages: (messages: ChatMessage[], finalSnapshot: boolean) => void;
          onTeamFlowEvent: (event: TeamFlowStreamEvent) => void;
          onSubagentDispatch: (event: SubagentDispatchEvent) => void;
          onThinking: (event: import('../types').ThinkingStreamEvent) => void;
          onConnectionState: (update: RuntimeConnectionUpdate) => void;
          onWorkflowEvent: (event: TeamWorkflowStreamEvent) => void;
          onSceneEvent: (event: SceneStreamEvent) => void;
        },
      ) => Promise<void>;
    }) => {
      const sessionId = conversation.id;
      const controller = new AbortController();
      let finalSnapshot: ChatMessage[] | null = null;
      const streamBuffer = createSegmentedAssistantStreamBuffers(
        (delta, route, release) => {
          setMessagesByConversation((current) =>
            appendAssistantDelta(
              current,
              sessionId,
              tempAssistant.id,
              delta,
              route,
              release,
            ),
          );
        },
        { shouldAnimate: () => activeConversationIdRef.current === sessionId },
      );
      const startIds = new Set(startedMessageIds ?? [tempAssistant.id]);
      const replacementIds = temporaryMessageIds ?? [tempAssistant.id];
      let finalSnapshotPromise: Promise<void> | null = null;
      let finalAssistantText = '';
      let streamStarted = false;
      let terminalSnapshot: TurnTerminalSnapshot | null = null;
      controllersRef.current[sessionId] = controller;
      markSessionRunning(sessionId);
      setError(null);
      setMessagesByConversation((current) => ({
        ...current,
        [sessionId]: initialMessages,
      }));
      setConversations((current) =>
        upsertConversationPreview(
          current,
          conversation,
          conversationPreviewFromMessages(initialMessages),
        ),
      );

      try {
        await stream(controller, {
          onStart: (start) => {
            streamStarted = true;
            markSessionRunning(sessionId, start.turnId);
            void refreshGoal(sessionId);
            const startedAt = new Date().toISOString();
            setMessagesByConversation((current) => ({
              ...current,
              [sessionId]: (current[sessionId] ?? initialMessages).map((item) =>
                startIds.has(item.id)
                  ? markLocalMessageTurnStarted(
                      applyAssistantStreamRoute(
                        { ...item, turnId: start.turnId, conversationId: sessionId },
                        item.role === 'assistant'
                          ? {
                              messageId: start.messageId ?? '',
                              assistantSegmentIndex: start.assistantSegmentIndex,
                              turnId: start.turnId,
                              createdAt: start.createdAt,
                            }
                          : undefined,
                      ),
                      startedAt,
                    )
                  : item,
              ),
            }));
          },
          onDelta: (delta, chunk) => {
            streamBuffer.push(delta, chunk);
          },
          onAssistantSegmentCompleted: (content, chunk) => {
            void streamBuffer.completeSegment(content, chunk);
          },
          onExecution: (update) => {
            if (isTurnGuidanceBoundary(update)) {
              setMessagesByConversation((current) =>
                applyAssistantSegmentBoundary(
                  current,
                  sessionId,
                  tempAssistant.id,
                  update,
                ),
              );
            }
          },
          onAssistantRevision: (revision) => {
            if (revision.channel && revision.channel !== 'assistant') {
              return;
            }
            const route = {
              messageId: revision.messageId ?? '',
              assistantSegmentIndex: revision.assistantSegmentIndex,
              turnId: revision.turnId ?? activeTurnIdsRef.current[sessionId] ?? '',
            };
            const animateFinal = revision.reason === 'assistant_final' && Boolean(revision.content);
            streamBuffer.flushToolBoundary(animateFinal ? route : undefined);
            streamBuffer.reset(route, animateFinal ? '' : revision.content ?? '');
            setMessagesByConversation((current) =>
              applyAssistantRevision(
                current,
                sessionId,
                tempAssistant.id,
                animateFinal ? { ...revision, content: '' } : revision,
              ),
            );
            if (animateFinal) {
              finalSnapshotPromise = streamBuffer.completeRoute(revision.content ?? '', route);
            }
          },
          onToolExecution: (execution) => {
            void streamBuffer.releaseToolBoundary().then(() => {
              applyGoalExecution(sessionId, execution);
              setMessagesByConversation((current) =>
                appendToolExecution(current, sessionId, tempAssistant.id, execution),
              );
            });
          },
          onContextWindowUsage: (usage) => {
            mergeContextWindowUsage(sessionId, usage);
          },
          onTaskPlanUpdate: (update) => {
            setMessagesByConversation((current) =>
              applyTaskPlanUpdate(current, sessionId, tempAssistant.id, update),
            );
          },
          onInteractiveRequest: (interaction) => {
            setPendingInteraction((current) => keepFirstPendingInteraction(
              current,
              {
                ...interaction,
                sessionId: interaction.sessionId ?? sessionId,
              },
              activeConversationIdRef.current,
            ));
            markSessionAttention(
              sessionId,
              'waiting',
              localize('需要你的确认，点击继续处理。', 'Your input is required. Click to continue.'),
              interaction.turnId ?? activeTurnIdsRef.current[sessionId] ?? '',
            );
          },
          onFinalAssistantText: (text, chunk) => {
            finalAssistantText = text;
            finalSnapshotPromise = streamBuffer.completeRoute(text, chunk).then(() => {
              setMessagesByConversation((current) =>
                markLocalAssistantTurnCompleted(
                  current,
                  sessionId,
                  tempAssistant.id,
                  new Date().toISOString(),
                  chunk,
                  text,
                ),
              );
            });
          },
          onDone: (terminal) => {
            clearConnectionRecovery(sessionId);
            markSessionDone(sessionId);
            setPendingInteraction((current) =>
              current?.sessionId === sessionId ? null : current,
            );
            terminalSnapshot = withTerminalTurnId(
              terminal,
              activeTurnIdsRef.current[sessionId] ?? tempAssistant.turnId,
            );
            if (terminalSnapshot.turnId) {
              terminalTurnIdsRef.current.add(terminalSnapshot.turnId);
            }
            const terminalReveal = !terminalSnapshot.stopped && terminalSnapshot.status === 'completed'
              ? streamBuffer.releaseTerminal()
              : streamBuffer.flushAllStreaming();
            finalSnapshotPromise ??= terminalReveal;
            setMessagesByConversation((current) =>
              applyTurnTerminalSnapshot(
                current,
                sessionId,
                tempAssistant.id,
                terminalSnapshot!,
              ),
            );
          },
          onMessages: (nextMessages, finalSnapshotEvent) => {
            if (finalSnapshotEvent) {
              finalSnapshot = nextMessages;
              const turnId = activeTurnIdsRef.current[sessionId] ?? tempAssistant.turnId;
              finalSnapshotPromise = streamBuffer.releaseTerminal().then(() => {
                setMessagesByConversation((current) =>
                  mergeFinalStreamMessages(current, sessionId, nextMessages, {
                    turnId,
                    temporaryMessageIds: replacementIds,
                    toolSourceMessageId: tempAssistant.id,
                  }),
                );
              });
              return;
            }
            void streamBuffer.flushAllStreaming().then(() => {
              setMessagesByConversation((current) =>
                mergeMessages(current, sessionId, nextMessages),
              );
            });
          },
          onTeamFlowEvent: (event) => {
            mergeTeamFlowStreamEvent(sessionId, event);
          },
          onSubagentDispatch: (event) => {
            emitSubagentDispatch({
              ...event,
              parentSessionId: event.parentSessionId || sessionId,
            });
          },
          onThinking: (event) => {
            if (requestContext.reasoningTraceVisible !== true) return;
            window.dispatchEvent(new CustomEvent('cardbush:thinking', {
              detail: { ...event, sessionId },
            }));
          },
          onConnectionState: (update) => {
            applyConnectionRecoveryUpdate(sessionId, update);
          },
          onWorkflowEvent: (event) => {
            window.dispatchEvent(new CustomEvent('cardbush:workflow-event', {
              detail: { ...event, sessionId: event.sessionId || sessionId },
            }));
          },
          onSceneEvent: (event) => {
            window.dispatchEvent(new CustomEvent('cardbush:scene-event', {
              detail: { ...event, sessionId: event.sessionId || sessionId },
            }));
          },
        });
        if (finalSnapshotPromise) {
          await finalSnapshotPromise;
        }

        await loadTeamFlow(sessionId, { silent: true }).catch(() => null);
        const historyRead = beginHistoryRead(sessionId);
        const loadedMessages = await fetchMessages(sessionId, {
          includeSuperseded: true,
        }).catch(() => finalSnapshot);
        if (loadedMessages && loadedMessages.length > 0) {
          applyHistoryRead(historyRead, loadedMessages);
        }
        const refreshedGoal = await refreshGoal(sessionId);
        if (refreshedGoal?.status !== 'active') {
          markSessionAttention(
            sessionId,
            'completed',
            truncateText(finalAssistantText.replace(/\s+/g, ' ').trim(), 180),
            activeTurnIdsRef.current[sessionId] ?? tempAssistant.turnId ?? '',
          );
        }
        void reloadConversations().catch(() => undefined);
      } catch (caught) {
        if (
          streamStarted &&
          !controller.signal.aborted &&
          isNetworkTransportError(caught)
        ) {
          const recovered = await recoverInterruptedSession({
            sessionId,
            turnId: activeTurnIdsRef.current[sessionId] ?? tempAssistant.turnId,
            signal: controller.signal,
            reason: rawErrorMessage(caught),
          });
          setError(recovered ? null : errorMessage(caught));
          const turnId = activeTurnIdsRef.current[sessionId] ?? tempAssistant.turnId;
          if (recovered) {
            const refreshedGoal = await refreshGoal(sessionId);
            if (refreshedGoal?.status !== 'active') {
              markSessionAttention(
                sessionId,
                'completed',
                truncateText(finalAssistantText.replace(/\s+/g, ' ').trim(), 180),
                turnId,
              );
            }
          } else {
            markSessionAttention(sessionId, 'error', errorMessage(caught), turnId);
          }
          return;
        }
        if (!controller.signal.aborted && !isPendingInteractionConflictError(caught)) {
          setError(errorMessage(caught));
          markSessionAttention(
            sessionId,
            'error',
            errorMessage(caught),
            activeTurnIdsRef.current[sessionId] ?? tempAssistant.turnId,
          );
        } else if (isPendingInteractionConflictError(caught)) {
          setError(null);
        }
        const terminalTurnId =
          activeTurnIdsRef.current[sessionId] ?? tempAssistant.turnId ?? '';
        const terminalAbort =
          controller.signal.aborted &&
          Boolean(terminalTurnId) &&
          terminalTurnIdsRef.current.has(terminalTurnId);
        if (!terminalAbort) {
          setMessagesByConversation((current) => ({
            ...current,
            [sessionId]: rollbackMessages,
          }));
        }
      } finally {
        await streamBuffer.flushAllStreaming();
        streamBuffer.dispose();
        const terminalTurnId =
          activeTurnIdsRef.current[sessionId] ?? tempAssistant.turnId ?? '';
        if (controllersRef.current[sessionId] === controller) {
          delete controllersRef.current[sessionId];
          clearSessionRunning(sessionId);
        }
        if (terminalTurnId) terminalTurnIdsRef.current.delete(terminalTurnId);
      }
    },
    [
      clearSessionRunning,
      applyConnectionRecoveryUpdate,
      beginHistoryRead,
      applyHistoryRead,
      applyGoalExecution,
      clearConnectionRecovery,
      loadTeamFlow,
      localize,
      markSessionAttention,
      markSessionDone,
      markSessionRunning,
      mergeContextWindowUsage,
      mergeTeamFlowStreamEvent,
      reloadConversations,
      refreshGoal,
      recoverInterruptedSession,
    ],
  );

  const regenerateAssistantMessage = useCallback(
    async (message: ChatMessage) => {
      const conversationId = message.conversationId?.trim() || activeConversationId;
      if (isSessionSending(conversationId)) {
        return;
      }
      const conversation =
        conversations.find((item) => item.id === conversationId) ?? activeConversation;
      if (!conversation || !conversationId) {
        setError(localize('这条回复缺少会话信息，无法重新生成', 'This response is missing conversation information and cannot be regenerated'));
        return;
      }
      if (!selectedModel.trim()) {
        setError(localize('请先在设置中配置模型', 'Configure a model in Settings first'));
        return;
      }
      const messages = messagesByConversation[conversationId] ?? activeMessages;
      const index = messages.findIndex((item) => item.id === message.id);
      if (index < 0) {
        return;
      }
      let sourceUserMessage = findUserMessageForAssistantRegenerate(message, messages);
      let messageId = persistedChatMessageId(sourceUserMessage);
      let refreshFailed = false;
      if (!messageId) {
        const historyRead = beginHistoryRead(conversationId);
        const loadedMessages = await fetchMessages(conversationId, {
          includeSuperseded: true,
        }).catch((caught) => {
          refreshFailed = true;
          setError(localize(
            `刷新会话消息失败: ${errorMessage(caught)}`,
            `Failed to refresh conversation messages: ${errorMessage(caught)}`,
          ));
          return [] as ChatMessage[];
        });
        if (!isHistoryReadCurrent(historyRead)) return;
        if (loadedMessages.length > 0) {
          applyHistoryRead(historyRead, loadedMessages);
          sourceUserMessage = findUserMessageForAssistantRegenerate(
            message,
            loadedMessages,
          );
          messageId = persistedChatMessageId(sourceUserMessage);
        }
      }
      if (refreshFailed && !messageId) {
        return;
      }
      if (!sourceUserMessage || !messageId) {
        setError(localize(
          '未定位到可编辑的用户消息，无法重新生成。请编辑上一条用户消息重跑。',
          'No editable user message was found. Edit the previous user message and run it again.',
        ));
        return;
      }
      const userIndex = messages.findIndex((item) =>
        messageIdentityMatches(item, sourceUserMessage),
      );
      const keptMessages = userIndex >= 0 ? messages.slice(0, userIndex) : messages.slice(0, index);
      const createdAt = new Date().toISOString();
      const replayedUser: ChatMessage = {
        ...sourceUserMessage,
        conversationId,
        createdAt,
      };
      const replayAttachments = streamAttachmentsFromChatAttachments(
        sourceUserMessage.attachments,
        requestContext.standardImageInputEnabled === true,
      );
      const tempAssistant: ChatMessage = {
        ...message,
        id: `assistant-regenerate-${crypto.randomUUID()}`,
        role: 'assistant',
        content: '',
        toolExecutions: [],
        taskPlan: undefined,
        loopHistory: [],
        conversationId,
        createdAt,
      };
      const initialMessages = [...keptMessages, replayedUser, tempAssistant];
      const projectDir = conversationProjectRequestDir(conversation);
      const workspaceDir = conversationWorkspaceRoot(conversation);
      const projectUserPrompt = mergedRequestContextPrompt(
        projectDir ? requestContext.projectContexts?.[projectKey(projectDir)]?.trim() : '',
        requestContext.teamModeEnabled === true,
      );
      const controlTeamId = teamIdFromMessage(sourceUserMessage) || requestContext.selectedTeamId;

      await runControlAssistantStream({
        conversation,
        initialMessages,
        rollbackMessages: messages,
        tempAssistant,
        startedMessageIds: [replayedUser.id, tempAssistant.id],
        temporaryMessageIds: uniqueMessageIds([
          message.id,
          replayedUser.id,
          tempAssistant.id,
        ]),
        stream: (controller, handlers) =>
          editMessage({
            sessionId: conversationId,
            messageId,
            content: sourceUserMessage.content,
            model: selectedModelName(managedModelConfigs, selectedModel),
            modelConfig: modelConfigFor(managedModelConfigs, selectedModel),
            projectDir,
            workspaceDir,
            projectUserPrompt,
            allowedSkills: skills
              .map((skill) => skill.name)
              .filter((name) => !requestContext.disabledSkillNames?.has(name)),
            referencePlanMode,
            permissionMode,
            subagentPermissionRouting,
            reasoningLevel,
            reasoningTraceVisible: requestContext.reasoningTraceVisible === true,
            interactiveRequestsEnabled:
              requestContext.interactiveRequestsAvailable === true,
            standardImageInputEnabled: requestContext.standardImageInputEnabled === true,
            browserPrivacyMode: requestContext.browserPrivacyMode === true,
            teamModeEnabled: requestContext.teamModeEnabled === true,
            teamId: controlTeamId,
            terminalRuntime: requestContext.terminalRuntime,
            disabledTools: normalizeDisabledToolNames(requestContext.disabledToolNames),
            images: replayAttachments.images,
            files: replayAttachments.files,
            attachments: sourceUserMessage.attachments,
            signal: controller.signal,
            ...handlers,
          }),
      });
    },
    [
      activeConversation,
      activeConversationId,
      activeMessages,
      beginHistoryRead,
      isHistoryReadCurrent,
      applyHistoryRead,
      conversations,
      isSessionSending,
      managedModelConfigs,
      messagesByConversation,
      requestContext.disabledSkillNames,
      requestContext.disabledToolNames,
      requestContext.browserPrivacyMode,
      requestContext.interactiveRequestsAvailable,
      requestContext.reasoningTraceVisible,
      requestContext.teamModeEnabled,
      requestContext.selectedTeamId,
      requestContext.projectContexts,
      requestContext.standardImageInputEnabled,
      requestContext.terminalRuntime,
      referencePlanMode,
      permissionMode,
      subagentPermissionRouting,
      reasoningLevel,
      runControlAssistantStream,
      sendMessage,
      selectedModel,
      skills,
    ],
  );

  const editUserMessageAndRegenerate = useCallback(
    async (message: ChatMessage, nextContent: string) => {
      const content = nextContent.trim();
      const outbound = splitStreamAttachmentMentions(content);
      const attachments = streamAttachmentsForVision(
        outbound,
        requestContext.standardImageInputEnabled === true,
      );
      const optimisticAttachments = await chatAttachmentsFromOutbound(outbound);
      const conversationId = message.conversationId?.trim() || activeConversationId;
      if (isSessionSending(conversationId)) {
        return;
      }
      const conversation =
        conversations.find((item) => item.id === conversationId) ?? activeConversation;
      if (!conversation || !conversationId || !content) {
        return;
      }
      if (!selectedModel.trim()) {
        setError(localize('请先在设置中配置模型', 'Configure a model in Settings first'));
        return;
      }
      const messages = messagesByConversation[conversationId] ?? activeMessages;
      const index = messages.findIndex((item) => item.id === message.id);
      if (index < 0) {
        return;
      }
      let editSourceMessage = findPersistedEditableUserMessage(message, messages);
      let messageId = persistedChatMessageId(editSourceMessage);
      let refreshFailed = false;
      if (!messageId) {
        const historyRead = beginHistoryRead(conversationId);
        const loadedMessages = await fetchMessages(conversationId, {
          includeSuperseded: true,
        }).catch((caught) => {
          refreshFailed = true;
          setError(localize(
            `刷新会话消息失败: ${errorMessage(caught)}`,
            `Failed to refresh conversation messages: ${errorMessage(caught)}`,
          ));
          return [] as ChatMessage[];
        });
        if (!isHistoryReadCurrent(historyRead)) return;
        if (loadedMessages.length > 0) {
          applyHistoryRead(historyRead, loadedMessages);
          editSourceMessage = findPersistedEditableUserMessage(
            message,
            loadedMessages,
          );
          messageId = persistedChatMessageId(editSourceMessage);
        }
      }
      if (refreshFailed && !messageId) {
        return;
      }
      if (!editSourceMessage || !messageId) {
        setError(localize(
          '未定位到原消息，更新重跑已取消，没有创建新轮次。',
          'The original message was not found. Update and rerun was cancelled without creating a new Turn.',
        ));
        return;
      }
      const editedAttachments = optimisticAttachments.length > 0
        ? optimisticAttachments
        : editSourceMessage.attachments?.map((attachment) => ({ ...attachment })) ?? [];
      const editedStreamAttachments = optimisticAttachments.length > 0
        ? attachments
        : streamAttachmentsFromChatAttachments(
            editedAttachments,
            requestContext.standardImageInputEnabled === true,
          );
      const createdAt = new Date().toISOString();
      const editedUser: ChatMessage = {
        ...editSourceMessage,
        content: outbound.displayInput,
        conversationId,
        turnId: undefined,
        createdAt,
        attachments: editedAttachments.length > 0 ? editedAttachments : undefined,
      };
      const tempAssistant: ChatMessage = {
        id: `assistant-edit-${crypto.randomUUID()}`,
        role: 'assistant',
        content: '',
        conversationId,
        createdAt,
      };
      const initialMessages = [
        ...messages.slice(0, index),
        editedUser,
        tempAssistant,
      ];
      const projectDir = conversationProjectRequestDir(conversation);
      const workspaceDir = conversationWorkspaceRoot(conversation);
      const projectUserPrompt = mergedRequestContextPrompt(
        projectDir ? requestContext.projectContexts?.[projectKey(projectDir)]?.trim() : '',
        requestContext.teamModeEnabled === true,
      );
      const controlTeamId = teamIdFromMessage(editSourceMessage) || requestContext.selectedTeamId;

      await runControlAssistantStream({
        conversation,
        initialMessages,
        rollbackMessages: messages,
        tempAssistant,
        startedMessageIds: [editedUser.id, tempAssistant.id],
        temporaryMessageIds: uniqueMessageIds([
          message.id,
          editedUser.id,
          tempAssistant.id,
        ]),
        stream: (controller, handlers) =>
          editMessage({
            sessionId: conversationId,
            messageId,
            content: outbound.userInput,
            model: selectedModelName(managedModelConfigs, selectedModel),
            modelConfig: modelConfigFor(managedModelConfigs, selectedModel),
            projectDir,
            workspaceDir,
            projectUserPrompt,
            allowedSkills: skills
              .map((skill) => skill.name)
              .filter((name) => !requestContext.disabledSkillNames?.has(name)),
            referencePlanMode,
            permissionMode,
            subagentPermissionRouting,
            reasoningLevel,
            reasoningTraceVisible: requestContext.reasoningTraceVisible === true,
            interactiveRequestsEnabled:
              requestContext.interactiveRequestsAvailable === true,
            standardImageInputEnabled: requestContext.standardImageInputEnabled === true,
            browserPrivacyMode: requestContext.browserPrivacyMode === true,
            teamModeEnabled: requestContext.teamModeEnabled === true,
            teamId: controlTeamId,
            terminalRuntime: requestContext.terminalRuntime,
            disabledTools: normalizeDisabledToolNames(requestContext.disabledToolNames),
            images: editedStreamAttachments.images,
            files: editedStreamAttachments.files,
            attachments: editedAttachments,
            signal: controller.signal,
            ...handlers,
          }),
      });
    },
    [
      activeConversation,
      activeConversationId,
      activeMessages,
      beginHistoryRead,
      isHistoryReadCurrent,
      applyHistoryRead,
      conversations,
      isSessionSending,
      managedModelConfigs,
      messagesByConversation,
      requestContext.disabledSkillNames,
      requestContext.disabledToolNames,
      requestContext.browserPrivacyMode,
      requestContext.interactiveRequestsAvailable,
      requestContext.reasoningTraceVisible,
      requestContext.teamModeEnabled,
      requestContext.selectedTeamId,
      requestContext.projectContexts,
      requestContext.standardImageInputEnabled,
      requestContext.terminalRuntime,
      referencePlanMode,
      permissionMode,
      subagentPermissionRouting,
      reasoningLevel,
      runControlAssistantStream,
      selectedModel,
      skills,
    ],
  );

  const sendTurnGuidance = useCallback(
    async (
      message: ChatMessage,
      guidance: string,
      mode: 'append_context' | 'interrupt_and_continue',
    ) => {
      const text = guidance.trim();
      if (!text) {
        return;
      }
      const turnId = message.turnId?.trim() ?? '';
      const conversationId = message.conversationId?.trim() || activeConversationId;
      const active = activeTurnIdsRef.current[conversationId]?.trim() ?? '';
      if (!isSessionSending(conversationId)) {
        const conversation =
          conversations.find((item) => item.id === conversationId) ?? activeConversation;
        await sendMessage(text, conversation);
        return;
      }
      if (!conversationId || !turnId || !active || active !== turnId) {
        setError(localize('当前回复尚未准备好插入引导，请稍后再试', 'This response is not ready for guidance yet. Try again shortly.'));
        return;
      }
      const clientMessageId = `guidance-${crypto.randomUUID()}`;
      const optimisticMessage = optimisticGuidanceMessage({
        clientMessageId,
        conversationId,
        turnId,
        content: text,
        mode,
      });
      setMessagesByConversation((current) => ({
        ...current,
        [conversationId]: [...(current[conversationId] ?? []), optimisticMessage],
      }));
      try {
        guidanceRequestIdsRef.current.add(clientMessageId);
        const result = await sendGuidance({
          sessionId: conversationId,
          turnId,
          guidance: text,
          clientMessageId,
          mode,
          terminalRuntime: requestContext.terminalRuntime,
          interactiveRequestsEnabled:
            requestContext.interactiveRequestsAvailable === true,
          onConnectionState: (update) => {
            applyConnectionRecoveryUpdate(conversationId, update);
          },
        });
        setMessagesByConversation((current) =>
          reconcileOptimisticGuidance(
            current,
            conversationId,
            clientMessageId,
            result.guidance.clientMessageId,
          ),
        );
        setError(null);
      } catch (caught) {
        if (runtimeErrorCode(caught) === 'turn_not_active' || runtimeErrorCode(caught) === 'turn_guidance_closed') {
          setMessagesByConversation((current) =>
            removeOptimisticGuidance(current, conversationId, clientMessageId),
          );
          const conversation =
            conversations.find((item) => item.id === conversationId) ?? activeConversation;
          if (!guidanceFallbackIdsRef.current.has(clientMessageId)) {
            guidanceFallbackIdsRef.current.add(clientMessageId);
            await sendMessageRef.current(text, conversation);
          }
          setError(null);
          return;
        }
        setMessagesByConversation((current) =>
          markOptimisticGuidanceFailed(current, conversationId, clientMessageId),
        );
        setError(localize(
          `引导发送失败: ${errorMessage(caught)}`,
          `Failed to send guidance: ${errorMessage(caught)}`,
        ));
      } finally {
        guidanceRequestIdsRef.current.delete(clientMessageId);
      }
    },
    [
      activeConversation,
      activeConversationId,
      applyConnectionRecoveryUpdate,
      conversations,
      isSessionSending,
      sendMessage,
      requestContext.terminalRuntime,
      requestContext.interactiveRequestsAvailable,
    ],
  );

  const sendQueuedMessageAsGuidance = useCallback(
    async (
      queuedId: string,
      mode: 'append_context' | 'interrupt_and_continue' = 'append_context',
    ) => {
      const queued = queuedMessagesRef.current.find((item) => item.id === queuedId);
      const text = queued?.text.trim() ?? '';
      const conversationId =
        queued?.conversation?.id?.trim() || activeConversationId.trim();
      if (!queued || !text) {
        return;
      }
      const active = activeTurnIdsRef.current[conversationId]?.trim() ?? '';
      if (!isSessionSending(conversationId) || !conversationId || !active) {
        setError(localize('当前回复尚未准备好插入引导，请稍后再试', 'This response is not ready for guidance yet. Try again shortly.'));
        return;
      }
      const clientMessageId = `guidance-${crypto.randomUUID()}`;
      const optimisticMessage = optimisticGuidanceMessage({
        clientMessageId,
        conversationId,
        turnId: active,
        content: text,
        mode,
      });
      setMessagesByConversation((current) => ({
        ...current,
        [conversationId]: [...(current[conversationId] ?? []), optimisticMessage],
      }));
      removeQueuedMessage(queuedId);
      try {
        guidanceRequestIdsRef.current.add(clientMessageId);
        const result = await sendGuidance({
          sessionId: conversationId,
          turnId: active,
          guidance: text,
          clientMessageId,
          mode,
          terminalRuntime: requestContext.terminalRuntime,
          interactiveRequestsEnabled:
            requestContext.interactiveRequestsAvailable === true,
          onConnectionState: (update) => {
            applyConnectionRecoveryUpdate(conversationId, update);
          },
        });
        setMessagesByConversation((current) =>
          reconcileOptimisticGuidance(
            current,
            conversationId,
            clientMessageId,
            result.guidance.clientMessageId,
          ),
        );
        setError(null);
      } catch (caught) {
        if (runtimeErrorCode(caught) === 'turn_not_active' || runtimeErrorCode(caught) === 'turn_guidance_closed') {
          setMessagesByConversation((current) =>
            removeOptimisticGuidance(current, conversationId, clientMessageId),
          );
          if (!guidanceFallbackIdsRef.current.has(clientMessageId)) {
            guidanceFallbackIdsRef.current.add(clientMessageId);
            await sendMessageRef.current(text, queued.conversation, queued.teamId, queued.teamName);
          }
          setError(null);
          return;
        }
        setMessagesByConversation((current) =>
          markOptimisticGuidanceFailed(current, conversationId, clientMessageId),
        );
        setError(localize(
          `引导发送失败: ${errorMessage(caught)}`,
          `Failed to send guidance: ${errorMessage(caught)}`,
        ));
      } finally {
        guidanceRequestIdsRef.current.delete(clientMessageId);
      }
    },
    [
      activeConversationId,
      applyConnectionRecoveryUpdate,
      isSessionSending,
      removeQueuedMessage,
      requestContext.interactiveRequestsAvailable,
      requestContext.terminalRuntime,
    ],
  );

  const retryTurnGuidance = useCallback(
    async (message: ChatMessage) => {
      const clientMessageId =
        message.clientMessageId?.trim() ||
        String(message.metadata?.client_message_id ?? '').trim() ||
        message.id.trim();
      const conversationId =
        message.conversationId?.trim() || activeConversationId.trim();
      const turnId = message.turnId?.trim() ?? '';
      const text = message.content.trim();
      const rawMode = String(
        message.metadata?.guidance_mode ?? message.metadata?.mode ?? 'append_context',
      );
      const mode = rawMode === 'interrupt_and_continue'
        ? 'interrupt_and_continue'
        : 'append_context';
      if (
        !clientMessageId ||
        !conversationId ||
        !turnId ||
        !text ||
        guidanceRequestIdsRef.current.has(clientMessageId)
      ) {
        return;
      }
      guidanceRequestIdsRef.current.add(clientMessageId);
      setMessagesByConversation((current) =>
        markOptimisticGuidancePending(current, conversationId, clientMessageId),
      );
      try {
        const result = await sendGuidance({
          sessionId: conversationId,
          turnId,
          guidance: text,
          clientMessageId,
          mode,
          terminalRuntime: requestContext.terminalRuntime,
          interactiveRequestsEnabled:
            requestContext.interactiveRequestsAvailable === true,
          onConnectionState: (update) => {
            applyConnectionRecoveryUpdate(conversationId, update);
          },
        });
        setMessagesByConversation((current) =>
          reconcileOptimisticGuidance(
            current,
            conversationId,
            clientMessageId,
            result.guidance.clientMessageId,
          ),
        );
        setError(null);
      } catch (caught) {
        const shouldFallback = runtimeErrorCode(caught) === 'turn_not_active' ||
          runtimeErrorCode(caught) === 'turn_guidance_closed';
        if (shouldFallback) {
          setMessagesByConversation((current) =>
            removeOptimisticGuidance(current, conversationId, clientMessageId),
          );
          if (!guidanceFallbackIdsRef.current.has(clientMessageId)) {
            guidanceFallbackIdsRef.current.add(clientMessageId);
            const conversation =
              conversations.find((item) => item.id === conversationId) ?? activeConversation;
            await sendMessageRef.current(text, conversation);
          }
          setError(null);
          return;
        }
        setMessagesByConversation((current) =>
          markOptimisticGuidanceFailed(current, conversationId, clientMessageId),
        );
        setError(localize(
          `引导发送失败: ${errorMessage(caught)}`,
          `Failed to send guidance: ${errorMessage(caught)}`,
        ));
      } finally {
        guidanceRequestIdsRef.current.delete(clientMessageId);
      }
    },
    [
      activeConversation,
      activeConversationId,
      applyConnectionRecoveryUpdate,
      conversations,
      requestContext.interactiveRequestsAvailable,
      requestContext.terminalRuntime,
    ],
  );

  const submitTeamFlowAction = useCallback(
    async (action: TeamFlowActionType, text?: string) => {
      const sessionId = activeConversationId.trim();
      const flow = sessionId ? teamFlowsByConversation[sessionId] : null;
      const flowId = (flow?.flowId || flow?.id || sessionId).trim();
      if (!sessionId || !flowId || requestContext.teamModeEnabled !== true) {
        return;
      }
      setTeamFlowActionByConversation((current) => ({
        ...current,
        [sessionId]: action,
      }));
      try {
        const result = await sendTeamFlowAction({
          flowId,
          action,
          text,
          metadata: { session_id: sessionId, source: 'cardbush_electron' },
        });
        setTeamFlowsByConversation((current) => ({
          ...current,
          [sessionId]: result,
        }));
        await loadTeamFlow(sessionId, { silent: true }).catch(() => null);
        setError(null);
      } catch (caught) {
        setError(errorMessage(caught));
      } finally {
        setTeamFlowActionByConversation((current) => ({
          ...current,
          [sessionId]: '',
        }));
      }
    },
    [
      activeConversationId,
      loadTeamFlow,
      requestContext.teamModeEnabled,
      teamFlowsByConversation,
    ],
  );

  const replyToInteraction = useCallback(
    async (reply: InteractionReplyAnswer[]) => {
      const interaction = pendingInteraction;
      if (!interaction) {
        return;
      }
      const sessionId = interaction.sessionId?.trim() || activeConversationId.trim();
      try {
        if (reply.length === 0) {
          return;
        }
        await replyInteraction({ interactionId: interaction.id, answers: reply });
        const nextInteraction = await fetchPendingInteraction(sessionId).catch(() => null);
        if (activeConversationIdRef.current.trim() === sessionId) {
          setPendingInteraction((current) =>
            current && current.id !== interaction.id
              ? current
              : nextInteraction,
          );
        }
        if (!nextInteraction) {
          clearSessionAttention(sessionId, 'waiting');
        }
        setError(null);
      } catch (caught) {
        if (isInteractionGoneError(caught)) {
          const nextInteraction = await fetchPendingInteraction(sessionId).catch(() => null);
          if (activeConversationIdRef.current.trim() === sessionId) {
            setPendingInteraction(nextInteraction);
          }
          if (!nextInteraction) {
            clearSessionAttention(sessionId, 'waiting');
          }
          setError(null);
          return;
        }
        setError(errorMessage(caught));
      }
    },
    [activeConversationId, clearSessionAttention, pendingInteraction],
  );

  const cancelPendingInteraction = useCallback(async () => {
    const interaction = pendingInteraction;
    if (!interaction) {
      return;
    }
    const sessionId = interaction.sessionId?.trim() || activeConversationId.trim();
    try {
      await cancelInteraction(interaction.id);
      const nextInteraction = await fetchPendingInteraction(sessionId).catch(() => null);
      if (activeConversationIdRef.current.trim() === sessionId) {
        setPendingInteraction((current) =>
          current && current.id !== interaction.id
            ? current
            : nextInteraction,
        );
      }
      if (!nextInteraction) {
        clearSessionAttention(sessionId, 'waiting');
      }
      setError(null);
    } catch (caught) {
      if (isInteractionGoneError(caught)) {
        const nextInteraction = await fetchPendingInteraction(sessionId).catch(() => null);
        if (activeConversationIdRef.current.trim() === sessionId) {
          setPendingInteraction(nextInteraction);
        }
        if (!nextInteraction) {
          clearSessionAttention(sessionId, 'waiting');
        }
        setError(null);
        return;
      }
      setError(errorMessage(caught));
    }
  }, [activeConversationId, clearSessionAttention, pendingInteraction]);

  const cancelActiveGoal = useCallback(async () => {
    const sessionId = activeConversationId.trim();
    const goal = sessionId ? goalByConversation[sessionId] : null;
    if (!sessionId || !goal || goal.status !== 'active') {
      return;
    }
    setGoalCancellingByConversation((current) => ({
      ...current,
      [sessionId]: true,
    }));
    try {
      const activeTurnId = activeTurnIdsRef.current[sessionId];
      if (activeTurnId) await stopTurn(activeTurnId);

      let latestGoal = goal;
      try {
        latestGoal = await updateExperimentalGoal({
          goalId: goal.goalId,
          status: 'cancelled',
          statusReason: localize('用户主动取消', 'Cancelled by user'),
          expectedRevision: goal.revision,
        });
      } catch {
        const refreshed = currentExperimentalGoal(
          await fetchExperimentalGoals(sessionId),
        );
        if (!refreshed || refreshed.status !== 'active') {
          latestGoal = refreshed ?? goal;
        } else {
          latestGoal = await updateExperimentalGoal({
            goalId: refreshed.goalId,
            status: 'cancelled',
            statusReason: localize('用户主动取消', 'Cancelled by user'),
            expectedRevision: refreshed.revision,
          });
        }
      }
      setGoalByConversation((current) => ({
        ...current,
        [sessionId]: latestGoal,
      }));
      clearSessionRunning(sessionId);
      setPendingInteraction((current) =>
        current?.sessionId === sessionId ? null : current,
      );
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
      await refreshGoal(sessionId);
    } finally {
      setGoalCancellingByConversation((current) => ({
        ...current,
        [sessionId]: false,
      }));
    }
  }, [
    activeConversationId,
    clearSessionRunning,
    goalByConversation,
    refreshGoal,
  ]);

  const reconcileTerminalTurn = useCallback(async (
    sessionId: string,
    turnId: string,
    attempts: number,
    initialDelayMs = 0,
  ) => {
    if (initialDelayMs > 0) {
      await waitForRecoveryDelay(initialDelayMs);
    }
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (!stoppingRequestsRef.current.has(sessionId)) return false;
      const loaded = await fetchSessionMessages(sessionId, {
        includeSuperseded: true,
      }).catch(() => null);
      const latestTurn = loaded?.latestTurn;
      if (
        loaded &&
        latestTurn?.turnId === turnId
      ) {
        const terminal = terminalSnapshotFromLatestTurn(latestTurn);
        terminalTurnIdsRef.current.add(turnId);
        setMessagesByConversation((current) => {
          const withTerminal = applyTurnTerminalSnapshot(
            current,
            sessionId,
            '',
            terminal,
          );
          return {
            ...withTerminal,
            [sessionId]: mergeLoadedMessagesPreservingLocalState(
              withTerminal[sessionId] ?? [],
              loaded.messages,
            ),
          };
        });
        controllersRef.current[sessionId]?.abort();
        return true;
      }
      if (attempt + 1 < attempts) {
        await waitForRecoveryDelay(500);
      }
    }
    return false;
  }, []);

  const cancelSending = useCallback(async (conversationId?: string) => {
    const sessionId = (conversationId ?? activeConversationId).trim();
    if (!sessionId || stoppingRequestsRef.current.has(sessionId)) {
      return;
    }
    const turnId = activeTurnIdsRef.current[sessionId];
    if (!turnId) return;
    stoppingRequestsRef.current.add(sessionId);
    markSessionStopping(sessionId, true);
    try {
      const result = await stopTurn(turnId);
      if (result.accepted) {
        setError(null);
        void reconcileTerminalTurn(sessionId, turnId, 20, 750);
        return;
      }
      if (result.terminal || result.alreadyInactive) {
        if (await reconcileTerminalTurn(sessionId, turnId, 1)) {
          setError(null);
          return;
        }
      }
      stoppingRequestsRef.current.delete(sessionId);
      markSessionStopping(sessionId, false);
      setError(localize(
        '停止请求未成功，当前任务仍在运行。',
        'The stop request was not accepted; the turn is still running.',
      ));
    } catch (caught) {
      stoppingRequestsRef.current.delete(sessionId);
      markSessionStopping(sessionId, false);
      setError(errorMessage(caught));
    }
  }, [
    activeConversationId,
    localize,
    markSessionStopping,
    reconcileTerminalTurn,
  ]);

  const clearError = useCallback(() => {
    setError(null);
    clearSessionAttention(activeConversationIdRef.current, 'error');
  }, [clearSessionAttention]);
  const clearNotice = useCallback(() => setNotice(null), []);

  return {
    conversations,
    preparedConversations: Object.values(preparedConversationsByScope),
    activeConversation,
    activeConversationId,
    activeMessages,
    messagesByConversation,
    skills,
    loading,
    messagesLoading,
    sending,
    stopping,
    activeTurnId,
    runningByConversation,
    processingConversationIds,
    attentionByConversation,
    clearSessionAttention,
    activeTeamFlow,
    activeTeamFlowLoading,
    activeTeamFlowAction,
    activeContextWindowUsage,
    goalAvailable,
    activeGoal,
    activeGoalCancelling,
    activeGoalWaiting,
    cancelActiveGoal,
    queuedMessages: activeQueuedMessages,
    queuedMessageCount: activeQueuedMessages.length,
    queuedMessagePreview: activeQueuedMessages[0]?.text ?? '',
    pendingInteraction,
    activeConnectionRecovery,
    error,
    notice,
    selectedModel,
    setSelectedModel,
    referencePlanMode,
    setReferencePlanMode,
    permissionMode,
    setPermissionMode,
    subagentPermissionRouting,
    setSubagentPermissionRouting,
    reasoningLevel,
    setReasoningLevel,
    openConversation,
    clearConversationSelection,
    prepareConversation,
    startConversation,
    deleteConversation,
    renameConversation,
    setConversationProject,
    relocateProjectConversations,
    reloadConversations,
    reloadSkills,
    loadSkillDetail,
    refreshActiveSession,
    loadTeamFlow,
    submitTeamFlowAction,
    sendMessage,
    retryFailedUserMessage,
    regenerateAssistantMessage,
    editUserMessageAndRegenerate,
    sendTurnGuidance,
    retryTurnGuidance,
    sendQueuedMessageAsGuidance,
    removeQueuedMessage,
    reorderQueuedMessage,
    replyToInteraction,
    cancelPendingInteraction,
    cancelSending,
    clearError,
    clearNotice,
  };
}

function readInitialSelectedModel(availableModels: ManagedModelConfig[]) {
  const stored = window.localStorage.getItem('cardbush.selected_model')?.trim();
  const selected = stored ? modelConfigFor(availableModels, stored) : undefined;
  if (selected) {
    return selected.id;
  }
  return availableModels[0]?.id ?? '';
}

function readInitialReferencePlanMode(): ReferencePlanMode {
  if (window.localStorage.getItem('cardbush.reference_plan_mode_explicit') !== 'true') {
    return 'auto';
  }
  return normalizeReferencePlanMode(
    window.localStorage.getItem('cardbush.reference_plan_mode') ?? 'auto',
  );
}

function readInitialPermissionMode(): PermissionMode {
  return normalizePermissionMode(
    window.localStorage.getItem('cardbush.permission_mode') ?? 'task_free',
  );
}

function readInitialSubagentPermissionRouting(): SubagentPermissionRouting {
  return normalizeSubagentPermissionRouting(
    window.localStorage.getItem('cardbush.subagent_permission_routing') ?? 'user',
  );
}

function readInitialReasoningLevel(
  available?: ReasoningLevel[],
  fallback?: ReasoningLevel,
): ReasoningLevel {
  const levels = normalizeReasoningLevels(available);
  return normalizeReasoningLevel(
    window.localStorage.getItem('cardbush.reasoning_level') ?? fallback,
    levels,
  );
}

function normalizeReferencePlanMode(value: string): ReferencePlanMode {
  return value.trim() === 'off' ? 'off' : 'auto';
}

function normalizePermissionMode(value: string): PermissionMode {
  const normalized = value.trim();
  if (normalized === 'user_free' || normalized === 'all_free') {
    return normalized;
  }
  return 'task_free';
}

function normalizeSubagentPermissionRouting(value: string): SubagentPermissionRouting {
  return value.trim() === 'user' ? 'user' : 'parent';
}

function normalizeReasoningLevels(values?: ReasoningLevel[]): ReasoningLevel[] {
  const normalized = (values ?? [])
    .filter((item) =>
      item === 'none' ||
      item === 'low' ||
      item === 'medium' ||
      item === 'high' ||
      item === 'xhigh' ||
      item === 'max')
    .filter((item, index, all) => all.indexOf(item) === index);
  return normalized.length > 0
    ? normalized
    : ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
}

function normalizeReasoningLevel(
  value: unknown,
  available: ReasoningLevel[],
): ReasoningLevel {
  const raw = String(value ?? '').trim().toLowerCase();
  const normalized = raw as ReasoningLevel;
  if (available.includes(normalized)) {
    return normalized;
  }
  return available.includes('high') ? 'high' : available[0] ?? 'high';
}

function normalizeDisabledToolNames(values?: Set<string>) {
  if (!values || values.size === 0) {
    return undefined;
  }
  const normalized = [...values]
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item, index, all) => all.indexOf(item) === index);
  return normalized.length > 0 ? normalized : undefined;
}

function queuedMessageConversationId(item: QueuedChatMessage) {
  return item.conversation?.id?.trim() ?? '';
}

export function modelConfigFor(configs: ManagedModelConfig[], selectedModel: string) {
  const normalized = selectedModel.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  const exactId = configs.find(
    (config) => config.id.trim().toLowerCase() === normalized,
  );

  if (exactId) {
    return exactId;
  }
  return configs.find(
    (config) => config.modelName.trim().toLowerCase() === normalized,
  );
}

export function selectedModelName(configs: ManagedModelConfig[], selectedModel: string) {
  return modelConfigFor(configs, selectedModel)?.modelName.trim() || selectedModel.trim();
}

function projectKey(projectDir: string) {
  return projectDir.trim().replace(/\\/g, '/').toLowerCase();
}

function appendProjectPathAlias(
  value: unknown,
  from: string,
  to: string,
): Array<{ from: string; to: string; movedAt: string }> {
  const aliases = Array.isArray(value)
    ? value.flatMap((candidate) => {
        if (candidate == null || typeof candidate !== 'object') return [];
        const record = candidate as Record<string, unknown>;
        const aliasFrom = String(record.from ?? '').trim();
        const aliasTo = String(record.to ?? '').trim();
        if (!aliasFrom || !aliasTo) return [];
        return [{
          from: aliasFrom,
          to: aliasTo,
          movedAt: String(record.movedAt ?? record.moved_at ?? '').trim(),
        }];
      })
    : [];
  const normalizedFrom = projectKey(from);
  const withoutDuplicate = aliases.filter((alias) => projectKey(alias.from) !== normalizedFrom);
  return [
    ...withoutDuplicate,
    { from: from.trim(), to: to.trim(), movedAt: new Date().toISOString() },
  ];
}

function mergedRequestContextPrompt(projectPrompt: string | undefined, teamModeEnabled: boolean) {
  return [projectPrompt?.trim() ?? '', teamModeEnabled ? teamModeContextPrompt() : '']
    .filter(Boolean)
    .join('\n\n');
}

function teamIdFromMessage(message?: ChatMessage) {
  return String(message?.metadata?.team_id ?? message?.metadata?.teamId ?? '').trim();
}

function teamModeContextPrompt() {
  return [
    'Team mode / Agent Flow instructions:',
    '- Treat the user as the Boss who makes final decisions; do not assume human members will join execution.',
    '- Design a progressive Agent Flow before execution: mission boundary, scene profiles, tools, validation, and stop/continue criteria.',
    '- Prefer compact conversational output with one current layer at a time. Do not dump the full DAG unless the Boss asks for it.',
    '- When proposing a layer, include concise cards for each scene Agent: name, responsibility, profile/tool needs, and validation evidence.',
    '- Ask the Boss to choose: revise this layer, continue to the next layer, or enter execution.',
    '- If the Boss asks to execute, run the task using available tools and keep the Agent Flow decisions auditable.',
  ].join('\n');
}

function conversationProjectRequestDir(conversation: ConversationSummary) {
  return conversationProjectDir(conversation);
}

function withTerminalTurnId(
  terminal: TurnTerminalSnapshot,
  fallbackTurnId?: string,
): TurnTerminalSnapshot {
  const turnId = terminal.turnId.trim() || fallbackTurnId?.trim() || '';
  return turnId === terminal.turnId ? terminal : { ...terminal, turnId };
}

function terminalSnapshotFromLatestTurn(
  turn: SessionLatestTurn,
): TurnTerminalSnapshot {
  return {
    turnId: turn.turnId,
    status: turn.status || (turn.stopped ? 'stopped' : 'completed'),
    stopped: turn.stopped,
    stopReason: turn.stopReason,
    stopScenario: turn.stopScenario,
    stopDetails: turn.stopDetails,
    completedAt: turn.completedAt,
    durationMs: turn.durationMs,
    terminalEventSequence: turn.terminalEventSequence,
    raw: {},
  };
}

function isTurnGuidanceBoundary(update: StreamExecutionUpdate) {
  return update.reason === 'turn_guidance_pending' ||
    update.reason === 'turn_guidance_applied';
}

function upsertConversationPreview(
  current: ConversationSummary[],
  conversation: ConversationSummary,
  preview: string,
  titleSource = preview,
) {
  const existing = current.find((item) => item.id === conversation.id);
  const currentTitle = existing?.title ?? conversation.title;
  const nextTitle = shouldAutoTitleConversation(currentTitle, conversation.id)
    ? conversationTitleFromUserText(titleSource) || currentTitle || '新会话'
    : currentTitle;
  const updated = {
    ...conversation,
    ...existing,
    title: nextTitle,
    preview,
    updatedAt: new Date().toISOString(),
  };
  const without = current.filter((item) => item.id !== conversation.id);
  return [updated, ...without];
}

function mergeLoadedConversationsPreservingLocalTitles(
  current: ConversationSummary[],
  loaded: ConversationSummary[],
) {
  const localById = new Map(current.map((item) => [item.id, item]));
  return loaded.map((conversation) => {
    const local = localById.get(conversation.id);
    if (
      local &&
      !shouldAutoTitleConversation(local.title, local.id) &&
      shouldAutoTitleConversation(conversation.title, conversation.id)
    ) {
      return { ...conversation, title: local.title };
    }
    return conversation;
  });
}

function conversationPreviewFromMessages(messages: ChatMessage[]) {
  const lastUser = [...messages].reverse().find((item) => item.role === 'user');
  return lastUser?.content.trim() || messages.at(-1)?.content.trim() || '';
}

function shouldAutoTitleConversation(title: string | undefined, sessionId?: string) {
  const normalized = String(title ?? '').trim();
  if (!normalized || normalized === '新会话' || normalized === 'New chat') {
    return true;
  }
  const normalizedId = String(sessionId ?? '').trim();
  if (normalizedId && normalized === normalizedId) {
    return true;
  }
  const lower = normalized.toLowerCase();
  return (
    lower.startsWith('local-') ||
    /^cardbush-\d/.test(lower)
  );
}

function mergeSyncedConversationTitle(
  localTitle: string,
  syncedTitle: string,
  sessionId?: string,
) {
  if (!shouldAutoTitleConversation(localTitle, sessionId)) {
    return localTitle;
  }
  return syncedTitle;
}

function firstUserTitleSource(messages: ChatMessage[], fallback: string) {
  return (
    messages.find((message) => message.role === 'user')?.content.trim() ||
    fallback.trim()
  );
}

function conversationTitleFromUserText(value: string) {
  const readable = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !attachmentPathFromLine(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const fallback = value.replace(/\s+/g, ' ').trim();
  return truncateText(readable || fallback, 28);
}

function splitStreamAttachmentMentions(content: string) {
  const images: Array<{ path: string }> = [];
  const files: string[] = [];
  const textLines: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const mention = attachmentPathFromLine(line);
    if (!mention) {
      textLines.push(line);
      continue;
    }
    if (isImagePath(mention)) {
      images.push({ path: mention });
    } else {
      files.push(mention);
    }
  }
  const userInput = textLines.join('\n').trim();
  return {
    displayInput: userInput,
    userInput:
      userInput ||
      (images.length > 0 || files.length > 0
        ? 'Please review the attached file(s).'
        : content.trim()),
    images,
    files,
  };
}

async function chatAttachmentsFromOutbound(
  outbound: ReturnType<typeof splitStreamAttachmentMentions>,
): Promise<ChatAttachment[]> {
  const inspected = await window.cardbushDesktop
    ?.inspectAttachments?.(outbound.files)
    .catch(() => []);
  const kindByPath = new Map(
    (inspected ?? []).map((item) => [
      item.path.replace(/\\/g, '/').toLowerCase(),
      item.kind,
    ]),
  );
  return [
    ...outbound.images.map((image) => ({
      id: `attachment-${crypto.randomUUID()}`,
      name: basename(image.path),
      path: image.path,
      type: 'image' as const,
    })),
    ...outbound.files.map((pathValue) => {
      const kind = kindByPath.get(pathValue.replace(/\\/g, '/').toLowerCase());
      return {
        id: `attachment-${crypto.randomUUID()}`,
        name: basename(pathValue),
        path: pathValue,
        type: kind === 'folder'
          ? 'folder' as const
          : isVideoPath(pathValue)
            ? 'video' as const
            : isAudioPath(pathValue)
              ? 'audio' as const
              : 'document' as const,
      };
    }),
  ];
}

function streamAttachmentsForVision(
  attachments: ReturnType<typeof splitStreamAttachmentMentions>,
  standardImageInputEnabled: boolean,
) {
  if (standardImageInputEnabled) {
    return attachments;
  }
  return {
    ...attachments,
    images: [],
    files: [
      ...attachments.files,
      ...attachments.images.map((image) => image.path).filter(Boolean),
    ],
  };
}

function streamAttachmentsFromChatAttachments(
  attachments: ChatAttachment[] | undefined,
  standardImageInputEnabled: boolean,
) {
  const paths = (attachments ?? []).flatMap((attachment) =>
    attachment.path?.trim() ? [attachment.path.trim()] : [],
  );
  const images = paths
    .filter(isImagePath)
    .map((path) => ({ path }));
  const files = paths.filter((path) => !isImagePath(path));
  return streamAttachmentsForVision(
    { displayInput: '', userInput: '', images, files },
    standardImageInputEnabled,
  );
}

function attachmentPathFromLine(value: string) {
  const trimmed = value.trim();
  if (/^\/(?:model|goal|skill|new)(?:\s|$)/i.test(trimmed)) {
    return '';
  }
  const pathValue = stripWrappingQuotes(
    trimmed.startsWith('@') ? trimmed.slice(1).trim() : trimmed,
  );
  if (isAbsoluteLocalPath(pathValue)) {
    return pathValue;
  }
  return '';
}

function localConversation(
  projectDir?: string,
  initialTitle?: string,
  projectId?: string,
): ConversationSummary {
  const id = `local-${crypto.randomUUID()}`;
  return {
    id,
    title: initialTitle?.trim() || '新会话',
    preview: '',
    updatedAt: new Date().toISOString(),
    projectId: projectId?.trim() || undefined,
    projectDir,
    metadata: {
      ui_draft: true,
      ...(projectId?.trim() ? { project_id: projectId.trim() } : {}),
    },
  };
}

function mergeTeamFlowEvent(
  current: TeamFlowState | null | undefined,
  event: TeamFlowStreamEvent,
  sessionId: string,
): TeamFlowState {
  const flowId = event.flowId || current?.flowId || current?.id || sessionId;
  const currentLayerId =
    event.currentLayerId || event.layer?.id || event.node?.layerId || current?.currentLayerId;
  const currentLayerIndex =
    event.currentLayerIndex ??
    event.layer?.index ??
    event.node?.layerIndex ??
    current?.currentLayerIndex;
  const layers = mergeTeamFlowLayers(current?.layers ?? [], event.layer);
  const nodes = mergeTeamFlowNodes(current?.nodes ?? [], event.node);
  return {
    id: current?.id || flowId,
    flowId,
    sessionId: event.sessionId || current?.sessionId || sessionId,
    status: event.status || current?.status || '',
    currentLayerId,
    currentLayerIndex,
    layers: attachNodesToTeamFlowLayers(layers, nodes),
    nodes,
    suggestedActions:
      event.suggestedActions.length > 0
        ? event.suggestedActions
        : current?.suggestedActions ?? [],
    actionOptions:
      event.actionOptions.length > 0
        ? event.actionOptions
        : event.suggestedActions.length > 0
          ? event.suggestedActions.map(teamFlowActionOptionFromAction)
          : current?.actionOptions ?? [],
    raw: {
      ...(current?.raw ?? {}),
      last_event: event.raw,
      lastEvent: event.raw,
    },
  };
}

function teamFlowActionOptionFromAction(
  action: TeamFlowActionType,
): TeamFlowActionOption {
  return {
    id: action,
    action,
    raw: { action },
  };
}

function mergeTeamFlowLayers(
  layers: TeamFlowLayer[],
  nextLayer?: TeamFlowLayer,
) {
  if (!nextLayer) {
    return layers;
  }
  const existingIndex = layers.findIndex((layer) => layer.id === nextLayer.id);
  if (existingIndex < 0) {
    return [...layers, nextLayer];
  }
  return layers.map((layer, index) =>
    index === existingIndex
      ? {
          ...layer,
          ...nextLayer,
          nodes: mergeLayerNodeList(layer.nodes, nextLayer.nodes),
        }
      : layer,
  );
}

function mergeTeamFlowNodes(nodes: TeamFlowNode[], nextNode?: TeamFlowNode) {
  if (!nextNode) {
    return nodes;
  }
  const existingIndex = nodes.findIndex((node) => node.id === nextNode.id);
  if (existingIndex < 0) {
    return [...nodes, nextNode];
  }
  return nodes.map((node, index) =>
    index === existingIndex ? { ...node, ...nextNode } : node,
  );
}

function attachNodesToTeamFlowLayers(
  layers: TeamFlowLayer[],
  nodes: TeamFlowNode[],
) {
  if (layers.length === 0) {
    return layers;
  }
  return layers.map((layer) => {
    const attached = nodes.filter(
      (node) =>
        node.layerId === layer.id ||
        (node.layerIndex != null && node.layerIndex === layer.index),
    );
    return attached.length > 0
      ? { ...layer, nodes: mergeLayerNodeList(layer.nodes, attached) }
      : layer;
  });
}

function mergeLayerNodeList(nodes: TeamFlowNode[], attached: TeamFlowNode[]) {
  const byId = new Map<string, TeamFlowNode>();
  for (const node of [...nodes, ...attached]) {
    byId.set(node.id, { ...(byId.get(node.id) ?? node), ...node });
  }
  return Array.from(byId.values());
}

function currentExperimentalGoal(goals: ExperimentalGoal[]) {
  return goals.find((goal) => goal.status === 'active') ?? goals[0];
}

function goalPollingDelayMs() {
  return document.visibilityState === 'hidden' ? 7_000 : 2_000;
}

function isNotFoundLikeError(error: unknown) {
  const code = runtimeErrorCode(error);
  return code === 'not_found' || code === 'team_flow_not_found';
}

function isInteractionGoneError(error: unknown) {
  const code = runtimeErrorCode(error);
  return code === 'permission_not_pending' || code === 'interaction_not_pending';
}

function waitForRecoveryDelay(delayMs: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, Math.max(0, delayMs));
  });
}

function rawErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isNetworkTransportError(error: unknown) {
  return error instanceof RuntimeRemoteError && error.fact.kind === 'transport';
}

function errorMessage(error: unknown) {
  const message = rawErrorMessage(error);
  const english =
    typeof document !== 'undefined' &&
    document.documentElement.lang.toLowerCase().startsWith('en');
  if (error instanceof RuntimeRemoteError && error.fact.kind === 'transport') {
    return english
      ? 'Unable to reach the model provider or an external integration.'
      : '无法连接模型服务或外部集成。';
  }
  return message;
}

function runtimeErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const value = error as { code?: unknown; fact?: { code?: unknown } };
  return String(value.fact?.code ?? value.code ?? '').trim();
}
