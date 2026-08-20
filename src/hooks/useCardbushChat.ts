import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  cancelInteraction,
  createConversation,
  createSessionShareLink as createSessionShareLinkApi,
  deleteConversationApi,
  editMessage,
  fetchConversations,
  fetchExperimentalGoalA2AStatus,
  fetchExperimentalGoals,
  fetchMessages,
  fetchPendingInteraction,
  fetchSessionContextWindowUsage,
  fetchSessionWorkspaceChanges,
  fetchSkillDetail,
  fetchSkills,
  fetchSessionMessages,
  fetchTeamFlow,
  isBushServerHttpError,
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
  ReasoningLevel,
  ReferencePlanMode,
  RuntimeContextWindowUsage,
  RuntimeConnectionUpdate,
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
} from '../types';
import { emitSubagentDispatch } from '../features/subagents/subagentObservabilityEvents';
import {
  basename,
  isAbsoluteLocalPath,
  isImagePath,
  stripWrappingQuotes,
} from '../shared/localPaths';
import { truncateText } from '../shared/text';
import {
  applyGoalToolUpdate,
  goalToolUpdateFromExecution,
  isGoalSelfCheckMessage,
} from '../shared/goalState';

export type QueuedChatMessage = {
  id: string;
  text: string;
  conversation?: ConversationSummary;
  createdAt: string;
};

