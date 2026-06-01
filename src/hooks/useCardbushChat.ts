import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  cancelInteraction,
  createConversation,
  createSessionShareLink as createSessionShareLinkApi,
  deleteConversationApi,
  editMessage,
  fetchConversations,
  fetchMessages,
  fetchPendingInteraction,
  fetchRuntimeProfiles,
  fetchSkillDetail,
  fetchSkills,
  fetchSessionMessages,
  regenerateTurn,
  replyInteraction,
  sendGuidance,
  stopTurn,
  streamChat,
  updateConversation,
} from '../backend/api';
import type {
  AssistantRevision,
  ChatMessage,
  ConversationSummary,
  ManagedModelConfig,
  RuntimeProfileSummary,
  SkillDetail,
  SkillSummary,
  ChatToolExecution,
  PendingInteraction,
  InteractionReplyAnswer,
  ReferencePlanMode,
} from '../types';

export type QueuedChatMessage = {
  id: string;
  text: string;
  conversation?: ConversationSummary;
  createdAt: string;
};

export function useCardbushChat(
  managedModelConfigs: ManagedModelConfig[] = [],
  availableModels: string[] = [],
  requestContext: {
    projectContexts?: Record<string, string>;
    disabledSkillNames?: Set<string>;
  } = {},
) {
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
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingInteraction, setPendingInteraction] =
    useState<PendingInteraction | null>(null);
  const [selectedModel, setSelectedModelState] = useState(() =>
    readInitialSelectedModel(availableModels),
  );
  const [runtimeProfiles, setRuntimeProfiles] = useState<RuntimeProfileSummary[]>(
    defaultRuntimeProfiles,
  );
  const [selectedRuntimeProfile, setSelectedRuntimeProfileState] = useState(
    readInitialRuntimeProfile,
  );
  const [referencePlanMode, setReferencePlanModeState] = useState<ReferencePlanMode>(
    readInitialReferencePlanMode,
  );
  const controllersRef = useRef<Record<string, AbortController>>({});
  const activeTurnIdsRef = useRef<Record<string, string>>({});
  const sendingSessionsRef = useRef<Set<string>>(new Set());
  const queuedMessagesRef = useRef<QueuedChatMessage[]>([]);
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

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [loadedConversations, loadedSkills, loadedRuntimeProfiles] = await Promise.all([
          fetchConversations(),
          fetchSkills().catch(() => []),
          fetchRuntimeProfiles().catch(() => defaultRuntimeProfiles),
        ]);
        if (cancelled) {
          return;
        }
        setConversations(loadedConversations);
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
        setRuntimeProfiles(mergeRuntimeProfiles(loadedRuntimeProfiles));
        setError(null);
      } catch (caught) {
        if (!cancelled) {
          setConversations([]);
          setActiveConversationId('');
          setMessagesByConversation({});
          setSkills([]);
          setRuntimeProfiles(defaultRuntimeProfiles);
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
      if (availableModels.some((model) => model === current)) {
        return current;
      }
      const next = availableModels[0] ?? '';
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

  const setSelectedRuntimeProfile = useCallback(
    (profileId: string, conversationId = activeConversationId) => {
      const normalized = normalizeRuntimeProfileId(profileId);
      setSelectedRuntimeProfileState(normalized);
      window.localStorage.setItem('cardbush.runtime_profile', normalized);
      const targetConversationId = conversationId.trim();
      if (!targetConversationId) {
        return;
      }
      setConversations((current) =>
        current.map((item) =>
          item.id === targetConversationId ? { ...item, agentProfile: normalized } : item,
        ),
      );
      void updateConversation({
        sessionId: targetConversationId,
        agentProfile: normalized,
      }).catch((caught) => setError(errorMessage(caught)));
    },
    [activeConversationId],
  );

  const setReferencePlanMode = useCallback((mode: ReferencePlanMode) => {
    const normalized = normalizeReferencePlanMode(mode);
    setReferencePlanModeState(normalized);
    window.localStorage.setItem('cardbush.reference_plan_mode', normalized);
  }, []);

  useEffect(() => {
    if (!activeConversationId || messagesByConversation[activeConversationId]) {
      return;
    }
    let cancelled = false;
    async function loadMessages() {
      setMessagesLoading(true);
      try {
        const result = await fetchSessionMessages(activeConversationId);
        if (!cancelled) {
          setMessagesByConversation((current) => ({
            ...current,
            [activeConversationId]: mergeLoadedMessagesPreservingLocalState(
              current[activeConversationId] ?? [],
              result.messages,
            ),
          }));
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
  }, [activeConversationId, messagesByConversation]);

  const activeConversation = useMemo(
    () =>
      conversations.find((item) => item.id === activeConversationId) ??
      conversations[0],
    [activeConversationId, conversations],
  );
  const activeRuntimeProfile =
    activeConversation?.agentProfile?.trim() || selectedRuntimeProfile;

  const activeMessages = activeConversationId
    ? messagesByConversation[activeConversationId] ?? []
    : [];

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
    setConversations(loadedConversations);
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

  const refreshActiveSession = useCallback(async (options?: { silent?: boolean }) => {
    const sessionId = activeConversationId.trim();
    if (!sessionId) {
      return;
    }
    if (!options?.silent) {
      setMessagesLoading(true);
    }
    try {
      const result = await fetchSessionMessages(sessionId);
      setMessagesByConversation((current) => ({
        ...current,
        [sessionId]: mergeLoadedMessagesPreservingLocalState(
          current[sessionId] ?? [],
          result.messages,
        ),
      }));
      await reloadConversations().catch(() => undefined);
      if (!options?.silent) {
        setError(null);
      }
    } catch (caught) {
      if (!options?.silent) {
        setError(errorMessage(caught));
      }
      throw caught;
    } finally {
      if (!options?.silent) {
        setMessagesLoading(false);
      }
    }
  }, [activeConversationId, reloadConversations]);

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

  const startConversation = useCallback(async (projectDir?: string) => {
    try {
      const created = await createConversation({
        projectDir,
        agentProfile: selectedRuntimeProfile,
      });
      const nextCreated = projectDir
        ? {
            ...created,
            agentProfile: created.agentProfile ?? selectedRuntimeProfile,
            projectDir: created.projectDir ?? projectDir,
          }
        : { ...created, agentProfile: created.agentProfile ?? selectedRuntimeProfile };
      setConversations((current) => [nextCreated, ...current]);
      setMessagesByConversation((current) => ({
        ...current,
        [nextCreated.id]: [],
      }));
      setActiveConversationId(nextCreated.id);
      setError(null);
      return nextCreated;
    } catch (caught) {
      setError(errorMessage(caught));
      const created = {
        ...localConversation(projectDir),
        agentProfile: selectedRuntimeProfile,
      };
      setConversations((current) => [created, ...current]);
      setMessagesByConversation((current) => ({
        ...current,
        [created.id]: [],
      }));
      setActiveConversationId(created.id);
      return created;
    }
  }, [selectedRuntimeProfile]);

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

  const sendMessage = useCallback(
    async (text: string, queuedConversation?: ConversationSummary) => {
      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }
      const outbound = splitStreamAttachmentMentions(trimmed);
      const conversation =
        queuedConversation ?? activeConversation ?? (await startConversation());
      const sessionId = conversation.id;
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
      const projectUserPrompt = projectDir
        ? requestContext.projectContexts?.[projectKey(projectDir)]?.trim()
        : '';
      if (!selectedModel.trim()) {
        setError('请先在设置中配置模型');
        return;
      }
      const userMessage: ChatMessage = {
        id: `user-${crypto.randomUUID()}`,
        role: 'user',
        content: trimmed,
        conversationId: sessionId,
        createdAt: new Date().toISOString(),
      };
      const assistantId = `assistant-${crypto.randomUUID()}`;
      const assistantMessage: ChatMessage = {
        id: assistantId,
        role: 'assistant',
        content: '',
        conversationId: sessionId,
        createdAt: new Date().toISOString(),
      };

      setMessagesByConversation((current) => ({
        ...current,
        [sessionId]: [...(current[sessionId] ?? []), userMessage, assistantMessage],
      }));
      setConversations((current) =>
        upsertConversationPreview(current, conversation, trimmed),
      );
      markSessionRunning(sessionId);
      setError(null);
      const controller = new AbortController();
      const streamBuffer = createAssistantStreamDeltaBuffer((delta) => {
        setMessagesByConversation((current) =>
          appendAssistantDelta(current, sessionId, assistantId, delta),
        );
      });
      controllersRef.current[sessionId] = controller;
      let finalSnapshotPromise: Promise<void> | null = null;

      try {
        await streamChat({
          sessionId,
          userInput: outbound.userInput,
          model: selectedModel,
          modelConfig: modelConfigFor(managedModelConfigs, selectedModel),
          agentProfile: conversation.agentProfile ?? selectedRuntimeProfile,
          projectDir,
          projectUserPrompt,
          allowedSkills: skills
            .map((skill) => skill.name)
            .filter((name) => !requestContext.disabledSkillNames?.has(name)),
          referencePlanMode,
          images: outbound.images,
          files: outbound.files,
          signal: controller.signal,
          onStart: (start) => {
            markSessionRunning(sessionId, start.turnId);
            setMessagesByConversation((current) =>
              assignTurnToLocalMessages(current, sessionId, start.turnId, [
                userMessage.id,
                assistantId,
              ]),
            );
          },
          onDelta: (delta) => {
            streamBuffer.push(delta);
          },
          onAssistantRevision: (revision) => {
            streamBuffer.reset(revision.content ?? '');
            setMessagesByConversation((current) =>
              applyAssistantRevision(current, sessionId, assistantId, revision),
            );
          },
          onToolExecution: (execution) => {
            void streamBuffer.flushAllStreaming().then(() => {
              setMessagesByConversation((current) =>
                appendToolExecution(current, sessionId, assistantId, execution),
              );
            });
          },
          onInteractiveRequest: (interaction) => {
            setPendingInteraction({
              ...interaction,
              sessionId: interaction.sessionId ?? sessionId,
            });
          },
          onMessages: (nextMessages, finalSnapshot) => {
            if (finalSnapshot) {
              const turnId = activeTurnIdsRef.current[sessionId];
              const finalContent = finalAssistantContentForStream(nextMessages, turnId);
              finalSnapshotPromise = streamBuffer.flushFinalText(finalContent).then(() => {
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
        });
        if (finalSnapshotPromise) {
          await finalSnapshotPromise;
        }
        void reloadConversations().catch(() => undefined);
      } catch (caught) {
        if (!controller.signal.aborted) {
          setError(errorMessage(caught));
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
      clearSessionRunning,
      dequeueMessageForConversation,
      enqueueMessage,
      isSessionSending,
      markSessionRunning,
      reloadConversations,
      managedModelConfigs,
      requestContext.disabledSkillNames,
      requestContext.projectContexts,
      referencePlanMode,
      selectedModel,
      selectedRuntimeProfile,
      skills,
      startConversation,
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
          onStart: (start: { sessionId: string; turnId: string }) => void;
          onDelta: (delta: string) => void;
          onAssistantRevision: (revision: AssistantRevision) => void;
          onToolExecution: (execution: ChatToolExecution) => void;
          onInteractiveRequest: (interaction: PendingInteraction) => void;
          onMessages: (messages: ChatMessage[], finalSnapshot: boolean) => void;
        },
      ) => Promise<void>;
    }) => {
      const sessionId = conversation.id;
      const controller = new AbortController();
      let finalSnapshot: ChatMessage[] | null = null;
      const streamBuffer = createAssistantStreamDeltaBuffer((delta) => {
        setMessagesByConversation((current) =>
          appendAssistantDelta(current, sessionId, tempAssistant.id, delta),
        );
      });
      const startIds = new Set(startedMessageIds ?? [tempAssistant.id]);
      const replacementIds = temporaryMessageIds ?? [tempAssistant.id];
      let finalSnapshotPromise: Promise<void> | null = null;
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
            markSessionRunning(sessionId, start.turnId);
            setMessagesByConversation((current) => ({
              ...current,
              [sessionId]: (current[sessionId] ?? initialMessages).map((item) =>
                startIds.has(item.id)
                  ? { ...item, turnId: start.turnId, conversationId: sessionId }
                  : item,
              ),
            }));
          },
          onDelta: (delta) => {
            streamBuffer.push(delta);
          },
          onAssistantRevision: (revision) => {
            streamBuffer.reset(revision.content ?? '');
            setMessagesByConversation((current) =>
              applyAssistantRevision(current, sessionId, tempAssistant.id, revision),
            );
          },
          onToolExecution: (execution) => {
            void streamBuffer.flushAllStreaming().then(() => {
              setMessagesByConversation((current) =>
                appendToolExecution(current, sessionId, tempAssistant.id, execution),
              );
            });
          },
          onInteractiveRequest: (interaction) => {
            setPendingInteraction({
              ...interaction,
              sessionId: interaction.sessionId ?? sessionId,
            });
          },
          onMessages: (nextMessages, finalSnapshotEvent) => {
            if (finalSnapshotEvent) {
              finalSnapshot = nextMessages;
              const turnId = activeTurnIdsRef.current[sessionId] ?? tempAssistant.turnId;
              const finalContent = finalAssistantContentForStream(nextMessages, turnId);
              finalSnapshotPromise = streamBuffer.flushFinalText(finalContent).then(() => {
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
        });
        if (finalSnapshotPromise) {
          await finalSnapshotPromise;
        }

        const loadedMessages = await fetchMessages(sessionId).catch(() => finalSnapshot);
        if (loadedMessages && loadedMessages.length > 0) {
          setMessagesByConversation((current) => ({
            ...current,
            [sessionId]: mergeLoadedMessagesPreservingLocalState(
              current[sessionId] ?? [],
              loadedMessages,
            ),
          }));
        }
        void reloadConversations().catch(() => undefined);
      } catch (caught) {
        if (!controller.signal.aborted) {
          setError(errorMessage(caught));
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
    [clearSessionRunning, markSessionRunning, reloadConversations],
  );

  const regenerateAssistantMessage = useCallback(
    async (message: ChatMessage) => {
      const conversationId = message.conversationId?.trim() || activeConversationId;
      if (isSessionSending(conversationId)) {
        return;
      }
      const turnId = message.turnId?.trim() ?? '';
      const conversation =
        conversations.find((item) => item.id === conversationId) ?? activeConversation;
      if (!conversation || !conversationId || !turnId) {
        setError('这条回复缺少 BushServer turn_id，无法重新生成');
        return;
      }
      if (!selectedModel.trim()) {
        setError('请先在设置中配置模型');
        return;
      }
      const messages = messagesByConversation[conversationId] ?? activeMessages;
      const index = messages.findIndex((item) => item.id === message.id);
      if (index < 0) {
        return;
      }
      const tempAssistant: ChatMessage = {
        ...message,
        id: `assistant-regenerate-${crypto.randomUUID()}`,
        role: 'assistant',
        content: '',
        toolExecutions: [],
        loopHistory: [],
        conversationId,
        createdAt: new Date().toISOString(),
      };
      const initialMessages = [...messages];
      initialMessages[index] = tempAssistant;
      const projectDir = conversationProjectRequestDir(conversation);
      const projectUserPrompt = projectDir
        ? requestContext.projectContexts?.[projectKey(projectDir)]?.trim()
        : '';

      await runControlAssistantStream({
        conversation,
        initialMessages,
        rollbackMessages: messages,
        tempAssistant,
        stream: (controller, handlers) =>
          regenerateTurn({
            sessionId: conversationId,
            turnId,
            model: selectedModel,
            modelConfig: modelConfigFor(managedModelConfigs, selectedModel),
            agentProfile: conversation.agentProfile ?? selectedRuntimeProfile,
            projectDir,
            projectUserPrompt,
            allowedSkills: skills
              .map((skill) => skill.name)
              .filter((name) => !requestContext.disabledSkillNames?.has(name)),
            referencePlanMode,
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
      requestContext.projectContexts,
      referencePlanMode,
      runControlAssistantStream,
      sendMessage,
      selectedModel,
      selectedRuntimeProfile,
      skills,
    ],
  );

  const editUserMessageAndRegenerate = useCallback(
    async (message: ChatMessage, nextContent: string) => {
      const content = nextContent.trim();
      const outbound = splitStreamAttachmentMentions(content);
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
        setError('请先在设置中配置模型');
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
        const loadedMessages = await fetchMessages(conversationId).catch((caught) => {
          refreshFailed = true;
          setError(`刷新会话消息失败: ${errorMessage(caught)}`);
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
        setNotice('未定位到原消息，已作为新提问发送。');
        return;
      }
      const createdAt = new Date().toISOString();
      const editedUser: ChatMessage = {
        ...editSourceMessage,
        content,
        conversationId,
        turnId: undefined,
        createdAt,
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
      const projectUserPrompt = projectDir
        ? requestContext.projectContexts?.[projectKey(projectDir)]?.trim()
        : '';

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
            content,
            model: selectedModel,
            modelConfig: modelConfigFor(managedModelConfigs, selectedModel),
            agentProfile: conversation.agentProfile ?? selectedRuntimeProfile,
            projectDir,
            projectUserPrompt,
            allowedSkills: skills
              .map((skill) => skill.name)
              .filter((name) => !requestContext.disabledSkillNames?.has(name)),
            referencePlanMode,
            images: outbound.images,
            files: outbound.files,
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
      requestContext.projectContexts,
      referencePlanMode,
      runControlAssistantStream,
      selectedModel,
      selectedRuntimeProfile,
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
        setError('当前回复尚未准备好插入引导，请稍后再试');
        return;
      }
      try {
        await sendGuidance({
          sessionId: conversationId,
          turnId,
          guidance: text,
          mode,
        });
        setError(null);
      } catch (caught) {
        if (String(caught).includes('404')) {
          for (let attempt = 0; attempt < 40; attempt += 1) {
            if (!isSessionSending(conversationId)) {
              const conversation =
                conversations.find((item) => item.id === conversationId) ??
                activeConversation;
              await sendMessageRef.current(text, conversation);
              return;
            }
            await delay(100);
          }
          setError('当前 turn 已结束，请把这条引导作为普通追问重新发送');
          return;
        }
        setError(`引导发送失败: ${errorMessage(caught)}`);
      }
    },
    [
      activeConversation,
      activeConversationId,
      conversations,
      isSessionSending,
      sendMessage,
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
        setError('当前回复尚未准备好插入引导，请稍后再试');
        return;
      }
      try {
        await sendGuidance({
          sessionId: conversationId,
          turnId: active,
          guidance: text,
          mode,
        });
        removeQueuedMessage(queuedId);
        setError(null);
      } catch (caught) {
        setError(`引导发送失败: ${errorMessage(caught)}`);
      }
    },
    [activeConversationId, isSessionSending, removeQueuedMessage],
  );

  const replyToInteraction = useCallback(
    async (reply: string | InteractionReplyAnswer[]) => {
      const interaction = pendingInteraction;
      if (!interaction) {
        return;
      }
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
    },
    [pendingInteraction],
  );

  const cancelPendingInteraction = useCallback(async () => {
    const interaction = pendingInteraction;
    setPendingInteraction(null);
    if (interaction) {
      await cancelInteraction(interaction.id).catch((caught) =>
        setError(errorMessage(caught)),
      );
    }
  }, [pendingInteraction]);

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
    queuedMessages: activeQueuedMessages,
    queuedMessageCount: activeQueuedMessages.length,
    queuedMessagePreview: activeQueuedMessages[0]?.text ?? '',
    pendingInteraction,
    error,
    notice,
    selectedModel,
    setSelectedModel,
    selectedRuntimeProfile: activeRuntimeProfile,
    runtimeProfiles,
    setSelectedRuntimeProfile,
    referencePlanMode,
    setReferencePlanMode,
    openConversation,
    startConversation,
    deleteConversation,
    renameConversation,
    reloadConversations,
    reloadSkills,
    loadSkillDetail,
    createSessionShareLink,
    refreshActiveSession,
    sendMessage,
    regenerateAssistantMessage,
    editUserMessageAndRegenerate,
    sendTurnGuidance,
    sendQueuedMessageAsGuidance,
    removeQueuedMessage,
    replyToInteraction,
    cancelPendingInteraction,
    cancelSending,
    clearError,
    clearNotice,
  };
}

function readInitialSelectedModel(availableModels: string[]) {
  const stored = window.localStorage.getItem('cardbush.selected_model')?.trim();
  if (stored && availableModels.some((model) => model === stored)) {
    return stored;
  }
  return availableModels[0] ?? '';
}

const defaultRuntimeProfiles: RuntimeProfileSummary[] = [
  {
    id: 'general',
    label: 'General',
    description: 'General purpose assistant.',
    defaultLane: 'general',
    phases: [],
    allowedLanes: [],
    raw: { id: 'general' },
  },
  {
    id: 'code',
    label: 'Code',
    description: 'Programming workflow: inspect, edit, verify, final.',
    defaultLane: 'code',
    phases: ['inspect', 'edit', 'verify', 'final'],
    allowedLanes: ['code'],
    raw: { id: 'code' },
  },
  {
    id: 'code-review',
    label: 'Code Review',
    description: 'Read-only review focused on findings and risks.',
    defaultLane: 'review',
    phases: ['inspect', 'review', 'final'],
    allowedLanes: ['review'],
    raw: { id: 'code-review' },
  },
  {
    id: 'research',
    label: 'Research',
    description: 'Evidence-first research workflow.',
    defaultLane: 'research',
    phases: ['collect', 'compare', 'synthesize', 'final'],
    allowedLanes: ['research'],
    raw: { id: 'research' },
  },
];

function readInitialRuntimeProfile() {
  return normalizeRuntimeProfileId(
    window.localStorage.getItem('cardbush.runtime_profile') ?? 'general',
  );
}

function readInitialReferencePlanMode(): ReferencePlanMode {
  return normalizeReferencePlanMode(
    window.localStorage.getItem('cardbush.reference_plan_mode') ?? 'off',
  );
}

function normalizeReferencePlanMode(value: string): ReferencePlanMode {
  return value.trim() === 'auto' ? 'auto' : 'off';
}

function normalizeRuntimeProfileId(value: string) {
  const normalized = value.trim();
  return normalized || 'general';
}

function mergeRuntimeProfiles(profiles: RuntimeProfileSummary[]) {
  const merged = new Map<string, RuntimeProfileSummary>();
  for (const profile of defaultRuntimeProfiles) {
    merged.set(profile.id, profile);
  }
  for (const profile of profiles) {
    if (profile.id.trim()) {
      merged.set(profile.id, profile);
    }
  }
  return [...merged.values()];
}

function queuedMessageConversationId(item: QueuedChatMessage) {
  return item.conversation?.id?.trim() ?? '';
}

function modelConfigFor(configs: ManagedModelConfig[], selectedModel: string) {
  const normalized = selectedModel.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  return configs.find(
    (config) => config.modelName.trim().toLowerCase() === normalized,
  );
}

function projectKey(projectDir: string) {
  return projectDir.trim().replace(/\\/g, '/').toLowerCase();
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

function finalAssistantContentForStream(messages: ChatMessage[], turnId?: string) {
  const normalizedTurnId = turnId?.trim() ?? '';
  const assistants = messages.filter(
    (message) =>
      message.role === 'assistant' &&
      message.content.trim() &&
      !isSupersededLoopAssistant(message),
  );
  if (normalizedTurnId) {
    const finalExact = [...assistants]
      .reverse()
      .find(
        (message) =>
          (message.turnId?.trim() ?? '') === normalizedTurnId &&
          isAssistantFinalTranscript(message),
      );
    if (finalExact) {
      return finalExact.content;
    }
    const exact = [...assistants]
      .reverse()
      .find((message) => (message.turnId?.trim() ?? '') === normalizedTurnId);
    if (exact) {
      return exact.content;
    }
  }
  return [...assistants].reverse().find(isAssistantFinalTranscript)?.content ??
    assistants.at(-1)?.content ??
    '';
}

const streamSentenceFlushThreshold = 50;
const streamForceFlushThreshold = 140;
const streamFlushIntervalMs = 18;
const streamBaseCharChunkSize = 2;
const streamMediumCharChunkSize = 4;
const streamFastCharChunkSize = 7;
const streamCatchUpCharChunkSize = 11;

type StreamReadySegment = {
  text: string;
  atomic: boolean;
};

function createAssistantStreamDeltaBuffer(append: (delta: string) => void) {
  let pending = '';
  const ready: StreamReadySegment[] = [];
  let timer: number | undefined;
  let emitted = '';
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
    emitted += delta;
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

  const bufferedText = () =>
    `${ready.map((segment) => segment.text).join('')}${pending}`;

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
    flushFinalText(finalText: string) {
      const knownText = `${emitted}${bufferedText()}`;
      if (finalText && finalText.startsWith(knownText)) {
        pending += finalText.slice(knownText.length);
      } else if (finalText && finalText.startsWith(emitted)) {
        ready.length = 0;
        pending = finalText.slice(emitted.length);
      }
      return flushAllStreaming();
    },
    reset(nextEmitted = '') {
      clearTimer();
      ready.length = 0;
      pending = '';
      emitted = nextEmitted;
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

function appendAssistantDelta(
  current: Record<string, ChatMessage[]>,
  sessionId: string,
  assistantId: string,
  delta: string,
) {
  const messages = current[sessionId] ?? [];
  return {
    ...current,
    [sessionId]: messages.map((message) => {
      if (message.id !== assistantId) {
        return message;
      }
      if (shouldStartNextLocalAssistantSegment(message, delta)) {
        const loopHistory = mergeLoopHistoryMessages(
          message.loopHistory ?? [],
          [localLoopHistorySnapshot(message)],
        );
        return {
          ...message,
          content: delta,
          toolExecutions: undefined,
          loopHistory: loopHistory.length > 0 ? loopHistory : undefined,
        };
      }
      return { ...message, content: `${message.content}${delta}` };
    }),
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

function applyAssistantRevision(
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
  return {
    ...current,
    [sessionId]: messages.map((message) => {
      const messageTurnId = message.turnId?.trim() ?? '';
      const isTarget =
        message.id === assistantId ||
        (Boolean(revisionTurnId) && message.role === 'assistant' && messageTurnId === revisionTurnId);
      if (!isTarget) {
        return message;
      }
      const shouldPreserveCurrent =
        message.role === 'assistant' &&
        !isSupersededLoopAssistant(message) &&
        hasVisibleLoopHistory(message) &&
        normalizeLoopContent(message.content) !== normalizeLoopContent(nextContent);
      const loopHistory = shouldPreserveCurrent
        ? mergeLoopHistoryMessages(
            message.loopHistory ?? [],
            [localLoopHistorySnapshot(message)],
          )
        : message.loopHistory;
      return {
        ...message,
        content: nextContent,
        toolExecutions: shouldPreserveCurrent ? undefined : message.toolExecutions,
        loopHistory:
          loopHistory && loopHistory.length > 0 ? loopHistory : undefined,
      };
    }),
  };
}

function assignTurnToLocalMessages(
  current: Record<string, ChatMessage[]>,
  sessionId: string,
  turnId: string,
  messageIds: string[],
) {
  const ids = new Set(messageIds);
  return {
    ...current,
    [sessionId]: (current[sessionId] ?? []).map((message) =>
      ids.has(message.id)
        ? { ...message, turnId, conversationId: sessionId }
        : message,
    ),
  };
}

function appendToolExecution(
  current: Record<string, ChatMessage[]>,
  sessionId: string,
  assistantId: string,
  execution: ChatToolExecution,
) {
  const messages = current[sessionId] ?? [];
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
      };
      const nextExecutions =
        index >= 0
          ? existing.map((item, itemIndex) =>
              itemIndex === index ? { ...item, ...nextExecution } : item,
            )
          : [...existing, nextExecution];
      return {
        ...message,
        toolExecutions: nextExecutions,
      };
    }),
  };
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
          ? {
              ...item,
              ...execution,
              contentOffset: item.contentOffset,
            }
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
        message.assistantMessageId === assistantMessageId,
    );
    if (matched) {
      return matched.id;
    }
  }
  return fallbackAssistantId;
}

function mergeMessages(
  current: Record<string, ChatMessage[]>,
  sessionId: string,
  incoming: ChatMessage[],
) {
  const byId = new Map((current[sessionId] ?? []).map((item) => [item.id, item]));
  for (const message of incoming) {
    const existing = byId.get(message.id);
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
      toolExecutions: nextToolExecutions,
      loopHistory: nextLoopHistory.length > 0 ? nextLoopHistory : undefined,
    });
  }
  return {
    ...current,
    [sessionId]: collapseLoopTranscriptMessages(Array.from(byId.values())),
  };
}

function mergeFinalStreamMessages(
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
      metadata: mergeFinalAssistantTimingMetadata(
        message,
        existingMessage,
        completedAt,
      ),
      toolExecutions:
        (message.toolExecutions?.length ?? 0) > 0
          ? message.toolExecutions
          : existingToolExecutions,
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

  const shouldReplace = (message: ChatMessage) => {
    if (incomingIds.has(message.id) || temporaryIds.has(message.id)) {
      return true;
    }
    const messageTurnId = message.turnId?.trim() ?? '';
    if (targetTurnId && messageTurnId === targetTurnId) {
      return true;
    }
    return Boolean(messageTurnId && incomingTurnIds.has(messageTurnId));
  };

  const normalizedIncoming = collapseLoopTranscriptMessages(mergedIncoming);
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
      (message.assistantMessageId?.trim() ?? '') === assistantMessageId
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
    byId.set(execution.id, execution);
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
      toolExecutions:
        (message.toolExecutions?.length ?? 0) > 0
          ? message.toolExecutions
          : source.toolExecutions,
      loopHistory:
        (message.loopHistory?.length ?? 0) > 0
          ? message.loopHistory
          : source.loopHistory,
    };
  }));
}

export function normalizeChatMessagesForDisplay(messages: ChatMessage[]) {
  return collapseLoopTranscriptMessages(messages);
}

function findLocalMessageStateSource(existing: ChatMessage[], message: ChatMessage) {
  const byId = existing.find((item) => item.id === message.id);
  if (byId) {
    return byId;
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
    return (item.loopHistory?.length ?? 0) > 0 || (item.toolExecutions?.length ?? 0) > 0;
  });
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
  return replacedMessages
    .filter((message) => message.role === 'assistant')
    .filter((message) => !finalIds.has(message.id))
    .filter(hasVisibleLoopHistory)
    .filter(
      (message) =>
        !isTemporaryAssistantCoveredByBackendTranscript(
          message,
          finalMessages,
          temporaryIds,
        ) &&
        !isRedundantTemporaryAssistant(message, finalAssistant, temporaryIds),
    )
    .map(snapshotLoopHistoryMessage);
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
    if (isSupersededLoopAssistant(candidate)) {
      return true;
    }
    return (candidate.loopHistory ?? []).some(
      (item) =>
        !temporaryIds.has(item.id) &&
        turnTranscriptKey(item) === turnKey &&
        isSupersededLoopAssistant(item),
    );
  });
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
  return sortMessagesByTranscriptOrder(visible);
}

function sortMessagesByTranscriptOrder(messages: ChatMessage[]) {
  return messages
    .map((message, index) => ({ message, index }))
    .sort((left, right) => {
      const turnDelta = compareOptionalOrder(
        numericOrderValue(left.message.turnSequence),
        numericOrderValue(right.message.turnSequence),
      );
      if (turnDelta !== 0) {
        return turnDelta;
      }
      const sameTurn =
        turnTranscriptKey(left.message) === turnTranscriptKey(right.message);
      const indexDelta = sameTurn
        ? compareOptionalOrder(
            numericOrderValue(left.message.messageIndex),
            numericOrderValue(right.message.messageIndex),
          )
        : 0;
      if (indexDelta !== 0) {
        return indexDelta;
      }
      const loopDelta = sameTurn
        ? compareOptionalOrder(
            numericOrderValue(left.message.loopIndex),
            numericOrderValue(right.message.loopIndex),
          )
        : 0;
      if (loopDelta !== 0) {
        return loopDelta;
      }
      const dateDelta = compareOptionalOrder(
        dateOrderValue(left.message.createdAt),
        dateOrderValue(right.message.createdAt),
      );
      if (dateDelta !== 0) {
        return dateDelta;
      }
      return left.index - right.index;
    })
    .map((item) => item.message);
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
  return /^msg_\d+$/.test(normalized) || /^\d+$/.test(normalized);
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

function chatMessageTurnId(message: ChatMessage) {
  return String(
    message.turnId ??
      message.metadata?.turn_id ??
      message.metadata?.turnId ??
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
  return (
    message.role === 'assistant' &&
    status === 'superseded' &&
    (!transcriptKind || transcriptKind === 'assistant_loop')
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
  for (const message of [...existing, ...incoming]) {
    if (!hasVisibleLoopHistory(message)) {
      continue;
    }
    byKey.set(loopHistoryMessageKey(message), snapshotLoopHistoryMessage(message));
  }
  return sortMessagesByTranscriptOrder(Array.from(byKey.values()));
}

function snapshotLoopHistoryMessage(message: ChatMessage): ChatMessage {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    conversationId: message.conversationId,
    turnId: message.turnId,
    createdAt: message.createdAt,
    status: message.status,
    loopIndex: message.loopIndex,
    turnSequence: message.turnSequence,
    messageIndex: message.messageIndex,
    assistantMessageId: message.assistantMessageId,
    attachments: message.attachments?.map((attachment) => ({ ...attachment })),
    toolExecutions: message.toolExecutions?.map((execution) => ({
      ...execution,
      metadata: { ...execution.metadata },
    })),
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
) {
  const updated = {
    ...conversation,
    preview,
    updatedAt: new Date().toISOString(),
  };
  const without = current.filter((item) => item.id !== conversation.id);
  return [updated, ...without];
}

function conversationPreviewFromMessages(messages: ChatMessage[]) {
  const lastUser = [...messages].reverse().find((item) => item.role === 'user');
  return lastUser?.content.trim() || messages.at(-1)?.content.trim() || '';
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
    userInput:
      userInput ||
      (images.length > 0 || files.length > 0
        ? 'Please review the attached file(s).'
        : content.trim()),
    images,
    files,
  };
}

function attachmentPathFromLine(value: string) {
  const trimmed = value.trim();
  const pathValue = stripWrappingQuotes(
    trimmed.startsWith('@') ? trimmed.slice(1).trim() : trimmed,
  );
  if (/^[a-zA-Z]:[\\/]/.test(pathValue) || pathValue.startsWith('\\\\') || pathValue.startsWith('/')) {
    return pathValue;
  }
  return '';
}

function isImagePath(value: string) {
  return /\.(png|jpe?g|webp|gif|bmp|ico)$/i.test(stripWrappingQuotes(value.trim()));
}

function stripWrappingQuotes(value: string) {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (
    (first === '"' && last === '"') ||
    (first === "'" && last === "'") ||
    (first === '`' && last === '`')
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function localConversation(projectDir?: string): ConversationSummary {
  const id = `local-${crypto.randomUUID()}`;
  return {
    id,
    title: '新会话',
    preview: '',
    updatedAt: new Date().toISOString(),
    projectDir,
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}