export function useCardbushChat(
  managedModelConfigs: ManagedModelConfig[] = [],
  availableModels: ManagedModelConfig[] = [],
  requestContext: {
    language?: AppLanguage;
    projectContexts?: Record<string, string>;
    disabledSkillNames?: Set<string>;
    disabledToolNames?: Set<string>;
    standardImageInputEnabled?: boolean;
    browserPrivacyMode?: boolean;
    teamModeEnabled?: boolean;
    osModeEnabled?: boolean;
    terminalRuntime?: TerminalRuntime;
    reasoningTraceVisible?: boolean;
    interactiveRequestsAvailable?: boolean;
    reasoningLevelSelection?: boolean;
    reasoningLevels?: ReasoningLevel[];
    defaultReasoningLevel?: ReasoningLevel;
    contextWindowUsageAvailable?: boolean;
    workspaceChangesAvailable?: boolean;
  } = {},
) {
  const languageRef = useRef<AppLanguage>(requestContext.language ?? 'zh');
  languageRef.current = requestContext.language ?? 'zh';
  const localize = useCallback(
    (zh: string, en: string) => (languageRef.current === 'zh' ? zh : en),
    [],
  );
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConversationId, setActiveConversationId] = useState('');
  const [messagesByConversation, setMessagesByConversation] = useState<
    Record<string, ChatMessage[]>
  >({});
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [runningByConversation, setRunningByConversation] = useState<
    Record<string, { activeTurnId: string }>
  >({});
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
  const sendingSessionsRef = useRef<Set<string>>(new Set());
  const queuedMessagesRef = useRef<QueuedChatMessage[]>([]);
  const guidanceFallbackIdsRef = useRef<Set<string>>(new Set());
  const guidanceRequestIdsRef = useRef<Set<string>>(new Set());
  const sendMessageRef = useRef<
    (text: string, conversation?: ConversationSummary) => Promise<void>
  >(async () => undefined);
  const [queuedMessages, setQueuedMessages] = useState<QueuedChatMessage[]>([]);
  const activeConversationIdForState = activeConversationId.trim();
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
  const activeConnectionRecovery = activeConversationIdForState
    ? connectionRecoveryByConversation[activeConversationIdForState]
    : undefined;

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
            : loadedConversations[0]?.id ?? '',
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
  }, []);

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

  useEffect(() => {
    if (!activeConversationId || messagesByConversation[activeConversationId]) {
      return;
    }
    let cancelled = false;
    async function loadMessages() {
      setMessagesLoading(true);
      try {
        const [result, workspaceChanges] = await Promise.all([
          fetchSessionMessages(activeConversationId, { includeSuperseded: true }),
          requestContext.workspaceChangesAvailable === true
            ? fetchSessionWorkspaceChanges(activeConversationId).catch(() => [])
            : Promise.resolve([]),
        ]);
        if (!cancelled) {
          const loadedMessages = mergeWorkspaceChangeExecutions(
            result.messages,
            workspaceChanges,
          );
          setMessagesByConversation((current) => ({
            ...current,
            [activeConversationId]: mergeLoadedMessagesPreservingLocalState(
              current[activeConversationId] ?? [],
              loadedMessages,
            ),
          }));
          persistAutoConversationTitle(
            result.conversation,
            firstUserTitleSource(loadedMessages, ''),
          );
          if (result.conversation.projectDir || result.conversation.workspaceContext) {
            setConversations((current) =>
              current.map((item) =>
                item.id === activeConversationId
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
        if (!cancelled) {
          setError(errorMessage(caught));
          setMessagesByConversation((current) => ({
            ...current,
            [activeConversationId]: [],
          }));
        }
      } finally {
        if (!cancelled) {
          setMessagesLoading(false);
        }
      }
    }
    void loadMessages();
    return () => {
      cancelled = true;
    };
  }, [
    activeConversationId,
    messagesByConversation,
    persistAutoConversationTitle,
    requestContext.workspaceChangesAvailable,
  ]);

  const activeConversation = useMemo(
    () =>
      conversations.find((item) => item.id === activeConversationId) ??
      conversations[0],
    [activeConversationId, conversations],
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
  const activeGoalLatestTurn = activeConversationId
    ? goalLatestTurnByConversation[activeConversationId]
    : undefined;
  const activeGoalWaiting =
    activeGoal?.status === 'active' &&
    !sending &&
    (!activeGoalLatestTurn || !isRunningSessionTurn(activeGoalLatestTurn));

  useEffect(() => {
    let cancelled = false;
    void fetchExperimentalGoalA2AStatus()
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
    sendingSessionsRef.current.add(normalized);
    if (turnId.trim()) {
      activeTurnIdsRef.current[normalized] = turnId.trim();
    }
    setRunningByConversation((current) => ({
      ...current,
      [normalized]: {
        activeTurnId: turnId.trim() || current[normalized]?.activeTurnId || '',
      },
    }));
  }, []);

  const clearSessionRunning = useCallback((sessionId: string) => {
    const normalized = sessionId.trim();
    if (!normalized) {
      return;
    }
    sendingSessionsRef.current.delete(normalized);
    delete activeTurnIdsRef.current[normalized];
    setRunningByConversation((current) => {
      if (!(normalized in current)) {
        return current;
      }
      const next = { ...current };
      delete next[normalized];
      return next;
    });
  }, []);

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
        : loadedConversations[0]?.id ?? '',
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
    const streamBuffer = createSegmentedAssistantStreamBuffers((delta, route) => {
      ensureAssistant(route.createdAt);
      setMessagesByConversation((state) =>
        appendAssistantDelta(
          state,
          normalizedSessionId,
          assistantId,
          delta,
          route,
        ),
      );
    });

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
      onExecution: (update) => {
        if (update.reason === 'turn_guidance_pending') {
          streamBuffer.flushToolBoundary();
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
        streamBuffer.flushToolBoundary();
        ensureAssistant();
        streamBuffer.reset(
          {
            messageId: revision.messageId ?? '',
            assistantSegmentIndex: revision.assistantSegmentIndex,
            turnId: revision.turnId ?? normalizedTurnId,
          },
          revision.content ?? '',
        );
        setMessagesByConversation((state) =>
          applyAssistantRevision(
            state,
            normalizedSessionId,
            assistantId,
            revision,
          ),
        );
      },
      onToolExecution: (execution) => {
        streamBuffer.flushToolBoundary();
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
        setPendingInteraction({
          ...interaction,
          sessionId: interaction.sessionId ?? normalizedSessionId,
        });
      },
      onFinalAssistantText: (text, chunk) => {
        ensureAssistant(chunk.createdAt);
        void streamBuffer.flushRoute(chunk).then(() => {
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
      onMessages: (nextMessages, finalSnapshot) => {
        void streamBuffer.flushAllStreaming().then(() => {
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
        const loaded = await fetchSessionMessages(normalizedSessionId, {
          includeSuperseded: true,
        }).catch(() => null);
        if (loaded) {
          setMessagesByConversation((state) => ({
            ...state,
            [normalizedSessionId]: mergeLoadedMessagesPreservingLocalState(
              state[normalizedSessionId] ?? [],
              loaded.messages,
            ),
          }));
          setGoalLatestTurnByConversation((state) => ({
            ...state,
            [normalizedSessionId]: loaded.latestTurn,
          }));
        }
        await refreshGoal(normalizedSessionId);
        if (
          goalTurnControllersRef.current[normalizedSessionId]?.controller === controller
        ) {
          delete goalTurnControllersRef.current[normalizedSessionId];
          if (
            loaded?.latestTurn &&
            loaded.latestTurn.turnId === normalizedTurnId &&
            isRunningSessionTurn(loaded.latestTurn)
          ) {
            markSessionRunning(normalizedSessionId, normalizedTurnId);
          } else if (!controllersRef.current[normalizedSessionId]) {
            clearSessionRunning(normalizedSessionId);
          }
        }
      });
  }, [
    applyConnectionRecoveryUpdate,
    applyGoalExecution,
    clearSessionRunning,
    markSessionRunning,
    mergeContextWindowUsage,
    mergeTeamFlowStreamEvent,
    refreshGoal,
  ]);

  const refreshActiveSession = useCallback(async (options?: { silent?: boolean }) => {
    const sessionId = activeConversationId.trim();
    if (!sessionId) {
      await reloadConversations();
      return;
    }
    if (!options?.silent) {
      setMessagesLoading(true);
    }
    try {
      const [result, workspaceChanges] = await Promise.all([
        fetchSessionMessages(sessionId, { includeSuperseded: true }),
        requestContext.workspaceChangesAvailable === true
          ? fetchSessionWorkspaceChanges(sessionId).catch(() => [])
          : Promise.resolve([]),
      ]);
      const loadedMessages = mergeWorkspaceChangeExecutions(
        result.messages,
        workspaceChanges,
      );
      setMessagesByConversation((current) => ({
        ...current,
        [sessionId]: mergeLoadedMessagesPreservingLocalState(
          current[sessionId] ?? [],
          loadedMessages,
        ),
      }));
      persistAutoConversationTitle(
        result.conversation,
        firstUserTitleSource(loadedMessages, ''),
      );
      if (requestContext.contextWindowUsageAvailable === true) {
        await fetchSessionContextWindowUsage(sessionId)
          .then((usage) => mergeContextWindowUsage(sessionId, usage))
          .catch(() => undefined);
      }
      await loadTeamFlow(sessionId, { silent: true }).catch(() => null);
      await refreshGoal(sessionId);
      await reloadConversations().catch(() => undefined);
      if (!options?.silent) {
        setError(null);
      }
    } catch (caught) {
      await reloadConversations().catch(() => undefined);
      if (!options?.silent) {
        setError(errorMessage(caught));
      }
      throw caught;
    } finally {
      if (!options?.silent) {
        setMessagesLoading(false);
      }
    }
  }, [
    activeConversationId,
    loadTeamFlow,
    mergeContextWindowUsage,
    refreshGoal,
    reloadConversations,
    persistAutoConversationTitle,
    requestContext.contextWindowUsageAvailable,
    requestContext.workspaceChangesAvailable,
  ]);

  useEffect(() => {
    const sessionId = activeConversationId.trim();
    if (!sessionId || requestContext.contextWindowUsageAvailable !== true) {
      return;
    }
    const controller = new AbortController();
    void fetchSessionContextWindowUsage(sessionId, controller.signal)
      .then((usage) => mergeContextWindowUsage(sessionId, usage))
      .catch(() => undefined);
    return () => controller.abort();
  }, [
    activeConversationId,
    mergeContextWindowUsage,
    requestContext.contextWindowUsageAvailable,
  ]);

  const createSessionShareLink = useCallback(
    (request: { sessionId: string; platform?: string; expiresSeconds?: number }) =>
      createSessionShareLinkApi(request),
    [],
  );

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
      try {
        const [sessionRequest, goalsRequest, interactionRequest] =
          await Promise.allSettled([
            fetchSessionMessages(sessionId, { includeSuperseded: true }),
            fetchExperimentalGoals(sessionId),
            fetchPendingInteraction(sessionId),
          ]);
        if (cancelled) return;

        if (sessionRequest.status === 'fulfilled') {
          const sessionResult = sessionRequest.value;
          setMessagesByConversation((current) => ({
            ...current,
            [sessionId]: mergePolledMessagesPreservingLocalState(
              current[sessionId] ?? [],
              sessionResult.messages,
            ),
          }));
          setGoalLatestTurnByConversation((current) => ({
            ...current,
            [sessionId]: sessionResult.latestTurn,
          }));
          if (
            sessionResult.latestTurn &&
            isRunningSessionTurn(sessionResult.latestTurn)
          ) {
            markSessionRunning(sessionId, sessionResult.latestTurn.turnId);
            subscribeGoalTurn(sessionId, sessionResult.latestTurn.turnId);
          } else if (!controllersRef.current[sessionId]) {
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
      if (!normalized || !conversations.some((item) => item.id === normalized)) {
        return;
      }
      setActiveConversationId(normalized);
    },
    [conversations],
  );

  const startConversation = useCallback(async (projectDir?: string, initialTitle?: string) => {
    const optimistic = localConversation(projectDir, initialTitle);
    setConversations((current) => [
      optimistic,
      ...current.filter((item) => item.id !== optimistic.id),
    ]);
    setMessagesByConversation((current) => ({
      ...current,
      [optimistic.id]: current[optimistic.id] ?? [],
    }));
    setActiveConversationId(optimistic.id);
    setError(null);

    void createConversation({
      sessionId: optimistic.id,
      title: optimistic.title,
      projectDir,
    })
      .then((created) => {
        const synced = {
          ...created,
          id: optimistic.id,
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
  }, []);

  const deleteConversation = useCallback((conversationId: string) => {
    setConversations((current) => {
      const next = current.filter((item) => item.id !== conversationId);
      setActiveConversationId((active) =>
        active === conversationId ? next[0]?.id ?? '' : active,
      );
      return next;
    });
    setMessagesByConversation((current) => {
      const next = { ...current };
      delete next[conversationId];
      return next;
    });
    void deleteConversationApi(conversationId).catch((caught) =>
      setError(errorMessage(caught)),
    );
  }, []);

  const renameConversation = useCallback((conversationId: string, title: string) => {
    const nextTitle = title.trim();
    if (!nextTitle) {
      return;
    }
    setConversations((current) =>
      current.map((item) =>
        item.id === conversationId ? { ...item, title: nextTitle } : item,
      ),
    );
    void updateConversation({ sessionId: conversationId, title: nextTitle }).catch((caught) =>
      setError(errorMessage(caught)),
    );
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
    let syncPolls = 0;
    const deadline = Date.now() + 10 * 60 * 1000;
    while (!signal.aborted && Date.now() < deadline) {
      const nextRetryMs = failedAttempts > 0
        ? Math.min(800 * (2 ** (failedAttempts - 1)), 5000)
        : syncPolls > 0
          ? 2000
          : 0;
      setConnectionRecoveryByConversation((current) => ({
        ...current,
        [sessionId]: {
          state: failedAttempts > 0 ? 'retrying' : syncPolls > 0 ? 'syncing' : 'retrying',
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
        const sessionResult = await fetchSessionMessages(sessionId, {
          includeSuperseded: true,
        });
        setMessagesByConversation((current) => ({
          ...current,
          [sessionId]: mergeLoadedMessagesPreservingLocalState(
            current[sessionId] ?? [],
            sessionResult.messages,
          ),
        }));
        setGoalLatestTurnByConversation((current) => ({
          ...current,
          [sessionId]: sessionResult.latestTurn,
        }));
        failedAttempts = 0;
        if (
          sessionResult.latestTurn &&
          isRunningSessionTurn(sessionResult.latestTurn)
        ) {
          markSessionRunning(sessionId, sessionResult.latestTurn.turnId);
          syncPolls += 1;
          setConnectionRecoveryByConversation((current) => ({
            ...current,
            [sessionId]: {
              state: 'syncing',
              source: 'network',
              sessionId,
              turnId: sessionResult.latestTurn?.turnId ?? turnId,
              reason,
              createdAt: new Date().toISOString(),
            },
          }));
          continue;
        }
        setConnectionRecoveryByConversation((current) => ({
          ...current,
          [sessionId]: undefined,
        }));
        void reloadConversations().catch(() => undefined);
        return true;
      } catch {
        failedAttempts += 1;
        syncPolls = 0;
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
  }, [markSessionRunning, reloadConversations]);

  const sendMessage = useCallback(
    async (text: string, queuedConversation?: ConversationSummary) => {
      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }
      const outbound = splitStreamAttachmentMentions(trimmed);
      const optimisticAttachments = chatAttachmentsFromOutbound(outbound);
      const attachments = streamAttachmentsForVision(
        outbound,
        requestContext.standardImageInputEnabled === true,
      );
      const visibleUserInput =
        outbound.displayInput ||
        optimisticAttachments.map((attachment) => attachment.name).join(', ') ||
        outbound.userInput;
      const conversation =
        queuedConversation ??
        activeConversation ??
        (await startConversation(undefined, conversationTitleFromUserText(visibleUserInput)));
      const sessionId = conversation.id;
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
          conversation,
          createdAt: new Date().toISOString(),
        });
        return;
      }
      const projectDir = conversationProjectRequestDir(conversation);
      const projectUserPrompt = mergedRequestContextPrompt(
        projectDir ? requestContext.projectContexts?.[projectKey(projectDir)]?.trim() : '',
        requestContext.teamModeEnabled === true,
      );
      if (!selectedModel.trim()) {
        setError(localize('请先在设置中配置模型', 'Configure a model in Settings first'));
        return;
      }
      const userMessageId = `user-${crypto.randomUUID()}`;
      const userMessage: ChatMessage = {
        id: userMessageId,
        clientMessageId: userMessageId,
        role: 'user',
        content: outbound.displayInput,
        conversationId: sessionId,
        createdAt: new Date().toISOString(),
        attachments:
          optimisticAttachments.length > 0 ? optimisticAttachments : undefined,
        status: 'pending',
        metadata: {
          message_delivery: 'pending',
        },
      };
      const assistantId = `assistant-${crypto.randomUUID()}`;
      const assistantMessage: ChatMessage = {
        id: assistantId,
        role: 'assistant',
        content: '',
        conversationId: sessionId,
        createdAt: new Date().toISOString(),
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
      markSessionRunning(sessionId);
      setError(null);
      const controller = new AbortController();
      const streamBuffer = createSegmentedAssistantStreamBuffers((delta, route) => {
        setMessagesByConversation((current) =>
          appendAssistantDelta(current, sessionId, assistantId, delta, route),
        );
      });
      controllersRef.current[sessionId] = controller;
      let finalSnapshotPromise: Promise<void> | null = null;
      let streamStarted = false;

      try {
        await streamChat({
          sessionId,
          userInput: outbound.userInput,
          model: selectedModelName(managedModelConfigs, selectedModel),
          modelConfig: modelConfigFor(managedModelConfigs, selectedModel),
          projectDir,
          projectUserPrompt,
          allowedSkills: skills
            .map((skill) => skill.name)
            .filter((name) => !requestContext.disabledSkillNames?.has(name)),
          referencePlanMode,
          permissionMode,
          reasoningLevel,
          reasoningTraceVisible: requestContext.reasoningTraceVisible === true,
          interactiveRequestsEnabled:
            requestContext.interactiveRequestsAvailable === true,
          standardImageInputEnabled: requestContext.standardImageInputEnabled === true,
          browserPrivacyMode: requestContext.browserPrivacyMode === true,
          teamModeEnabled: requestContext.teamModeEnabled === true,
          osModeEnabled: requestContext.osModeEnabled === true,
          terminalRuntime: requestContext.terminalRuntime,
          disabledTools: normalizeDisabledToolNames(requestContext.disabledToolNames),
          images: attachments.images,
          files: attachments.files,
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
          onExecution: (update) => {
            if (update.reason === 'turn_guidance_pending') {
              streamBuffer.flushToolBoundary();
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
            streamBuffer.flushToolBoundary();
            streamBuffer.reset({
              messageId: revision.messageId ?? '',
              assistantSegmentIndex: revision.assistantSegmentIndex,
              turnId: revision.turnId ?? activeTurnIdsRef.current[sessionId] ?? '',
            }, revision.content ?? '');
            setMessagesByConversation((current) =>
              applyAssistantRevision(current, sessionId, assistantId, revision),
            );
          },
          onToolExecution: (execution) => {
            streamBuffer.flushToolBoundary();
            applyGoalExecution(sessionId, execution);
            setMessagesByConversation((current) =>
              appendToolExecution(current, sessionId, assistantId, execution),
            );
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
            setPendingInteraction({
              ...interaction,
              sessionId: interaction.sessionId ?? sessionId,
            });
          },
          onFinalAssistantText: (text, chunk) => {
            finalSnapshotPromise = streamBuffer.flushRoute(chunk).then(() => {
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
          onMessages: (nextMessages, finalSnapshot) => {
            if (finalSnapshot) {
              const turnId = activeTurnIdsRef.current[sessionId];
              finalSnapshotPromise = streamBuffer.flushAllStreaming().then(() => {
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
        const loadedMessages = await fetchMessages(sessionId, {
          includeSuperseded: true,
        }).catch(() => null);
        if (loadedMessages && loadedMessages.length > 0) {
          setMessagesByConversation((current) => ({
            ...current,
            [sessionId]: mergeLoadedMessagesPreservingLocalState(
              current[sessionId] ?? [],
              loadedMessages,
            ),
          }));
        }
        await refreshGoal(sessionId);
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
            return;
          }
          const loadedMessages = await fetchMessages(sessionId, {
            includeSuperseded: true,
          }).catch(() => null);
          if (loadedMessages && loadedMessages.length > 0) {
            setMessagesByConversation((current) => ({
              ...current,
              [sessionId]: mergeLoadedMessagesPreservingLocalState(
                current[sessionId] ?? [],
                loadedMessages,
              ),
            }));
            void reloadConversations().catch(() => undefined);
          }
          if (loadedMessages && hasCompletedAssistantForTurn(loadedMessages, turnId)) {
            setError(null);
          } else {
            setError(errorMessage(caught));
          }
        }
      } finally {
        await streamBuffer.flushAllStreaming();
        streamBuffer.dispose();
        if (controllersRef.current[sessionId] === controller) {
          delete controllersRef.current[sessionId];
          clearSessionRunning(sessionId);
        }
        const nextQueued = dequeueMessageForConversation(sessionId);
        if (nextQueued) {
          window.setTimeout(() => {
            void sendMessageRef.current(nextQueued.text, nextQueued.conversation);
          }, 0);
        }
      }
    },
    [
      activeConversation,
      applyGoalExecution,
      applyConnectionRecoveryUpdate,
      clearSessionRunning,
      dequeueMessageForConversation,
      enqueueMessage,
      isSessionSending,
      loadTeamFlow,
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
      requestContext.interactiveRequestsAvailable,
      requestContext.osModeEnabled,
      requestContext.reasoningTraceVisible,
      requestContext.teamModeEnabled,
      requestContext.standardImageInputEnabled,
      requestContext.projectContexts,
      referencePlanMode,
      permissionMode,
      reasoningLevel,
      selectedModel,
      skills,
      startConversation,
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
      const attachmentMentions = (message.attachments ?? [])
        .map((attachment) => attachment.path?.trim() ?? '')
        .filter(Boolean)
        .map((pathValue) => `@${pathValue}`);
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
          onExecution: (update: StreamExecutionUpdate) => void;
          onAssistantRevision: (revision: AssistantRevision) => void;
          onToolExecution: (execution: ChatToolExecution) => void;
          onContextWindowUsage: (usage: RuntimeContextWindowUsage) => void;
          onTaskPlanUpdate: (update: TaskPlanStreamUpdate) => void;
          onInteractiveRequest: (interaction: PendingInteraction) => void;
          onFinalAssistantText: (text: string, chunk: AssistantStreamChunk) => void;
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
      const streamBuffer = createSegmentedAssistantStreamBuffers((delta, route) => {
        setMessagesByConversation((current) =>
          appendAssistantDelta(current, sessionId, tempAssistant.id, delta, route),
        );
      });
      const startIds = new Set(startedMessageIds ?? [tempAssistant.id]);
      const replacementIds = temporaryMessageIds ?? [tempAssistant.id];
      let finalSnapshotPromise: Promise<void> | null = null;
      let streamStarted = false;
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
          onExecution: (update) => {
            if (update.reason === 'turn_guidance_pending') {
              streamBuffer.flushToolBoundary();
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
            streamBuffer.flushToolBoundary();
            streamBuffer.reset({
              messageId: revision.messageId ?? '',
              assistantSegmentIndex: revision.assistantSegmentIndex,
              turnId: revision.turnId ?? activeTurnIdsRef.current[sessionId] ?? '',
            }, revision.content ?? '');
            setMessagesByConversation((current) =>
              applyAssistantRevision(current, sessionId, tempAssistant.id, revision),
            );
          },
          onToolExecution: (execution) => {
            streamBuffer.flushToolBoundary();
            applyGoalExecution(sessionId, execution);
            setMessagesByConversation((current) =>
              appendToolExecution(current, sessionId, tempAssistant.id, execution),
            );
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
            setPendingInteraction({
              ...interaction,
              sessionId: interaction.sessionId ?? sessionId,
            });
          },
          onFinalAssistantText: (text, chunk) => {
            finalSnapshotPromise = streamBuffer.flushRoute(chunk).then(() => {
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
          onMessages: (nextMessages, finalSnapshotEvent) => {
            if (finalSnapshotEvent) {
              finalSnapshot = nextMessages;
              const turnId = activeTurnIdsRef.current[sessionId] ?? tempAssistant.turnId;
              finalSnapshotPromise = streamBuffer.flushAllStreaming().then(() => {
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
        const loadedMessages = await fetchMessages(sessionId, {
          includeSuperseded: true,
        }).catch(() => finalSnapshot);
        if (loadedMessages && loadedMessages.length > 0) {
          setMessagesByConversation((current) => ({
            ...current,
            [sessionId]: mergeLoadedMessagesPreservingLocalState(
              current[sessionId] ?? [],
              loadedMessages,
            ),
          }));
        }
        await refreshGoal(sessionId);
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
          return;
        }
        if (!controller.signal.aborted && !isPendingInteractionConflictError(caught)) {
          setError(errorMessage(caught));
        } else if (isPendingInteractionConflictError(caught)) {
          setError(null);
        }
        setMessagesByConversation((current) => ({
          ...current,
          [sessionId]: rollbackMessages,
        }));
      } finally {
        await streamBuffer.flushAllStreaming();
        streamBuffer.dispose();
        if (controllersRef.current[sessionId] === controller) {
          delete controllersRef.current[sessionId];
          clearSessionRunning(sessionId);
        }
      }
    },
    [
      clearSessionRunning,
      applyConnectionRecoveryUpdate,
      applyGoalExecution,
      loadTeamFlow,
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
        if (loadedMessages.length > 0) {
          setMessagesByConversation((current) => ({
            ...current,
            [conversationId]: mergeLoadedMessagesPreservingLocalState(
              current[conversationId] ?? [],
              loadedMessages,
            ),
          }));
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
      const projectUserPrompt = mergedRequestContextPrompt(
        projectDir ? requestContext.projectContexts?.[projectKey(projectDir)]?.trim() : '',
        requestContext.teamModeEnabled === true,
      );

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
            projectUserPrompt,
            allowedSkills: skills
              .map((skill) => skill.name)
              .filter((name) => !requestContext.disabledSkillNames?.has(name)),
            referencePlanMode,
            permissionMode,
            reasoningLevel,
            reasoningTraceVisible: requestContext.reasoningTraceVisible === true,
            interactiveRequestsEnabled:
              requestContext.interactiveRequestsAvailable === true,
            standardImageInputEnabled: requestContext.standardImageInputEnabled === true,
            browserPrivacyMode: requestContext.browserPrivacyMode === true,
            teamModeEnabled: requestContext.teamModeEnabled === true,
            osModeEnabled: requestContext.osModeEnabled === true,
            terminalRuntime: requestContext.terminalRuntime,
            disabledTools: normalizeDisabledToolNames(requestContext.disabledToolNames),
            signal: controller.signal,
            ...handlers,
          }),
      });
    },
    [
      activeConversation,
      activeConversationId,
      activeMessages,
      conversations,
      isSessionSending,
      managedModelConfigs,
      messagesByConversation,
      requestContext.disabledSkillNames,
      requestContext.disabledToolNames,
      requestContext.browserPrivacyMode,
      requestContext.interactiveRequestsAvailable,
      requestContext.osModeEnabled,
      requestContext.reasoningTraceVisible,
      requestContext.teamModeEnabled,
      requestContext.projectContexts,
      requestContext.standardImageInputEnabled,
      requestContext.terminalRuntime,
      referencePlanMode,
      permissionMode,
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
        if (loadedMessages.length > 0) {
          setMessagesByConversation((current) => ({
            ...current,
            [conversationId]: mergeLoadedMessagesPreservingLocalState(
              current[conversationId] ?? [],
              loadedMessages,
            ),
          }));
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
        await sendMessage(content, conversation);
        setNotice(localize(
          '未定位到原消息，已作为新提问发送。',
          'The original message was not found, so this was sent as a new request.',
        ));
        return;
      }
      const createdAt = new Date().toISOString();
      const editedUser: ChatMessage = {
        ...editSourceMessage,
        content: outbound.displayInput,
        conversationId,
        turnId: undefined,
        createdAt,
        attachments: chatAttachmentsFromOutbound(outbound),
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
      const projectUserPrompt = mergedRequestContextPrompt(
        projectDir ? requestContext.projectContexts?.[projectKey(projectDir)]?.trim() : '',
        requestContext.teamModeEnabled === true,
      );

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
            projectUserPrompt,
            allowedSkills: skills
              .map((skill) => skill.name)
              .filter((name) => !requestContext.disabledSkillNames?.has(name)),
            referencePlanMode,
            permissionMode,
            reasoningLevel,
            reasoningTraceVisible: requestContext.reasoningTraceVisible === true,
            interactiveRequestsEnabled:
              requestContext.interactiveRequestsAvailable === true,
            standardImageInputEnabled: requestContext.standardImageInputEnabled === true,
            browserPrivacyMode: requestContext.browserPrivacyMode === true,
            teamModeEnabled: requestContext.teamModeEnabled === true,
            osModeEnabled: requestContext.osModeEnabled === true,
            terminalRuntime: requestContext.terminalRuntime,
            disabledTools: normalizeDisabledToolNames(requestContext.disabledToolNames),
            images: attachments.images,
            files: attachments.files,
            signal: controller.signal,
            ...handlers,
          }),
      });
    },
    [
      activeConversation,
      activeConversationId,
      activeMessages,
      conversations,
      isSessionSending,
      managedModelConfigs,
      messagesByConversation,
      requestContext.disabledSkillNames,
      requestContext.disabledToolNames,
      requestContext.browserPrivacyMode,
      requestContext.interactiveRequestsAvailable,
      requestContext.osModeEnabled,
      requestContext.reasoningTraceVisible,
      requestContext.teamModeEnabled,
      requestContext.projectContexts,
      requestContext.standardImageInputEnabled,
      requestContext.terminalRuntime,
      referencePlanMode,
      permissionMode,
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
        if (
          (isBushServerHttpError(caught, 409) && caught.code === 'turn_guidance_closed') ||
          (isBushServerHttpError(caught, 404) && caught.code === 'turn_not_active')
        ) {
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
        if (
          (isBushServerHttpError(caught, 409) && caught.code === 'turn_guidance_closed') ||
          (isBushServerHttpError(caught, 404) && caught.code === 'turn_not_active')
        ) {
          setMessagesByConversation((current) =>
            removeOptimisticGuidance(current, conversationId, clientMessageId),
          );
          if (!guidanceFallbackIdsRef.current.has(clientMessageId)) {
            guidanceFallbackIdsRef.current.add(clientMessageId);
            await sendMessageRef.current(text, queued.conversation);
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
        const shouldFallback =
          (isBushServerHttpError(caught, 409) && caught.code === 'turn_guidance_closed') ||
          (isBushServerHttpError(caught, 404) && caught.code === 'turn_not_active');
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
    async (reply: string | InteractionReplyAnswer[]) => {
      const interaction = pendingInteraction;
      if (!interaction) {
        return;
      }
      try {
        if (typeof reply === 'string') {
          const text = reply.trim();
          if (!text) {
            return;
          }
          await replyInteraction({ interactionId: interaction.id, rawText: text });
        } else {
          if (reply.length === 0) {
            return;
          }
          await replyInteraction({ interactionId: interaction.id, answers: reply });
        }
        setPendingInteraction(null);
        setError(null);
      } catch (caught) {
        const sessionId =
          interaction.sessionId?.trim() || activeConversationId.trim();
        if (isBushServerHttpError(caught, 409)) {
          const recovered = sessionId
            ? await fetchPendingInteraction(sessionId).catch(() => null)
            : null;
          if (recovered) {
            setPendingInteraction(recovered);
          }
          setError(null);
          setNotice(localize(
            '当前会话正在等待权限确认。',
            'This conversation is waiting for permission confirmation.',
          ));
          return;
        }
        if (
          isBushServerHttpError(caught, 404) ||
          isBushServerHttpError(caught, 410)
        ) {
          const expired = isBushServerHttpError(caught, 410);
          const recovered = sessionId
            ? await fetchPendingInteraction(sessionId).catch(() => null)
            : null;
          setPendingInteraction(recovered);
          setError(null);
          setNotice(
            expired
              ? localize('权限申请已过期，未授予权限。', 'The permission request expired without being granted.')
              : localize('权限申请已不存在。', 'The permission request no longer exists.'),
          );
          return;
        }
        if (isInteractionGoneError(caught)) {
          setPendingInteraction(null);
          setError(null);
          return;
        }
        setError(errorMessage(caught));
      }
    },
    [activeConversationId, pendingInteraction],
  );

  const cancelPendingInteraction = useCallback(async () => {
    const interaction = pendingInteraction;
    if (!interaction) {
      return;
    }
    try {
      await cancelInteraction(interaction.id);
      setPendingInteraction(null);
      setError(null);
    } catch (caught) {
      const sessionId =
        interaction.sessionId?.trim() || activeConversationId.trim();
      if (isBushServerHttpError(caught, 409)) {
        const recovered = sessionId
          ? await fetchPendingInteraction(sessionId).catch(() => null)
          : null;
        if (recovered) {
          setPendingInteraction(recovered);
        }
        setError(null);
        setNotice(localize(
          '当前会话正在等待权限确认。',
          'This conversation is waiting for permission confirmation.',
        ));
        return;
      }
      if (
        isBushServerHttpError(caught, 404) ||
        isBushServerHttpError(caught, 410)
      ) {
        const expired = isBushServerHttpError(caught, 410);
        const recovered = sessionId
          ? await fetchPendingInteraction(sessionId).catch(() => null)
          : null;
        setPendingInteraction(recovered);
        setError(null);
        setNotice(
          expired
            ? localize('权限申请已过期，未授予权限。', 'The permission request expired without being granted.')
            : localize('权限申请已不存在。', 'The permission request no longer exists.'),
        );
        return;
      }
      if (isInteractionGoneError(caught)) {
        setPendingInteraction(null);
        setError(null);
        return;
      }
      setError(errorMessage(caught));
    }
  }, [activeConversationId, pendingInteraction]);

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
      const latestTurn = (
        await fetchSessionMessages(sessionId, {
          includeSuperseded: true,
        }).catch(() => null)
      )?.latestTurn ?? goalLatestTurnByConversation[sessionId];
      if (latestTurn && isRunningSessionTurn(latestTurn)) {
        await stopTurn(latestTurn.turnId).catch((caught) => {
          if (
            !isBushServerHttpError(caught, 404) &&
            !isBushServerHttpError(caught, 409) &&
            !isBushServerHttpError(caught, 410)
          ) {
            throw caught;
          }
        });
      }

      let latestGoal = goal;
      try {
        latestGoal = await updateExperimentalGoal({
          goalId: goal.goalId,
          status: 'cancelled',
          statusReason: localize('用户主动取消', 'Cancelled by user'),
          expectedRevision: goal.revision,
        });
      } catch (caught) {
        if (!isBushServerHttpError(caught, 409)) throw caught;
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
    goalLatestTurnByConversation,
    refreshGoal,
  ]);

  const cancelSending = useCallback(async (conversationId?: string) => {
    const sessionId = (conversationId ?? activeConversationId).trim();
    if (!sessionId) {
      return;
    }
    controllersRef.current[sessionId]?.abort();
    const turnId = activeTurnIdsRef.current[sessionId];
    delete controllersRef.current[sessionId];
    clearSessionRunning(sessionId);
    if (turnId) {
      await stopTurn(turnId).catch((caught) => setError(errorMessage(caught)));
    }
  }, [activeConversationId, clearSessionRunning]);

  const clearError = useCallback(() => setError(null), []);
  const clearNotice = useCallback(() => setNotice(null), []);

  return {
    conversations,
    activeConversation,
    activeConversationId,
    activeMessages,
    messagesByConversation,
    skills,
    loading,
    messagesLoading,
    sending,
    activeTurnId,
    runningByConversation,
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
    reasoningLevel,
    setReasoningLevel,
    openConversation,
    startConversation,
    deleteConversation,
    renameConversation,
    reloadConversations,
    reloadSkills,
    loadSkillDetail,
    createSessionShareLink,
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
    replyToInteraction,
    cancelPendingInteraction,
    cancelSending,
    clearError,
    clearNotice,
  };
}

export function markOptimisticChatRequestAccepted(
  current: Record<string, ChatMessage[]>,
  sessionId: string,
  userMessageId: string,
) {
  return {
    ...current,
    [sessionId]: (current[sessionId] ?? []).map((message) =>
      message.id === userMessageId
        ? {
            ...message,
            status: 'sent',
            metadata: {
              ...(message.metadata ?? {}),
              message_delivery: 'accepted',
            },
          }
        : message,
    ),
  };
}

export function markOptimisticChatRequestFailed(
  current: Record<string, ChatMessage[]>,
  sessionId: string,
  userMessageId: string,
  assistantMessageId: string,
) {
  return {
    ...current,
    [sessionId]: (current[sessionId] ?? [])
      .filter((message) => message.id !== assistantMessageId)
      .map((message) =>
        message.id === userMessageId
          ? {
              ...message,
              status: 'failed',
              metadata: {
                ...(message.metadata ?? {}),
                message_delivery: 'failed',
              },
            }
          : message,
      ),
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

function normalizeReasoningLevels(values?: ReasoningLevel[]): ReasoningLevel[] {
  const normalized = (values ?? [])
    .filter((item) => item === 'low' || item === 'medium' || item === 'high' || item === 'max')
    .filter((item, index, all) => all.indexOf(item) === index);
  return normalized.length > 0 ? normalized : ['low', 'medium', 'max'];
}

function normalizeReasoningLevel(
  value: unknown,
  available: ReasoningLevel[],
): ReasoningLevel {
  const normalized = String(value ?? '').trim().toLowerCase() as ReasoningLevel;
  if (available.includes(normalized)) {
    return normalized;
  }
  return available.includes('medium') ? 'medium' : available[0] ?? 'medium';
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

function mergedRequestContextPrompt(projectPrompt: string | undefined, teamModeEnabled: boolean) {
  return [projectPrompt?.trim() ?? '', teamModeEnabled ? teamModeContextPrompt() : '']
    .filter(Boolean)
    .join('\n\n');
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
  const workspaceMode = conversation.workspaceContext?.mode;
  if (workspaceMode === 'task') {
    return '';
  }
  return (
    conversation.projectDir?.trim() ||
    (workspaceMode === 'project'
      ? conversation.workspaceContext?.projectDir?.trim() || ''
      : '')
  );
}

function hasCompletedAssistantForTurn(messages: ChatMessage[], turnId?: string) {
  const normalizedTurnId = turnId?.trim() ?? '';
  if (!normalizedTurnId) {
    return false;
  }
  return messages.some(
    (message) =>
      message.role === 'assistant' &&
      message.content.trim() &&
      chatMessageTurnId(message) === normalizedTurnId &&
      isAssistantFinalTranscript(message) &&
      !isSupersededLoopAssistant(message),
  );
}

const streamSentenceFlushThreshold = 50;
const streamForceFlushThreshold = 140;
const streamFlushIntervalMs = 40;
const streamBaseCharChunkSize = 4;
const streamMediumCharChunkSize = 8;
const streamFastCharChunkSize = 14;
const streamCatchUpCharChunkSize = 24;

type StreamReadySegment = {
  text: string;
  atomic: boolean;
};

export function createAssistantStreamDeltaBuffer(append: (delta: string) => void) {
  let pending = '';
  const ready: StreamReadySegment[] = [];
  let timer: number | undefined;
  const drainWaiters: Array<() => void> = [];

  const clearTimer = () => {
    if (!timer) {
      return;
    }
    window.clearTimeout(timer);
    timer = undefined;
  };

  const queueReady = () => {
    for (;;) {
      const release = streamBufferedRelease(pending);
      if (release.index <= 0) {
        return;
      }
      ready.push({
        text: pending.slice(0, release.index),
        atomic: release.atomic,
      });
      pending = pending.slice(release.index);
    }
  };

  const schedule = () => {
    if (timer) {
      return;
    }
    timer = window.setTimeout(() => {
      timer = undefined;
      queueReady();
      drainReadyChunk();
      if (pending || ready.length > 0) {
        schedule();
        return;
      }
      resolveDrainWaiters();
    }, streamFlushIntervalMs);
  };

  const drainReadyChunk = () => {
    const segment = ready[0];
    if (!segment) {
      resolveDrainWaiters();
      return;
    }
    const index = acceleratedCharacterChunkEnd(segment.text, readyBacklogLength());
    if (segment.text.length <= index) {
      ready.shift();
      emit(segment.text);
      resolveDrainWaiters();
      return;
    }
    emit(segment.text.slice(0, index));
    segment.text = segment.text.slice(index);
  };

  const emit = (delta: string) => {
    if (!delta) {
      return;
    }
    append(delta);
  };

  const forceReleasePending = () => {
    if (!pending) {
      return;
    }
    ready.push({
      text: pending,
      atomic: false,
    });
    pending = '';
  };

  const readyBacklogLength = () =>
    ready.reduce((total, segment) => total + segment.text.length, 0) + pending.length;

  const resolveDrainWaiters = () => {
    if (pending || ready.length > 0 || drainWaiters.length === 0) {
      return;
    }
    const waiters = drainWaiters.splice(0);
    for (const resolve of waiters) {
      resolve();
    }
  };

  const waitForDrain = () =>
    new Promise<void>((resolve) => {
      if (!pending && ready.length === 0) {
        resolve();
        return;
      }
      drainWaiters.push(resolve);
      schedule();
    });

  const flushAllStreaming = () => {
    forceReleasePending();
    drainReadyChunk();
    return waitForDrain();
  };

  const flushToolBoundary = () => {
    clearTimer();
    forceReleasePending();
    while (ready.length > 0) {
      const segment = ready.shift();
      if (segment?.text) {
        emit(segment.text);
      }
    }
    resolveDrainWaiters();
  };

  return {
    push(delta: string) {
      if (!delta) {
        return;
      }
      pending += delta;
      queueReady();
      drainReadyChunk();
      if (pending || ready.length > 0) {
        schedule();
      }
    },
    flushAllStreaming() {
      return flushAllStreaming();
    },
    flushToolBoundary() {
      flushToolBoundary();
    },
    reset(_nextEmitted = '') {
      clearTimer();
      ready.length = 0;
      pending = '';
      resolveDrainWaiters();
    },
    dispose() {
      clearTimer();
      ready.length = 0;
      pending = '';
      resolveDrainWaiters();
    },
  };
}

type AssistantStreamRoute = Pick<
  AssistantStreamChunk,
  'messageId' | 'assistantSegmentIndex' | 'turnId' | 'createdAt'
>;

function createSegmentedAssistantStreamBuffers(
  append: (delta: string, route: AssistantStreamRoute) => void,
) {
  const buffers = new Map<string, ReturnType<typeof createAssistantStreamDeltaBuffer>>();

  const routeKey = (route: AssistantStreamRoute) =>
    route.messageId.trim() ||
    `${route.turnId.trim()}:segment:${route.assistantSegmentIndex ?? 1}`;

  const bufferFor = (route: AssistantStreamRoute) => {
    const key = routeKey(route);
    const existing = buffers.get(key);
    if (existing) return existing;
    const created = createAssistantStreamDeltaBuffer((delta) => append(delta, route));
    buffers.set(key, created);
    return created;
  };

  return {
    push(delta: string, route: AssistantStreamRoute) {
      bufferFor(route).push(delta);
    },
    reset(route: AssistantStreamRoute, nextEmitted = '') {
      bufferFor(route).reset(nextEmitted);
    },
    flushRoute(route: AssistantStreamRoute) {
      return bufferFor(route).flushAllStreaming();
    },
    flushAllStreaming() {
      return Promise.all(
        [...buffers.values()].map((buffer) => buffer.flushAllStreaming()),
      ).then(() => undefined);
    },
    flushToolBoundary() {
      for (const buffer of buffers.values()) {
        buffer.flushToolBoundary();
      }
    },
    dispose() {
      for (const buffer of buffers.values()) buffer.dispose();
      buffers.clear();
    },
  };
}

function acceleratedCharacterChunkEnd(value: string, backlogLength: number) {
  const targetSize = streamCharacterChunkSize(backlogLength);
  let index = 0;
  let count = 0;
  for (const char of value) {
    index += char.length;
    count += 1;
    if (count >= targetSize) {
      break;
    }
  }
  return Math.max(1, Math.min(value.length, index));
}

function streamCharacterChunkSize(backlogLength: number) {
  if (backlogLength >= 900) {
    return streamCatchUpCharChunkSize;
  }
  if (backlogLength >= 360) {
    return streamFastCharChunkSize;
  }
  if (backlogLength >= 120) {
    return streamMediumCharChunkSize;
  }
  return streamBaseCharChunkSize;
}

function streamBufferedRelease(buffer: string): { index: number; atomic: boolean } {
  if (!buffer) {
    return { index: 0, atomic: false };
  }
  const incompleteTableStart = markdownIncompleteTableStart(buffer);
  const completeTableEnd = markdownFirstCompleteTableEnd(buffer);
  if (
    completeTableEnd > 0 &&
    (incompleteTableStart == null || completeTableEnd <= incompleteTableStart)
  ) {
    return { index: completeTableEnd, atomic: true };
  }

  const eligible =
    incompleteTableStart == null ? buffer : buffer.slice(0, incompleteTableStart);
  if (!eligible) {
    return { index: 0, atomic: false };
  }

  if (eligible.length >= streamSentenceFlushThreshold) {
    const sentenceEnd = lastSentenceBoundary(eligible);
    if (sentenceEnd > 0) {
      return { index: sentenceEnd, atomic: false };
    }
  }

  const paragraphEnd = lastParagraphBoundary(eligible);
  if (paragraphEnd >= streamSentenceFlushThreshold) {
    return { index: paragraphEnd, atomic: false };
  }

  if (eligible.length >= streamForceFlushThreshold) {
    return { index: relaxedTextBoundary(eligible), atomic: false };
  }

  return { index: 0, atomic: false };
}

function lastSentenceBoundary(value: string) {
  let boundary = 0;
  const pattern = /[。！？.!?](?:["'”’）)]|\s|$)*/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) != null) {
    boundary = match.index + match[0].length;
  }
  return boundary;
}

function lastParagraphBoundary(value: string) {
  const index = Math.max(value.lastIndexOf('\n\n'), value.lastIndexOf('\r\n\r\n'));
  return index >= 0 ? index + (value[index] === '\r' ? 4 : 2) : 0;
}

function relaxedTextBoundary(value: string) {
  const sentenceEnd = lastSentenceBoundary(value);
  if (sentenceEnd > 0) {
    return sentenceEnd;
  }
  const newlineIndex = value.lastIndexOf('\n');
  if (newlineIndex > 0) {
    return newlineIndex + 1;
  }
  const whitespaceMatch = value.slice(0, streamForceFlushThreshold).match(/\s+\S*$/);
  if (whitespaceMatch?.index != null && whitespaceMatch.index > 0) {
    return whitespaceMatch.index + whitespaceMatch[0].length;
  }
  return Math.min(value.length, streamForceFlushThreshold);
}

type MarkdownLineSegment = {
  text: string;
  body: string;
  start: number;
  end: number;
  hasLineBreak: boolean;
};

function markdownFirstCompleteTableEnd(value: string) {
  const table = markdownTableRange(value);
  return table?.complete ? table.end : 0;
}

function markdownIncompleteTableStart(value: string) {
  const table = markdownTableRange(value);
  return table && !table.complete ? table.start : undefined;
}

function markdownTableRange(value: string) {
  const lines = markdownLineSegments(value);
  for (let index = 0; index < lines.length - 1; index += 1) {
    const header = lines[index];
    const separator = lines[index + 1];
    if (!isMarkdownTableRow(header.body) || !isMarkdownTableSeparator(separator.body)) {
      continue;
    }
    if (!separator.hasLineBreak) {
      return {
        start: header.start,
        end: value.length,
        complete: false,
      };
    }
    let endIndex = index + 2;
    while (
      endIndex < lines.length &&
      isMarkdownTableRow(lines[endIndex].body)
    ) {
      if (!lines[endIndex].hasLineBreak && endIndex === lines.length - 1) {
        return {
          start: header.start,
          end: value.length,
          complete: false,
        };
      }
      endIndex += 1;
    }
    if (endIndex >= lines.length) {
      return {
        start: header.start,
        end: value.length,
        complete: false,
      };
    }
    return {
      start: header.start,
      end: lines[endIndex - 1]?.end ?? separator.end,
      complete: true,
    };
  }
  return null;
}

function markdownLineSegments(value: string): MarkdownLineSegment[] {
  const lines: MarkdownLineSegment[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== '\n') {
      continue;
    }
    const end = index + 1;
    const text = value.slice(start, end);
    lines.push({
      text,
      body: text.replace(/\r?\n$/, ''),
      start,
      end,
      hasLineBreak: true,
    });
    start = end;
  }
  if (start < value.length) {
    const text = value.slice(start);
    lines.push({
      text,
      body: text,
      start,
      end: value.length,
      hasLineBreak: false,
    });
  }
  return lines;
}

function isMarkdownTableRow(value: string) {
  const text = value.trim();
  if (!text.includes('|')) {
    return false;
  }
  return text.startsWith('|') || text.endsWith('|') || text.split('|').length >= 3;
}

function isMarkdownTableSeparator(value: string) {
  const text = value.trim();
  if (!text.includes('|')) {
    return false;
  }
  const cells = text
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
    .filter(Boolean);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

export function appendAssistantDelta(
  current: Record<string, ChatMessage[]>,
  sessionId: string,
  assistantId: string,
  delta: string,
  route?: AssistantStreamRoute,
) {
  const messages = [...(current[sessionId] ?? [])];
  const targetIndex = assistantStreamTargetIndex(messages, assistantId, route);
  if (targetIndex < 0) {
    const messageId = route?.messageId.trim() ?? '';
    const segmentIndex = route?.assistantSegmentIndex ?? 1;
    messages.push({
      id: messageId || `assistant-${route?.turnId || sessionId}-segment-${segmentIndex}`,
      messageId: messageId || undefined,
      assistantMessageId: messageId || undefined,
      role: 'assistant',
      content: delta,
      conversationId: sessionId,
      turnId: route?.turnId || undefined,
      createdAt: route?.createdAt || new Date().toISOString(),
      metadata: {
        ...(segmentIndex ? { assistant_segment_index: segmentIndex } : {}),
        ...(messageId ? { message_id: messageId } : {}),
      },
    });
    return { ...current, [sessionId]: messages };
  }
  return {
    ...current,
    [sessionId]: messages.map((message, index) => {
      if (index !== targetIndex) {
        return message;
      }
      const routed = applyAssistantStreamRoute(message, route);
      if (!route?.messageId && shouldStartNextLocalAssistantSegment(routed, delta)) {
        const loopHistory = mergeLoopHistoryMessages(
          routed.loopHistory ?? [],
          [localLoopHistorySnapshot(routed)],
        );
        return {
          ...routed,
          content: delta,
          toolExecutions: undefined,
          loopHistory: loopHistory.length > 0 ? loopHistory : undefined,
        };
      }
      return {
        ...routed,
        content: appendAssistantTextAfterToolBoundary(routed, delta),
      };
    }),
  };
}

export function appendAssistantTextAfterToolBoundary(
  message: ChatMessage,
  delta: string,
) {
  const content = message.content;
  if (!content.trim() || !delta.trim() || /\r?\n\s*$/.test(content) || /^\s/.test(delta)) {
    return `${content}${delta}`;
  }
  const latestToolOffset = Math.max(
    -1,
    ...(message.toolExecutions ?? []).map((execution) => execution.contentOffset),
  );
  return latestToolOffset >= content.length
    ? `${content}\n\n${delta}`
    : `${content}${delta}`;
}

export function applyAssistantSegmentBoundary(
  current: Record<string, ChatMessage[]>,
  sessionId: string,
  fallbackAssistantId: string,
  update: StreamExecutionUpdate,
) {
  const messages = [...(current[sessionId] ?? [])];
  const nextSegmentIndex =
    update.nextAssistantSegmentIndex ?? update.assistantSegmentIndex;
  const previousSegmentIndex =
    update.previousAssistantSegmentIndex ??
    (nextSegmentIndex != null && nextSegmentIndex > 1
      ? nextSegmentIndex - 1
      : undefined);
  const previousIndex = assistantStreamTargetIndex(messages, fallbackAssistantId, {
    messageId: '',
    assistantSegmentIndex: previousSegmentIndex,
    turnId: update.turnId,
  });
  if (previousIndex >= 0 && messages[previousIndex].role === 'assistant') {
    const previous = messages[previousIndex];
    messages[previousIndex] = {
      ...previous,
      status: 'complete',
      metadata: {
        ...(previous.metadata ?? {}),
        status: 'complete',
        segment_complete: true,
        segment_boundary: 'turn_guidance',
        ...(nextSegmentIndex != null
          ? { next_assistant_segment_index: nextSegmentIndex }
          : {}),
      },
    };
  }

  const nextMessageId = update.messageId.trim();
  if (nextSegmentIndex == null || nextSegmentIndex <= 1) {
    return { ...current, [sessionId]: messages };
  }
  const nextIndex = assistantStreamTargetIndex(messages, fallbackAssistantId, {
    messageId: nextMessageId,
    assistantSegmentIndex: nextSegmentIndex,
    turnId: update.turnId,
  });
  if (nextIndex < 0) {
    messages.push({
      id:
        nextMessageId ||
        `assistant-${update.turnId || sessionId}-segment-${nextSegmentIndex}`,
      messageId: nextMessageId || undefined,
      assistantMessageId: nextMessageId || undefined,
      role: 'assistant',
      content: '',
      conversationId: sessionId,
      turnId: update.turnId || undefined,
      createdAt: update.createdAt || new Date().toISOString(),
      status: 'streaming',
      metadata: {
        assistant_segment_index: nextSegmentIndex,
        ...(nextMessageId ? { message_id: nextMessageId } : {}),
      },
    });
  }
  return { ...current, [sessionId]: messages };
}

export function optimisticGuidanceMessage({
  clientMessageId,
  conversationId,
  turnId,
  content,
  mode,
}: {
  clientMessageId: string;
  conversationId: string;
  turnId: string;
  content: string;
  mode: 'append_context' | 'interrupt_and_continue';
}): ChatMessage {
  return {
    id: clientMessageId,
    clientMessageId,
    role: 'user',
    content,
    conversationId,
    turnId,
    createdAt: new Date().toISOString(),
    status: 'pending',
    metadata: {
      turn_guidance: true,
      client_message_id: clientMessageId,
      guidance_mode: mode,
      guidance_delivery: 'pending',
    },
  };
}

export function reconcileOptimisticGuidance(
  current: Record<string, ChatMessage[]>,
  sessionId: string,
  localClientMessageId: string,
  acceptedClientMessageId: string,
) {
  const clientMessageId = acceptedClientMessageId.trim() || localClientMessageId;
  return {
    ...current,
    [sessionId]: (current[sessionId] ?? []).map((message) =>
      message.id === localClientMessageId || message.clientMessageId === localClientMessageId
        ? {
            ...message,
            clientMessageId,
            status: 'queued',
            metadata: {
              ...(message.metadata ?? {}),
              client_message_id: clientMessageId,
              guidance_delivery: 'queued',
            },
          }
        : message,
    ),
  };
}

function markOptimisticGuidanceFailed(
  current: Record<string, ChatMessage[]>,
  sessionId: string,
  clientMessageId: string,
) {
  return {
    ...current,
    [sessionId]: (current[sessionId] ?? []).map((message) =>
      message.id === clientMessageId || message.clientMessageId === clientMessageId
        ? {
            ...message,
            status: 'failed',
            metadata: {
              ...(message.metadata ?? {}),
              guidance_delivery: 'failed',
            },
          }
        : message,
    ),
  };
}

function markOptimisticGuidancePending(
  current: Record<string, ChatMessage[]>,
  sessionId: string,
  clientMessageId: string,
) {
  return {
    ...current,
    [sessionId]: (current[sessionId] ?? []).map((message) =>
      message.id === clientMessageId || message.clientMessageId === clientMessageId
        ? {
            ...message,
            status: 'pending',
            metadata: {
              ...(message.metadata ?? {}),
              guidance_delivery: 'pending',
            },
          }
        : message,
    ),
  };
}

function removeOptimisticGuidance(
  current: Record<string, ChatMessage[]>,
  sessionId: string,
  clientMessageId: string,
) {
  return {
    ...current,
    [sessionId]: (current[sessionId] ?? []).filter(
      (message) =>
        message.id !== clientMessageId && message.clientMessageId !== clientMessageId,
    ),
  };
}

function ensureBackgroundTurnAssistant(
  current: Record<string, ChatMessage[]>,
  sessionId: string,
  assistantId: string,
  turnId: string,
  createdAt?: string,
) {
  const messages = current[sessionId] ?? [];
  if (messages.some((message) => message.id === assistantId)) {
    return current;
  }
  return {
    ...current,
    [sessionId]: [
      ...messages,
      {
        id: assistantId,
        role: 'assistant' as const,
        content: '',
        conversationId: sessionId,
        turnId,
        createdAt: createdAt || new Date().toISOString(),
        metadata: {
          background_turn: true,
          goal_auto_continuation: true,
        },
      },
    ],
  };
}

function assistantStreamTargetIndex(
  messages: ChatMessage[],
  fallbackAssistantId: string,
  route?: AssistantStreamRoute,
) {
  const messageId = route?.messageId.trim() ?? '';
  if (messageId) {
    const exact = messages.findIndex((message) =>
      message.role === 'assistant' && (
        message.id === messageId ||
        message.messageId === messageId ||
        message.assistantMessageId === messageId ||
        String(message.metadata?.message_id ?? '') === messageId
      ),
    );
    if (exact >= 0) return exact;
  }
  const segmentIndex = route?.assistantSegmentIndex;
  if (segmentIndex != null) {
    const exactSegment = messages.findIndex((message) =>
      message.role === 'assistant' &&
      chatMessageTurnId(message) === route?.turnId &&
      Number(message.metadata?.assistant_segment_index) === segmentIndex,
    );
    if (exactSegment >= 0) return exactSegment;
    if (segmentIndex > 1) return -1;
  }
  return messages.findIndex((message) => message.id === fallbackAssistantId);
}

function applyAssistantStreamRoute(
  message: ChatMessage,
  route?: AssistantStreamRoute,
): ChatMessage {
  if (!route) return message;
  const messageId = route.messageId.trim();
  return {
    ...message,
    messageId: messageId || message.messageId,
    assistantMessageId: messageId || message.assistantMessageId,
    turnId: route.turnId || message.turnId,
    createdAt: message.createdAt ?? route.createdAt,
    metadata: {
      ...(message.metadata ?? {}),
      ...(messageId ? { message_id: messageId } : {}),
      ...(route.assistantSegmentIndex != null
        ? { assistant_segment_index: route.assistantSegmentIndex }
        : {}),
    },
  };
}

function shouldStartNextLocalAssistantSegment(message: ChatMessage, delta: string) {
  return (
    message.role === 'assistant' &&
    delta.trim().length > 0 &&
    (message.toolExecutions?.length ?? 0) > 0 &&
    hasVisibleLoopHistory(message)
  );
}

function localLoopHistorySnapshot(message: ChatMessage): ChatMessage {
  const nextLoopIndex = nextLocalLoopIndex(message);
  return {
    ...snapshotLoopHistoryMessage(message),
    id: `${message.id}:local-loop:${nextLoopIndex}`,
    createdAt: new Date().toISOString(),
    status: 'superseded',
    loopIndex: message.loopIndex ?? nextLoopIndex,
    metadata: {
      ...(message.metadata ?? {}),
      status: 'superseded',
      transcript_kind: 'assistant_loop',
      ui_transcript_only: true,
    },
  };
}

function nextLocalLoopIndex(message: ChatMessage) {
  const existing = message.loopHistory ?? [];
  const loopIndexes = existing
    .map((item) => item.loopIndex)
    .filter((value): value is number => Number.isFinite(value));
  const maxLoopIndex = loopIndexes.length > 0 ? Math.max(...loopIndexes) : 0;
  return maxLoopIndex + 1;
}

export function applyAssistantRevision(
  current: Record<string, ChatMessage[]>,
  sessionId: string,
  assistantId: string,
  revision: AssistantRevision,
) {
  const messages = current[sessionId] ?? [];
  const revisionTurnId = revision.turnId?.trim() ?? '';
  const isClear = revision.action === 'clear' || revision.action === 'replace';
  if (!isClear) {
    return current;
  }
  const nextContent = revision.content ?? '';
  if (revision.reason === 'tool_preamble' && !nextContent.trim()) {
    return current;
  }
  const route: AssistantStreamRoute = {
    messageId: revision.messageId ?? '',
    assistantSegmentIndex: revision.assistantSegmentIndex,
    turnId: revisionTurnId,
  };
  const targetIndex = assistantStreamTargetIndex(messages, assistantId, route);
  if (
    targetIndex < 0 &&
    nextContent &&
    (route.messageId || (route.assistantSegmentIndex ?? 1) > 1)
  ) {
    return applyAssistantRevision(
      appendAssistantDelta(current, sessionId, assistantId, nextContent, route),
      sessionId,
      assistantId,
      revision,
    );
  }
  return {
    ...current,
    [sessionId]: messages.map((message, index) => {
      if (index !== targetIndex) {
        return message;
      }
      const routed = applyAssistantStreamRoute(message, route);
      const shouldPreserveCurrent =
        routed.role === 'assistant' &&
        !isSupersededLoopAssistant(routed) &&
        hasVisibleLoopHistory(routed) &&
        (normalizeLoopContent(routed.content) !== normalizeLoopContent(nextContent) ||
          revision.reason === 'tool_preamble' ||
          revision.reason === 'assistant_final');
      const loopHistory = shouldPreserveCurrent
        ? mergeLoopHistoryMessages(
            routed.loopHistory ?? [],
            [localLoopHistorySnapshot(routed)],
          )
        : routed.loopHistory;
      return {
        ...routed,
        content: nextContent,
        loopIndex: revision.loopIndex ?? routed.loopIndex,
        toolExecutions: shouldPreserveCurrent ? undefined : routed.toolExecutions,
        loopHistory:
          loopHistory && loopHistory.length > 0 ? loopHistory : undefined,
        metadata: {
          ...(routed.metadata ?? {}),
          assistant_channel: 'assistant',
          transcript_kind:
            revision.reason === 'assistant_final'
              ? 'assistant_final'
              : revision.reason === 'tool_preamble'
                ? 'assistant_segment'
                : routed.metadata?.transcript_kind,
        },
      };
    }),
  };
}

function assignTurnToLocalMessages(
  current: Record<string, ChatMessage[]>,
  sessionId: string,
  turnId: string,
  messageIds: string[],
  route?: AssistantStreamRoute,
) {
  const ids = new Set(messageIds);
  const startedAt = new Date().toISOString();
  return {
    ...current,
    [sessionId]: (current[sessionId] ?? []).map((message) =>
      ids.has(message.id)
        ? markLocalMessageTurnStarted(
            applyAssistantStreamRoute(
              { ...message, turnId, conversationId: sessionId },
              message.role === 'assistant' ? route : undefined,
            ),
            startedAt,
          )
        : message,
    ),
  };
}

function markLocalMessageTurnStarted(message: ChatMessage, startedAt: string) {
  if (message.role !== 'assistant') {
    return message;
  }
  return {
    ...message,
    metadata: {
      ...(message.metadata ?? {}),
      cardbush_turn_started_at:
        message.metadata?.cardbush_turn_started_at ??
        message.createdAt ??
        startedAt,
    },
  };
}

function markLocalAssistantTurnCompleted(
  current: Record<string, ChatMessage[]>,
  sessionId: string,
  assistantId: string,
  completedAt: string,
  route?: AssistantStreamRoute,
  finalText = '',
) {
  const messages = current[sessionId] ?? [];
  const targetIndex = assistantStreamTargetIndex(messages, assistantId, route);
  if (targetIndex < 0 && finalText) {
    return markLocalAssistantTurnCompleted(
      appendAssistantDelta(current, sessionId, assistantId, finalText, route),
      sessionId,
      assistantId,
      completedAt,
      route,
    );
  }
  return {
    ...current,
    [sessionId]: messages.map((message, index) => {
      if (index !== targetIndex || message.role !== 'assistant') {
        return message;
      }
      const routed = applyAssistantStreamRoute(message, route);
      return {
        ...routed,
        content: routed.content || finalText,
        metadata: {
          ...(routed.metadata ?? {}),
          cardbush_turn_started_at:
            routed.metadata?.cardbush_turn_started_at ?? routed.createdAt,
          cardbush_turn_completed_at:
            routed.metadata?.cardbush_turn_completed_at ?? completedAt,
        },
      };
    }),
  };
}

export function appendToolExecution(
  current: Record<string, ChatMessage[]>,
  sessionId: string,
  assistantId: string,
  execution: ChatToolExecution,
) {
  const messages = [...(current[sessionId] ?? [])];
  const executionRoute = assistantRouteFromToolExecution(execution);
  if (
    executionRoute.assistantSegmentIndex != null &&
    executionRoute.assistantSegmentIndex > 1 &&
    assistantStreamTargetIndex(messages, assistantId, executionRoute) < 0
  ) {
    const messageId = executionRoute.messageId.trim();
    messages.push({
      id:
        messageId ||
        `assistant-${executionRoute.turnId || sessionId}-segment-${executionRoute.assistantSegmentIndex}`,
      messageId: messageId || undefined,
      assistantMessageId: messageId || undefined,
      role: 'assistant',
      content: '',
      conversationId: sessionId,
      turnId: executionRoute.turnId || undefined,
      createdAt: execution.createdAt,
      status: 'streaming',
      metadata: {
        assistant_segment_index: executionRoute.assistantSegmentIndex,
        ...(messageId ? { message_id: messageId } : {}),
      },
    });
  }
  const targetMessageId = toolExecutionTargetMessageId(messages, assistantId, execution);
  return {
    ...current,
    [sessionId]: messages.map((message) => {
      if (message.id !== targetMessageId) {
        return message;
      }
      const existing = message.toolExecutions ?? [];
      const index = existing.findIndex((item) => item.id === execution.id);
      if (index < 0 && loopHistoryHasToolExecution(message, execution.id)) {
        return updateLoopHistoryToolExecution(message, execution);
      }
      const contentOffset =
        index >= 0
          ? existing[index].contentOffset
          : execution.contentOffsetExplicit
            ? execution.contentOffset
            : message.content.length;
      const nextExecution = {
        ...execution,
        contentOffset,
        contentOffsetExplicit: true,
      };
      const nextExecutions =
        index >= 0
          ? existing.map((item, itemIndex) =>
              itemIndex === index ? mergeToolExecutionUpdate(item, nextExecution) : item,
            )
          : [...existing, nextExecution];
      return {
        ...message,
        toolExecutions: nextExecutions,
      };
    }),
  };
}

function mergeToolExecutionUpdate(
  current: ChatToolExecution,
  incoming: ChatToolExecution,
): ChatToolExecution {
  const currentSettled = toolExecutionStateRank(current.state) >= 2;
  const incomingRunning = toolExecutionStateRank(incoming.state) < 2;
  const merged = { ...current, ...incoming };
  if (!currentSettled || !incomingRunning) {
    return merged;
  }
  return {
    ...merged,
    state: current.state,
    success: current.success,
    durationMs: Math.max(current.durationMs, incoming.durationMs),
  };
}

function toolExecutionStateRank(value: string) {
  const state = value.trim().toLowerCase();
  if (['completed', 'complete', 'succeeded', 'success', 'done'].includes(state)) return 3;
  if (['failed', 'fail', 'error', 'cancelled', 'canceled', 'stopped'].includes(state)) return 2;
  if (['using', 'running', 'pending', 'started', 'queued'].includes(state)) return 1;
  return 0;
}

function applyTaskPlanUpdate(
  current: Record<string, ChatMessage[]>,
  sessionId: string,
  assistantId: string,
  update: TaskPlanStreamUpdate,
) {
  if (update.plan.sessionId !== sessionId) {
    return current;
  }
  const messages = current[sessionId] ?? [];
  let applied = false;
  const targetIndex = assistantStreamTargetIndex(messages, assistantId, {
    messageId: update.messageId ?? '',
    assistantSegmentIndex: update.assistantSegmentIndex,
    turnId: update.turnId,
  });
  const nextMessages = messages.map((message, index) => {
    if (index !== targetIndex || message.role !== 'assistant') {
      return message;
    }
    const currentTurnId = message.turnId?.trim() ?? '';
    if (currentTurnId && currentTurnId !== update.turnId) {
      return message;
    }
    applied = true;
    return {
      ...message,
      turnId: currentTurnId || update.turnId,
      taskPlan: update.plan,
    };
  });
  return applied ? { ...current, [sessionId]: nextMessages } : current;
}

function loopHistoryHasToolExecution(message: ChatMessage, executionId: string) {
  return Boolean(
    message.loopHistory?.some((loopMessage) =>
      loopMessage.toolExecutions?.some((item) => item.id === executionId),
    ),
  );
}

function updateLoopHistoryToolExecution(
  message: ChatMessage,
  execution: ChatToolExecution,
) {
  return {
    ...message,
    loopHistory: message.loopHistory?.map((loopMessage) => {
      const existing = loopMessage.toolExecutions ?? [];
      const index = existing.findIndex((item) => item.id === execution.id);
      if (index < 0) {
        return loopMessage;
      }
      const nextExecutions = existing.map((item, itemIndex) =>
        itemIndex === index
          ? mergeToolExecutionUpdate(item, {
              ...execution,
              contentOffset: item.contentOffset,
            })
          : item,
      );
      return {
        ...loopMessage,
        toolExecutions: nextExecutions,
      };
    }),
  };
}

function toolExecutionTargetMessageId(
  messages: ChatMessage[],
  fallbackAssistantId: string,
  execution: ChatToolExecution,
) {
  const assistantMessageId = execution.assistantMessageId?.trim() ?? '';
  if (assistantMessageId) {
    const matched = messages.find(
      (message) =>
        message.id === assistantMessageId ||
        message.messageId === assistantMessageId ||
        message.assistantMessageId === assistantMessageId,
    );
    if (matched) {
      return matched.id;
    }
  }
  const route = assistantRouteFromToolExecution(execution);
  if (route.assistantSegmentIndex != null) {
    const matched = messages.find((message) =>
      message.role === 'assistant' &&
      chatMessageTurnId(message) === route.turnId &&
      Number(message.metadata?.assistant_segment_index) === route.assistantSegmentIndex,
    );
    if (matched) {
      return matched.id;
    }
  }
  if (execution.loopIndex != null) {
    const matched = messages.find((message) =>
      message.role === 'assistant' &&
      numericOrderValue(message.loopIndex) === numericOrderValue(execution.loopIndex),
    );
    if (matched) {
      return matched.id;
    }
  }
  return fallbackAssistantId;
}

function assistantRouteFromToolExecution(
  execution: ChatToolExecution,
): AssistantStreamRoute {
  return {
    messageId:
      execution.assistantMessageId?.trim() || execution.messageId?.trim() || '',
    assistantSegmentIndex:
      execution.assistantSegmentIndex ??
      optionalFiniteNumber(execution.metadata.assistant_segment_index),
    turnId:
      execution.turnId?.trim() || String(execution.metadata.turn_id ?? '').trim(),
    createdAt: execution.createdAt,
  };
}

function optionalFiniteNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function mergeMessages(
  current: Record<string, ChatMessage[]>,
  sessionId: string,
  incoming: ChatMessage[],
) {
  const byId = new Map((current[sessionId] ?? []).map((item) => [item.id, item]));
  for (const message of incoming) {
    const clientMessageId = chatMessageClientMessageId(message);
    const clientEntry = clientMessageId
      ? [...byId.entries()].find(([, item]) =>
          chatMessageClientMessageId(item) === clientMessageId,
        )
      : undefined;
    const existing = byId.get(message.id) ?? clientEntry?.[1];
    if (clientEntry && clientEntry[0] !== message.id) {
      byId.delete(clientEntry[0]);
    }
    const nextToolExecutions =
      (message.toolExecutions?.length ?? 0) > 0
        ? message.toolExecutions
        : existing?.toolExecutions;
    const preservedVersions =
      existing && shouldPreserveExistingAsLoopHistory(existing, message)
        ? [existing]
        : [];
    const nextLoopHistory = mergeLoopHistoryMessages(
      existing?.loopHistory ?? [],
      [...preservedVersions, ...(message.loopHistory ?? [])],
    );
    byId.set(message.id, {
      ...message,
      attachments: message.attachments ?? existing?.attachments,
      taskPlan: message.taskPlan ?? existing?.taskPlan,
      toolExecutions: nextToolExecutions,
      loopHistory: nextLoopHistory.length > 0 ? nextLoopHistory : undefined,
    });
  }
  return {
    ...current,
    [sessionId]: collapseLoopTranscriptMessages(Array.from(byId.values())),
  };
}

export function mergeFinalStreamMessages(
  current: Record<string, ChatMessage[]>,
  sessionId: string,
  incoming: ChatMessage[],
  options: {
    turnId?: string;
    temporaryMessageIds?: string[];
    toolSourceMessageId?: string;
  } = {},
) {
  if (incoming.length === 0) {
    return current;
  }
  const existing = current[sessionId] ?? [];
  const existingById = new Map(existing.map((item) => [item.id, item]));
  const temporaryIds = new Set(options.temporaryMessageIds ?? []);
  const incomingIds = new Set(incoming.map((item) => item.id));
  const incomingTurnIds = new Set(
    incoming
      .map((item) => item.turnId?.trim() ?? '')
      .filter(Boolean),
  );
  const targetTurnId = options.turnId?.trim() ?? '';
  const toolSource = options.toolSourceMessageId
    ? existingById.get(options.toolSourceMessageId)
    : undefined;
  const localToolExecutions = toolSource?.toolExecutions ?? [];
  const completedAt = new Date().toISOString();

  const mergedIncoming = attachLocalToolExecutionsToTranscriptMessages(incoming.map((message) => {
    const existingMessage =
      existingById.get(message.id) ??
      findStreamReplacementSource(existing, message, {
        targetTurnId,
        temporaryIds,
      });
    const existingToolExecutions =
      existingMessage && !temporaryIds.has(existingMessage.id)
        ? existingMessage.toolExecutions
        : undefined;
    return {
      ...message,
      createdAt: existingMessage?.createdAt ?? message.createdAt,
      attachments: message.attachments ?? existingMessage?.attachments,
      metadata: mergeFinalAssistantTimingMetadata(
        message,
        existingMessage,
        completedAt,
      ),
      toolExecutions:
        (message.toolExecutions?.length ?? 0) > 0
          ? message.toolExecutions
          : existingToolExecutions,
      taskPlan: message.taskPlan ?? existingMessage?.taskPlan,
      loopHistory:
        (message.loopHistory?.length ?? 0) > 0
          ? message.loopHistory
          : existingMessage?.loopHistory,
    };
  }), localToolExecutions);

  if (
    localToolExecutions.length > 0 &&
    !mergedIncoming.some((message) => (message.toolExecutions?.length ?? 0) > 0) &&
    mergedIncoming.filter((message) => message.role === 'assistant').length === 1
  ) {
    const targetIndex = findLastIndex(
      mergedIncoming,
      (message) => message.role === 'assistant',
    );
    if (targetIndex >= 0) {
      const target = mergedIncoming[targetIndex];
      mergedIncoming[targetIndex] = {
        ...target,
        toolExecutions: mergeToolExecutionLists(
          target.toolExecutions ?? [],
          localToolExecutions,
        ),
      };
    }
  }

  const normalizedIncoming = collapseLoopTranscriptMessages(mergedIncoming);
  const segmentedIncoming = normalizedIncoming.some(
    (message) =>
      message.role === 'assistant' &&
      Number.isFinite(Number(message.metadata?.assistant_segment_index)),
  );
  const shouldReplace = (message: ChatMessage) => {
    const messageTurnId = message.turnId?.trim() ?? '';
    if (message.role === 'user') {
      const matchingIncomingUser = normalizedIncoming.find((candidate) => {
        if (candidate.role !== 'user') {
          return false;
        }
        if (candidate.id === message.id) {
          return true;
        }
        const candidateTurnId = candidate.turnId?.trim() ?? '';
        if (messageTurnId && candidateTurnId === messageTurnId) {
          return true;
        }
        return (
          normalizeEditableUserContent(candidate.content) ===
          normalizeEditableUserContent(message.content)
        );
      });
      if (
        incomingIds.has(message.id) ||
        temporaryIds.has(message.id) ||
        (!segmentedIncoming && targetTurnId && messageTurnId === targetTurnId) ||
        Boolean(!segmentedIncoming && messageTurnId && incomingTurnIds.has(messageTurnId))
      ) {
        return Boolean(
          matchingIncomingUser ??
            findPersistedEditableUserMessage(message, normalizedIncoming),
        );
      }
      return false;
    }
    if (incomingIds.has(message.id) || temporaryIds.has(message.id)) {
      return true;
    }
    if (!segmentedIncoming && targetTurnId && messageTurnId === targetTurnId) {
      return true;
    }
    return Boolean(!segmentedIncoming && messageTurnId && incomingTurnIds.has(messageTurnId));
  };

  const replacedMessages = existing.filter(shouldReplace);
  const loopHistory = collectLoopHistoryFromReplaced(
    replacedMessages,
    normalizedIncoming,
    temporaryIds,
  );
  if (loopHistory.length > 0) {
    attachLoopHistoryToFinalAssistant(normalizedIncoming, loopHistory);
  }

  const replaceIndex = existing.findIndex(shouldReplace);
  const kept = existing.filter((message) => !shouldReplace(message));
  const insertAt = replaceIndex < 0
    ? kept.length
    : existing.slice(0, replaceIndex).filter((message) => !shouldReplace(message)).length;
  const nextMessages = [...kept];
  nextMessages.splice(insertAt, 0, ...normalizedIncoming);
  return {
    ...current,
    [sessionId]: collapseLoopTranscriptMessages(nextMessages),
  };
}

function mergeFinalAssistantTimingMetadata(
  message: ChatMessage,
  existingMessage: ChatMessage | undefined,
  completedAt: string,
) {
  if (message.role !== 'assistant' || isSupersededLoopAssistant(message)) {
    return message.metadata;
  }
  return {
    ...(message.metadata ?? {}),
    cardbush_turn_started_at:
      message.metadata?.cardbush_turn_started_at ??
      existingMessage?.metadata?.cardbush_turn_started_at ??
      existingMessage?.createdAt ??
      message.createdAt,
    cardbush_turn_completed_at:
      message.metadata?.cardbush_turn_completed_at ??
      existingMessage?.metadata?.cardbush_turn_completed_at ??
      completedAt,
  };
}

function attachLocalToolExecutionsToTranscriptMessages(
  messages: ChatMessage[],
  localToolExecutions: ChatToolExecution[],
) {
  if (localToolExecutions.length === 0) {
    return messages;
  }
  return messages.map((message) => {
    if (message.role !== 'assistant') {
      return message;
    }
    const matchedExecutions = localToolExecutions.filter((execution) =>
      toolExecutionBelongsToMessage(message, execution),
    );
    if (matchedExecutions.length === 0) {
      return message;
    }
    return {
      ...message,
      toolExecutions: mergeToolExecutionLists(
        message.toolExecutions ?? [],
        matchedExecutions,
      ),
    };
  });
}

function toolExecutionBelongsToMessage(
  message: ChatMessage,
  execution: ChatToolExecution,
) {
  const assistantMessageId = execution.assistantMessageId?.trim() ?? '';
  if (assistantMessageId) {
    return (
      message.id === assistantMessageId ||
      (message.messageId?.trim() ?? '') === assistantMessageId ||
      (message.assistantMessageId?.trim() ?? '') === assistantMessageId
    );
  }
  const executionSegmentIndex =
    execution.assistantSegmentIndex ??
    optionalFiniteNumber(execution.metadata.assistant_segment_index);
  const executionTurnId =
    execution.turnId?.trim() || String(execution.metadata.turn_id ?? '').trim();
  if (executionSegmentIndex != null && executionTurnId) {
    return (
      chatMessageTurnId(message) === executionTurnId &&
      Number(message.metadata?.assistant_segment_index) === executionSegmentIndex
    );
  }
  const executionLoopIndex = numericOrderValue(execution.loopIndex);
  const messageLoopIndex = numericOrderValue(message.loopIndex);
  return (
    executionLoopIndex != null &&
    messageLoopIndex != null &&
    executionLoopIndex === messageLoopIndex
  );
}

function mergeToolExecutionLists(
  primary: ChatToolExecution[],
  fallback: ChatToolExecution[],
) {
  const byId = new Map<string, ChatToolExecution>();
  for (const execution of fallback) {
    byId.set(execution.id, execution);
  }
  for (const execution of primary) {
    const current = byId.get(execution.id);
    byId.set(
      execution.id,
      current ? mergeToolExecutionUpdate(current, execution) : execution,
    );
  }
  return Array.from(byId.values()).sort(compareToolExecutionTranscriptOrder);
}

function compareToolExecutionTranscriptOrder(
  left: ChatToolExecution,
  right: ChatToolExecution,
) {
  return (
    compareOptionalOrder(numericOrderValue(left.sequence), numericOrderValue(right.sequence)) ||
    compareOptionalOrder(numericOrderValue(left.loopIndex), numericOrderValue(right.loopIndex)) ||
    compareOptionalOrder(dateOrderValue(left.createdAt), dateOrderValue(right.createdAt))
  );
}

function mergeLoadedMessagesPreservingLocalState(
  existing: ChatMessage[],
  loaded: ChatMessage[],
) {
  if (existing.length === 0 || loaded.length === 0) {
    return collapseLoopTranscriptMessages(loaded);
  }
  return collapseLoopTranscriptMessages(loaded.map((message) => {
    const source = findLocalMessageStateSource(existing, message);
    if (!source) {
      return message;
    }
    return {
      ...message,
      metadata: preserveLocalAssistantTimingMetadata(message, source),
      attachments: message.attachments ?? source.attachments,
      taskPlan: message.taskPlan ?? source.taskPlan,
      toolExecutions: mergeToolExecutionLists(
        message.toolExecutions ?? [],
        source.toolExecutions ?? [],
      ),
      loopHistory:
        (message.loopHistory?.length ?? 0) > 0
          ? message.loopHistory
          : source.loopHistory,
    };
  }));
}

function mergeWorkspaceChangeExecutions(
  messages: ChatMessage[],
  workspaceChanges: ChatToolExecution[],
) {
  if (workspaceChanges.length === 0) return messages;
  const changesByTurn = new Map<string, ChatToolExecution[]>();
  for (const execution of workspaceChanges) {
    const metadata = execution.metadata ?? {};
    const turnId = String(metadata.turn_id ?? metadata.turnId ?? '').trim();
    if (!turnId) continue;
    const current = changesByTurn.get(turnId) ?? [];
    current.push(execution);
    changesByTurn.set(turnId, current);
  }
  if (changesByTurn.size === 0) return messages;
  return messages.map((message, index) => {
    const turnId = message.turnId?.trim() ?? '';
    const changes = changesByTurn.get(turnId);
    if (!changes || message.role !== 'assistant') return message;
    const laterAssistantInTurn = messages.slice(index + 1).some(
      (candidate) => candidate.role === 'assistant'
        && (candidate.turnId?.trim() ?? '') === turnId,
    );
    if (laterAssistantInTurn) return message;
    return {
      ...message,
      toolExecutions: mergeToolExecutionLists(
        changes,
        message.toolExecutions ?? [],
      ),
    };
  });
}

function preserveLocalAssistantTimingMetadata(
  message: ChatMessage,
  source: ChatMessage,
) {
  if (message.role !== 'assistant') {
    return message.metadata;
  }
  return {
    ...(message.metadata ?? {}),
    cardbush_turn_started_at:
      message.metadata?.cardbush_turn_started_at ??
      source.metadata?.cardbush_turn_started_at ??
      source.createdAt ??
      message.createdAt,
    cardbush_turn_completed_at:
      message.metadata?.cardbush_turn_completed_at ??
      source.metadata?.cardbush_turn_completed_at,
  };
}

export function normalizeChatMessagesForDisplay(messages: ChatMessage[]) {
  const visibleMessages = messages.filter(
    (message) =>
      !isGoalSelfCheckMessage(message) && !isBackendSupersededMessage(message),
  );
  const hasIntermediateSegments = hasIntermediateAssistantSegments(visibleMessages);
  if (isStableVisibleTranscript(visibleMessages) && !hasIntermediateSegments) {
    return visibleMessages;
  }
  return dedupeVisibleTranscriptMessages(
    collapseIntermediateAssistantSegments(
      collapseLoopTranscriptMessages(visibleMessages),
    ),
  );
}

function mergePolledMessagesPreservingLocalState(
  existing: ChatMessage[],
  loaded: ChatMessage[],
) {
  if (loaded.length === 0) {
    return existing;
  }
  const hydrated = mergeLoadedMessagesPreservingLocalState(existing, loaded);
  return collapseLoopTranscriptMessages([...existing, ...hydrated]);
}

/**
 * While a turn is running, present every assistant segment as one continuous
 * transcript. Persisted/final normalization still owns the completed state;
 * this projection exists only for the active turn and therefore disappears as
 * soon as the terminal `done` event clears `sending`.
 */
export function normalizeActiveTurnTranscriptForDisplay(
  messages: ChatMessage[],
  activeTurnId: string,
) {
  const turnId = activeTurnId.trim();
  if (!turnId) {
    return messages;
  }
  const activeAssistantIndex = findLastIndex(
    messages,
    (message) =>
      message.role === 'assistant' && chatMessageTurnId(message) === turnId,
  );
  if (activeAssistantIndex < 0) {
    return messages;
  }
  const activeAssistant = messages[activeAssistantIndex];
  const siblingIndexes = messages
    .map((message, index) => ({ message, index }))
    .filter(
      ({ message, index }) =>
        index !== activeAssistantIndex &&
        message.role === 'assistant' &&
        chatMessageTurnId(message) === turnId &&
        !isGuidanceSealedAssistantSegment(message) &&
        hasVisibleLoopHistory(message),
    );
  if (siblingIndexes.length === 0) {
    return messages;
  }
  const siblingIndexSet = new Set(siblingIndexes.map(({ index }) => index));
  const siblingMessages = siblingIndexes.map(({ message }) =>
    snapshotLoopHistoryMessage(message),
  );
  const inheritedPlan = [...siblingMessages]
    .reverse()
    .find((message) => message.taskPlan)?.taskPlan;
  const mergedAssistant: ChatMessage = {
    ...activeAssistant,
    taskPlan: activeAssistant.taskPlan ?? inheritedPlan,
    loopHistory: mergeLoopHistoryMessages(
      activeAssistant.loopHistory ?? [],
      siblingMessages,
    ),
  };
  return messages.flatMap((message, index) => {
    if (siblingIndexSet.has(index)) {
      return [];
    }
    return [index === activeAssistantIndex ? mergedAssistant : message];
  });
}

function hasIntermediateAssistantSegments(messages: ChatMessage[]) {
  const finalByTurn = finalAssistantSegmentsByTurn(messages);
  return messages.some((message) => {
    const final = finalByTurn.get(turnTranscriptKey(message));
    return Boolean(final && shouldArchiveAssistantSegment(message, final));
  });
}

function collapseIntermediateAssistantSegments(messages: ChatMessage[]) {
  const finalByTurn = finalAssistantSegmentsByTurn(messages);
  if (finalByTurn.size === 0) {
    return messages;
  }
  const historyByFinalId = new Map<string, ChatMessage[]>();
  const visible: ChatMessage[] = [];
  for (const message of messages) {
    const final = finalByTurn.get(turnTranscriptKey(message));
    if (!final || !shouldArchiveAssistantSegment(message, final)) {
      visible.push(message);
      continue;
    }
    historyByFinalId.set(final.id, [
      ...(historyByFinalId.get(final.id) ?? []),
      snapshotLoopHistoryMessage(message),
    ]);
  }
  return visible.map((message) => {
    const history = historyByFinalId.get(message.id);
    if (!history?.length) {
      return message;
    }
    return {
      ...message,
      loopHistory: mergeLoopHistoryMessages(message.loopHistory ?? [], history),
    };
  });
}

function finalAssistantSegmentsByTurn(messages: ChatMessage[]) {
  const byTurn = new Map<string, ChatMessage>();
  for (const message of messages) {
    if (message.role !== 'assistant' || !isAssistantFinalTranscript(message)) {
      continue;
    }
    const turnKey = turnTranscriptKey(message);
    const current = byTurn.get(turnKey);
    if (!current || compareAssistantSegments(current, message) <= 0) {
      byTurn.set(turnKey, message);
    }
  }
  return byTurn;
}

function shouldArchiveAssistantSegment(
  message: ChatMessage,
  final: ChatMessage,
) {
  if (message.role !== 'assistant' || message.id === final.id) {
    return false;
  }
  if (turnTranscriptKey(message) !== turnTranscriptKey(final)) {
    return false;
  }
  if (isGuidanceSealedAssistantSegment(message)) {
    return false;
  }
  // Older histories do not always carry transcript_kind or
  // assistant_segment_index. Once a later final assistant message exists for
  // the same turn, every other assistant message in that turn is process
  // history. A turn-guidance boundary is different: it seals a user-visible
  // assistant reply before the queued guidance and must remain in the chat.
  return true;
}

function isGuidanceSealedAssistantSegment(message: ChatMessage) {
  const metadata = message.metadata ?? {};
  return (
    metadata.segment_boundary === 'turn_guidance' ||
    metadata.segmentBoundary === 'turn_guidance' ||
    String(
      metadata.sealed_by_client_message_id ??
        metadata.sealedByClientMessageId ??
        '',
    ).trim().length > 0
  );
}

function compareAssistantSegments(left: ChatMessage, right: ChatMessage) {
  const leftSegment = assistantSegmentIndex(left);
  const rightSegment = assistantSegmentIndex(right);
  if (leftSegment != null && rightSegment != null && leftSegment !== rightSegment) {
    return leftSegment - rightSegment;
  }
  return compareTranscriptOrder(left, right);
}

function assistantSegmentIndex(message: ChatMessage) {
  return optionalFiniteNumber(
    message.metadata?.assistant_segment_index ??
      message.metadata?.assistantSegmentIndex,
  );
}

function isStableVisibleTranscript(messages: ChatMessage[]) {
  const ids = new Set<string>();
  const persistedIds = new Set<string>();
  const positions = new Set<string>();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (isSupersededLoopAssistant(message) || ids.has(message.id)) {
      return false;
    }
    ids.add(message.id);
    const persistedId = persistedChatMessageId(message);
    if (persistedId) {
      if (persistedIds.has(persistedId)) {
        return false;
      }
      persistedIds.add(persistedId);
    }
    const content = normalizeLoopContent(message.content);
    if (content) {
      const position = [
        message.role,
        chatMessageTurnId(message),
        numericOrderValue(message.turnSequence) ?? '',
        numericOrderValue(message.messageIndex) ?? '',
        numericOrderValue(message.loopIndex) ?? '',
        content,
      ].join('\u0000');
      if (positions.has(position)) {
        return false;
      }
      positions.add(position);
    }
    if (index > 0 && compareTranscriptOrder(messages[index - 1], message) > 0) {
      return false;
    }
  }
  return true;
}

function findLocalMessageStateSource(existing: ChatMessage[], message: ChatMessage) {
  const byId = existing.find((item) => item.id === message.id);
  if (byId) {
    return byId;
  }
  const clientMessageId = chatMessageClientMessageId(message);
  if (clientMessageId) {
    const byClientMessageId = existing.find(
      (item) => chatMessageClientMessageId(item) === clientMessageId,
    );
    if (byClientMessageId) return byClientMessageId;
  }
  const turnId = message.turnId?.trim() ?? '';
  if (!turnId) {
    return undefined;
  }
  return [...existing].reverse().find((item) => {
    if (item.role !== message.role) {
      return false;
    }
    const assistantMessageId = message.assistantMessageId?.trim() ?? '';
    if (
      assistantMessageId &&
      (item.assistantMessageId?.trim() ?? item.id) === assistantMessageId
    ) {
      return true;
    }
    if ((item.turnId?.trim() ?? '') !== turnId) {
      return false;
    }
    return (
      messagesShareTranscriptPosition(item, message) ||
      (item.loopHistory?.length ?? 0) > 0 ||
      (item.toolExecutions?.length ?? 0) > 0
    );
  });
}

function messagesShareTranscriptPosition(
  left: ChatMessage,
  right: ChatMessage,
) {
  if (left.role !== right.role) {
    return false;
  }
  const leftTurn = chatMessageTurnId(left);
  const rightTurn = chatMessageTurnId(right);
  if (!leftTurn || leftTurn !== rightTurn) {
    return false;
  }
  const leftMessageIndex = numericOrderValue(left.messageIndex);
  const rightMessageIndex = numericOrderValue(right.messageIndex);
  if (leftMessageIndex != null && rightMessageIndex != null) {
    return leftMessageIndex === rightMessageIndex;
  }
  const leftTurnSequence = numericOrderValue(left.turnSequence);
  const rightTurnSequence = numericOrderValue(right.turnSequence);
  if (
    leftTurnSequence != null &&
    rightTurnSequence != null &&
    leftTurnSequence !== rightTurnSequence
  ) {
    return false;
  }
  return normalizeLoopContent(left.content) === normalizeLoopContent(right.content);
}

function collectLoopHistoryFromReplaced(
  replacedMessages: ChatMessage[],
  finalMessages: ChatMessage[],
  temporaryIds: Set<string>,
) {
  const finalIds = new Set(finalMessages.map((message) => message.id));
  const finalAssistant = finalMessages[findLastIndex(
    finalMessages,
    (message) => message.role === 'assistant',
  )];
  const replacedAssistants = replacedMessages
    .filter((message) => message.role === 'assistant')
    .filter((message) => !finalIds.has(message.id))
    .filter(
      (message) =>
        !isGuidanceSealedAssistantSegment(message) ||
        !finalMessages.some(
          (candidate) =>
            candidate.role === 'assistant' &&
            isGuidanceSealedAssistantSegment(candidate) &&
            turnTranscriptKey(candidate) === turnTranscriptKey(message) &&
            (
              messageIdentityMatches(candidate, message) ||
              (
                assistantSegmentIndex(candidate) != null &&
                assistantSegmentIndex(candidate) === assistantSegmentIndex(message)
              )
            ),
        ),
    );
  const candidates = replacedAssistants.flatMap((message) => [
    ...(message.loopHistory ?? []),
    ...(
      hasVisibleLoopHistory(message) &&
      !isTemporaryAssistantCoveredByBackendTranscript(
        message,
        finalMessages,
        temporaryIds,
      ) &&
      !isRedundantTemporaryAssistant(message, finalAssistant, temporaryIds)
        ? [message]
        : []
    ),
  ]);
  return mergeLoopHistoryMessages([], candidates);
}

function isTemporaryAssistantCoveredByBackendTranscript(
  message: ChatMessage,
  finalMessages: ChatMessage[],
  temporaryIds: Set<string>,
) {
  if (!temporaryIds.has(message.id)) {
    return false;
  }
  const turnKey = turnTranscriptKey(message);
  return finalMessages.some((candidate) => {
    if (candidate.role !== 'assistant' || turnTranscriptKey(candidate) !== turnKey) {
      return false;
    }
    if (backendLoopMessageMatchesTemporary(candidate, message, temporaryIds)) {
      return true;
    }
    return (candidate.loopHistory ?? []).some(
      (item) => backendLoopMessageMatchesTemporary(item, message, temporaryIds),
    );
  });
}

function backendLoopMessageMatchesTemporary(
  candidate: ChatMessage,
  temporary: ChatMessage,
  temporaryIds: Set<string>,
) {
  if (
    temporaryIds.has(candidate.id) ||
    !isSupersededLoopAssistant(candidate) ||
    turnTranscriptKey(candidate) !== turnTranscriptKey(temporary)
  ) {
    return false;
  }
  if (messageIdentityMatches(candidate, temporary)) {
    return true;
  }
  const candidateSegment = optionalFiniteNumber(
    candidate.metadata?.assistant_segment_index,
  );
  const temporarySegment = optionalFiniteNumber(
    temporary.metadata?.assistant_segment_index,
  );
  if (candidateSegment != null && temporarySegment != null) {
    return candidateSegment === temporarySegment;
  }
  const candidateLoop = numericOrderValue(candidate.loopIndex);
  const temporaryLoop = numericOrderValue(temporary.loopIndex);
  if (candidateLoop != null && temporaryLoop != null) {
    return candidateLoop === temporaryLoop;
  }
  const candidateContent = normalizeLoopContent(candidate.content);
  return Boolean(
    candidateContent &&
    candidateContent === normalizeLoopContent(temporary.content),
  );
}

function attachLoopHistoryToFinalAssistant(
  messages: ChatMessage[],
  loopHistory: ChatMessage[],
) {
  const targetIndex = findLastIndex(
    messages,
    (message) => message.role === 'assistant',
  );
  if (targetIndex < 0) {
    return;
  }
  const target = messages[targetIndex];
  messages[targetIndex] = {
    ...target,
    loopHistory: mergeLoopHistoryMessages(target.loopHistory ?? [], loopHistory),
  };
}

function collapseLoopTranscriptMessages(messages: ChatMessage[]) {
  if (messages.length === 0) {
    return messages;
  }
  const sorted = sortMessagesByTranscriptOrder(messages);
  const loopHistoryByTurn = new Map<string, ChatMessage[]>();
  const visible: ChatMessage[] = [];
  for (const message of sorted) {
    // The backend keeps edit/rerun branches for audit when
    // include_superseded=true. They are not assistant loop segments and must
    // never fall back into the visible transcript just because the replacement
    // response belongs to a newly generated turn. Guidance segments are not
    // marked with this persistence flag and continue through the normal
    // turn-guidance projection below.
    if (isBackendSupersededMessage(message)) {
      continue;
    }
    if (isSupersededLoopAssistant(message)) {
      const key = turnTranscriptKey(message);
      loopHistoryByTurn.set(key, [
        ...(loopHistoryByTurn.get(key) ?? []),
        snapshotLoopHistoryMessage(message),
      ]);
      continue;
    }
    visible.push(message);
  }
  for (const [turnKey, loopHistory] of loopHistoryByTurn) {
    const targetIndex = findLastIndex(
      visible,
      (message) =>
        message.role === 'assistant' &&
        turnTranscriptKey(message) === turnKey &&
        !isSupersededLoopAssistant(message),
    );
    if (targetIndex < 0) {
      visible.push(...loopHistory);
      continue;
    }
    const target = visible[targetIndex];
    visible[targetIndex] = {
      ...target,
      loopHistory: mergeLoopHistoryMessages(target.loopHistory ?? [], loopHistory),
    };
  }
  return sortMessagesByTranscriptOrder(dedupeVisibleTranscriptMessages(visible));
}

function isBackendSupersededMessage(message: ChatMessage) {
  const metadata = message.metadata ?? {};
  return (
    metadata.__bush_superseded === true ||
    metadata.superseded === true ||
    metadata.is_superseded === true ||
    metadata.isSuperseded === true
  );
}

function dedupeVisibleTranscriptMessages(messages: ChatMessage[]) {
  const deduped: ChatMessage[] = [];
  for (const message of messages) {
    const existingIndex = deduped.findIndex((candidate) =>
      shouldCollapseDuplicateTranscriptMessage(candidate, message),
    );
    if (existingIndex < 0) {
      deduped.push(message);
      continue;
    }
    deduped[existingIndex] = mergeDuplicateTranscriptMessage(
      deduped[existingIndex],
      message,
    );
  }
  return deduped;
}

function shouldCollapseDuplicateTranscriptMessage(
  left: ChatMessage,
  right: ChatMessage,
) {
  if (left.id === right.id) {
    return true;
  }
  const leftClientMessageId = chatMessageClientMessageId(left);
  const rightClientMessageId = chatMessageClientMessageId(right);
  if (
    leftClientMessageId &&
    rightClientMessageId &&
    leftClientMessageId === rightClientMessageId
  ) {
    return true;
  }
  const leftPersistedId = persistedChatMessageId(left);
  const rightPersistedId = persistedChatMessageId(right);
  if (leftPersistedId && rightPersistedId && leftPersistedId === rightPersistedId) {
    return true;
  }
  if (left.role !== right.role) {
    return false;
  }
  const leftTurn = chatMessageTurnId(left);
  const rightTurn = chatMessageTurnId(right);
  if (!leftTurn || leftTurn !== rightTurn) {
    return false;
  }
  if (!transcriptOrderCompatible(left, right)) {
    return false;
  }
  const leftContent = normalizeLoopContent(left.content);
  const rightContent = normalizeLoopContent(right.content);
  return Boolean(leftContent && leftContent === rightContent);
}

function transcriptOrderCompatible(left: ChatMessage, right: ChatMessage) {
  const leftTurnSequence = numericOrderValue(left.turnSequence);
  const rightTurnSequence = numericOrderValue(right.turnSequence);
  if (
    leftTurnSequence != null &&
    rightTurnSequence != null &&
    leftTurnSequence !== rightTurnSequence
  ) {
    return false;
  }
  const leftMessageIndex = numericOrderValue(left.messageIndex);
  const rightMessageIndex = numericOrderValue(right.messageIndex);
  if (
    leftMessageIndex != null &&
    rightMessageIndex != null &&
    leftMessageIndex !== rightMessageIndex
  ) {
    return false;
  }
  const leftLoopIndex = numericOrderValue(left.loopIndex);
  const rightLoopIndex = numericOrderValue(right.loopIndex);
  if (
    leftLoopIndex != null &&
    rightLoopIndex != null &&
    leftLoopIndex !== rightLoopIndex
  ) {
    return false;
  }
  return true;
}

function mergeDuplicateTranscriptMessage(left: ChatMessage, right: ChatMessage) {
  const primary = transcriptMessagePriority(right) >= transcriptMessagePriority(left)
    ? right
    : left;
  const fallback = primary === right ? left : right;
  const toolExecutions = mergeToolExecutionLists(
    primary.toolExecutions ?? [],
    fallback.toolExecutions ?? [],
  );
  const loopHistory = mergeLoopHistoryMessages(
    primary.loopHistory ?? [],
    fallback.loopHistory ?? [],
  );
  return {
    ...fallback,
    ...primary,
    messageId: primary.messageId ?? fallback.messageId,
    clientMessageId: primary.clientMessageId ?? fallback.clientMessageId,
    assistantMessageId: primary.assistantMessageId ?? fallback.assistantMessageId,
    createdAt: primary.createdAt ?? fallback.createdAt,
    metadata: {
      ...(fallback.metadata ?? {}),
      ...(primary.metadata ?? {}),
    },
    taskPlan: primary.taskPlan ?? fallback.taskPlan,
    toolExecutions: toolExecutions.length > 0 ? toolExecutions : undefined,
    loopHistory: loopHistory.length > 0 ? loopHistory : undefined,
  };
}

function transcriptMessagePriority(message: ChatMessage) {
  let score = 0;
  if (persistedChatMessageId(message)) {
    score += 8;
  }
  if (message.messageId?.trim()) {
    score += 4;
  }
  if (message.role === 'assistant' && isAssistantFinalTranscript(message)) {
    score += 2;
  }
  if (message.createdAt?.trim()) {
    score += 1;
  }
  return score;
}

function sortMessagesByTranscriptOrder(messages: ChatMessage[]) {
  return messages
    .map((message, index) => ({ message, index }))
    .sort((left, right) => {
      return compareTranscriptOrder(left.message, right.message) || left.index - right.index;
    })
    .map((item) => item.message);
}

function compareTranscriptOrder(left: ChatMessage, right: ChatMessage) {
  const turnDelta = compareOptionalOrder(
    numericOrderValue(left.turnSequence),
    numericOrderValue(right.turnSequence),
  );
  if (turnDelta !== 0) {
    return turnDelta;
  }
  const sameTurn = turnTranscriptKey(left) === turnTranscriptKey(right);
  const indexDelta = sameTurn
    ? compareOptionalOrder(
        numericOrderValue(left.messageIndex),
        numericOrderValue(right.messageIndex),
      )
    : 0;
  if (indexDelta !== 0) {
    return indexDelta;
  }
  const loopDelta = sameTurn
    ? compareOptionalOrder(
        numericOrderValue(left.loopIndex),
        numericOrderValue(right.loopIndex),
      )
    : 0;
  if (loopDelta !== 0) {
    return loopDelta;
  }
  const sequenceDelta = compareOptionalOrder(
    numericOrderValue(left.sequence),
    numericOrderValue(right.sequence),
  );
  if (sequenceDelta !== 0) {
    return sequenceDelta;
  }
  return compareOptionalOrder(
    dateOrderValue(left.createdAt),
    dateOrderValue(right.createdAt),
  );
}

function compareOptionalOrder(left: number | undefined, right: number | undefined) {
  if (left == null || right == null) {
    return 0;
  }
  return left - right;
}

function dateOrderValue(value: string | undefined) {
  if (!value) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function numericOrderValue(value: number | undefined) {
  return Number.isFinite(value) ? Number(value) : undefined;
}

function persistedChatMessageId(message: ChatMessage | undefined) {
  if (!message) {
    return '';
  }
  const explicitId = message.messageId?.trim() ?? '';
  if (isPersistedChatMessageId(explicitId)) {
    return explicitId;
  }
  const ownId = message.id.trim();
  if (isPersistedChatMessageId(ownId)) {
    return ownId;
  }
  const metadata = message.metadata ?? {};
  for (const value of [
    metadata.message_id,
    metadata.messageId,
    metadata.chat_message_id,
    metadata.chatMessageId,
  ]) {
    const candidate = String(value ?? '').trim();
    if (isPersistedChatMessageId(candidate)) {
      return candidate;
    }
  }
  return '';
}

function isPersistedChatMessageId(value: string) {
  const normalized = value.trim();
  return (
    /^msg:\S+$/.test(normalized) ||
    /^msg-[\w-]+$/.test(normalized) ||
    /^msg_[\w-]+$/.test(normalized) ||
    /^\d+$/.test(normalized)
  );
}

function findPersistedEditableUserMessage(
  source: ChatMessage,
  candidates: ChatMessage[],
) {
  if (source.role !== 'user') {
    return undefined;
  }
  const sourceId = persistedChatMessageId(source);
  if (sourceId) {
    return source.id === sourceId ? source : { ...source, id: sourceId };
  }
  const persistedCandidates = candidates.filter(
    (candidate) => candidate.role === 'user' && persistedChatMessageId(candidate),
  );
  const sourceTurnId = chatMessageTurnId(source);
  if (sourceTurnId) {
    const turnMatch = persistedCandidates.find(
      (candidate) => chatMessageTurnId(candidate) === sourceTurnId,
    );
    if (turnMatch) {
      return turnMatch;
    }
  }
  const sourceTurnSequence = numericOrderValue(source.turnSequence);
  const sourceMessageIndex = numericOrderValue(source.messageIndex);
  if (sourceTurnSequence != null && sourceMessageIndex != null) {
    const orderMatch = persistedCandidates.find(
      (candidate) =>
        numericOrderValue(candidate.turnSequence) === sourceTurnSequence &&
        numericOrderValue(candidate.messageIndex) === sourceMessageIndex,
    );
    if (orderMatch) {
      return orderMatch;
    }
  }
  const sourceContent = normalizeEditableUserContent(source.content);
  if (!sourceContent) {
    return undefined;
  }
  const contentMatches = persistedCandidates.filter(
    (candidate) => normalizeEditableUserContent(candidate.content) === sourceContent,
  );
  return contentMatches.length === 1 ? contentMatches[0] : undefined;
}

function findUserMessageForAssistantRegenerate(
  source: ChatMessage,
  candidates: ChatMessage[],
) {
  const persistedCandidates = candidates.filter(
    (candidate) => candidate.role === 'user' && persistedChatMessageId(candidate),
  );
  const sourceTurnId = chatMessageTurnId(source);
  if (sourceTurnId) {
    const turnMatch = [...persistedCandidates]
      .reverse()
      .find((candidate) => chatMessageTurnId(candidate) === sourceTurnId);
    if (turnMatch) {
      return turnMatch;
    }
  }
  const sourceIndex = candidates.findIndex((candidate) =>
    messageIdentityMatches(candidate, source),
  );
  const previousMessages =
    sourceIndex >= 0 ? candidates.slice(0, sourceIndex) : candidates;
  return [...previousMessages]
    .reverse()
    .find((candidate) => candidate.role === 'user' && persistedChatMessageId(candidate));
}

function messageIdentityMatches(left: ChatMessage, right: ChatMessage) {
  if (left.id === right.id) {
    return true;
  }
  const leftId = persistedChatMessageId(left);
  const rightId = persistedChatMessageId(right);
  if (leftId && rightId && leftId === rightId) {
    return true;
  }
  const leftTurn = chatMessageTurnId(left);
  const rightTurn = chatMessageTurnId(right);
  if (!leftTurn || leftTurn !== rightTurn) {
    return false;
  }
  const leftMessageIndex = numericOrderValue(left.messageIndex);
  const rightMessageIndex = numericOrderValue(right.messageIndex);
  return (
    leftMessageIndex != null &&
    rightMessageIndex != null &&
    leftMessageIndex === rightMessageIndex
  );
}

function chatMessageTurnId(message: ChatMessage) {
  return String(
    message.turnId ??
      message.metadata?.turn_id ??
      message.metadata?.turnId ??
      '',
  ).trim();
}

function chatMessageClientMessageId(message: ChatMessage) {
  return String(
    message.clientMessageId ??
      message.metadata?.client_message_id ??
      message.metadata?.clientMessageId ??
      '',
  ).trim();
}

function normalizeEditableUserContent(value: string) {
  return value.trim().replace(/\r\n/g, '\n');
}

function uniqueMessageIds(values: string[]) {
  return Array.from(
    new Set(values.map((value) => value.trim()).filter(Boolean)),
  );
}

function turnTranscriptKey(message: ChatMessage) {
  const turnId = message.turnId?.trim();
  if (turnId) {
    return `turn:${turnId}`;
  }
  const metadataTurnId = String(
    message.metadata?.turn_id ?? message.metadata?.turnId ?? '',
  ).trim();
  if (metadataTurnId) {
    return `turn:${metadataTurnId}`;
  }
  const assistantMessageId = message.assistantMessageId?.trim();
  if (assistantMessageId) {
    return `assistant:${assistantMessageId}`;
  }
  return `message:${message.id}`;
}

function isSupersededLoopAssistant(message: ChatMessage) {
  const status = String(message.status ?? message.metadata?.status ?? '')
    .trim()
    .toLowerCase();
  const transcriptKind = assistantTranscriptKind(message);
  const historyVisibility = String(
    message.metadata?.history_visibility ?? message.metadata?.historyVisibility ?? '',
  )
    .trim()
    .toLowerCase();
  return (
    message.role === 'assistant' &&
    (
      transcriptKind === 'assistant_loop' ||
      (transcriptKind === 'assistant_segment' && historyVisibility === 'ephemeral') ||
      (status === 'superseded' && !transcriptKind)
    )
  );
}

function isAssistantFinalTranscript(message: ChatMessage) {
  if (message.role !== 'assistant') {
    return false;
  }
  const status = String(message.status ?? message.metadata?.status ?? '')
    .trim()
    .toLowerCase();
  const transcriptKind = assistantTranscriptKind(message);
  return (
    status === 'complete' ||
    transcriptKind === 'assistant_final' ||
    (!status && !transcriptKind)
  );
}

function assistantTranscriptKind(message: ChatMessage) {
  return String(
    message.metadata?.transcript_kind ??
      message.metadata?.transcriptKind ??
      '',
  )
    .trim()
    .toLowerCase();
}

function mergeLoopHistoryMessages(
  existing: ChatMessage[],
  incoming: ChatMessage[],
) {
  const byKey = new Map<string, ChatMessage>();
  for (const message of flattenLoopHistoryMessages([...existing, ...incoming])) {
    if (!hasVisibleLoopHistory(message)) {
      continue;
    }
    byKey.set(loopHistoryMessageKey(message), snapshotLoopHistoryMessage(message));
  }
  return sortMessagesByTranscriptOrder(Array.from(byKey.values()));
}

function flattenLoopHistoryMessages(messages: ChatMessage[]) {
  const flattened: ChatMessage[] = [];
  const visiting = new Set<ChatMessage>();
  const visit = (message: ChatMessage) => {
    if (visiting.has(message)) return;
    visiting.add(message);
    for (const nested of message.loopHistory ?? []) {
      visit(nested);
    }
    flattened.push(message);
    visiting.delete(message);
  };
  for (const message of messages) visit(message);
  return flattened;
}

function snapshotLoopHistoryMessage(message: ChatMessage): ChatMessage {
  return {
    id: message.id,
    messageId: message.messageId,
    role: message.role,
    content: message.content,
    conversationId: message.conversationId,
    turnId: message.turnId,
    createdAt: message.createdAt,
    status: message.status,
    loopIndex: message.loopIndex,
    turnSequence: message.turnSequence,
    messageIndex: message.messageIndex,
    sequence: message.sequence,
    requestId: message.requestId,
    eventId: message.eventId,
    assistantMessageId: message.assistantMessageId,
    attachments: message.attachments?.map((attachment) => ({ ...attachment })),
    toolExecutions: message.toolExecutions?.map((execution) => ({
      ...execution,
      metadata: { ...execution.metadata },
    })),
    taskPlan: message.taskPlan,
    metadata: message.metadata ? { ...message.metadata } : undefined,
  };
}

function hasVisibleLoopHistory(message: ChatMessage) {
  return Boolean(
    message.content.trim() ||
      (message.attachments?.length ?? 0) > 0 ||
      (message.toolExecutions?.length ?? 0) > 0,
  );
}

function shouldPreserveExistingAsLoopHistory(
  existing: ChatMessage,
  incoming: ChatMessage,
) {
  if (existing.role !== 'assistant' || incoming.role !== 'assistant') {
    return false;
  }
  if (!hasVisibleLoopHistory(existing)) {
    return false;
  }
  return normalizeLoopContent(existing.content) !== normalizeLoopContent(incoming.content);
}

function isRedundantTemporaryAssistant(
  message: ChatMessage,
  finalAssistant: ChatMessage | undefined,
  temporaryIds: Set<string>,
) {
  if (!finalAssistant || !temporaryIds.has(message.id)) {
    return false;
  }
  return normalizeLoopContent(message.content) === normalizeLoopContent(finalAssistant.content);
}

function normalizeLoopContent(content: string) {
  return content.trim().replace(/\s+/g, ' ');
}

function loopHistoryMessageKey(message: ChatMessage) {
  return [
    message.id.trim(),
    message.role,
    message.turnId?.trim() ?? '',
    message.assistantMessageId?.trim() ?? '',
    message.status?.trim() ?? '',
    message.loopIndex ?? '',
    message.turnSequence ?? '',
    message.messageIndex ?? '',
    message.createdAt?.trim() ?? '',
    normalizeLoopContent(message.content),
    message.toolExecutions
      ?.map((execution) =>
        [
          execution.id,
          execution.state,
          normalizeLoopContent(execution.summary),
          normalizeLoopContent(execution.output),
        ].join(':'),
      )
      .join(',') ?? '',
  ].join('|');
}

function findStreamReplacementSource(
  existing: ChatMessage[],
  incoming: ChatMessage,
  {
    targetTurnId,
    temporaryIds,
  }: {
    targetTurnId: string;
    temporaryIds: Set<string>;
  },
) {
  const incomingTurnId = incoming.turnId?.trim() || targetTurnId;
  if (!incomingTurnId) {
    return undefined;
  }
  const candidates = existing.filter((message) => {
    if (message.role !== incoming.role) {
      return false;
    }
    const messageTurnId = message.turnId?.trim() ?? '';
    return messageTurnId === incomingTurnId || temporaryIds.has(message.id);
  });
  return (
    candidates.find((message) => temporaryIds.has(message.id)) ??
    candidates.at(-1)
  );
}

function findLastIndex<T>(values: T[], predicate: (value: T) => boolean) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index])) {
      return index;
    }
  }
  return -1;
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
    lower.startsWith('weixin:') ||
    lower.startsWith('feishu:') ||
    lower.startsWith('telegram:') ||
    lower.startsWith('discord:') ||
    lower.includes('@im.bot') ||
    lower.includes('@im.wechat') ||
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

function chatAttachmentsFromOutbound(
  outbound: ReturnType<typeof splitStreamAttachmentMentions>,
): ChatAttachment[] {
  return [
    ...outbound.images.map((image) => ({
      id: `attachment-${crypto.randomUUID()}`,
      name: basename(image.path),
      path: image.path,
      type: 'image' as const,
    })),
    ...outbound.files.map((pathValue) => ({
      id: `attachment-${crypto.randomUUID()}`,
      name: basename(pathValue),
      path: pathValue,
      type: 'document' as const,
    })),
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

function localConversation(projectDir?: string, initialTitle?: string): ConversationSummary {
  const id = `local-${crypto.randomUUID()}`;
  return {
    id,
    title: initialTitle?.trim() || '新会话',
    preview: '',
    updatedAt: new Date().toISOString(),
    projectDir,
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

function isRunningSessionTurn(turn: SessionLatestTurn) {
  return ['queued', 'pending', 'running', 'active', 'streaming'].includes(
    turn.status.trim().toLowerCase(),
  );
}

function goalPollingDelayMs() {
  return document.visibilityState === 'hidden' ? 7_000 : 2_000;
}

function isNotFoundLikeError(error: unknown) {
  return /(^|\\s)(404|not found)(\\s|:|$)/i.test(errorMessage(error));
}

function isInteractionGoneError(error: unknown) {
  return /BushServer error (404|410)\b|\b(404|410)\b.*(not found|gone)/i.test(
    errorMessage(error),
  );
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
  return /failed to fetch|networkerror|load failed|fetch failed|\bterminated\b|econnreset|socket hang up|incomplete chunked encoding|sse connection closed/i.test(
    rawErrorMessage(error),
  );
}

function errorMessage(error: unknown) {
  const message = rawErrorMessage(error);
  const english =
    typeof document !== 'undefined' &&
    document.documentElement.lang.toLowerCase().startsWith('en');
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return english
      ? 'Unable to connect to BushServer. Check that the backend is running.'
      : '无法连接 BushServer，请检查后端是否正在运行。';
  }
  return message;
}
