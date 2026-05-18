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
  ChatMessage,
  ConversationSummary,
  ManagedModelConfig,
  SkillDetail,
  SkillSummary,
  ChatToolExecution,
  PendingInteraction,
  InteractionReplyAnswer,
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
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingInteraction, setPendingInteraction] =
    useState<PendingInteraction | null>(null);
  const [selectedModel, setSelectedModelState] = useState(() =>
    readInitialSelectedModel(availableModels),
  );
  const [activeTurnId, setActiveTurnId] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const activeTurnIdRef = useRef<string | null>(null);
  const sendingRef = useRef(false);
  const queuedMessagesRef = useRef<QueuedChatMessage[]>([]);
  const sendMessageRef = useRef<
    (text: string, conversation?: ConversationSummary) => Promise<void>
  >(async () => undefined);
  const [queuedMessages, setQueuedMessages] = useState<QueuedChatMessage[]>([]);

  useEffect(() => {
    sendingRef.current = sending;
  }, [sending]);

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

  const dequeueMessage = useCallback(() => {
    const [next, ...rest] = queuedMessagesRef.current;
    queuedMessagesRef.current = rest;
    setQueuedMessages(rest);
    return next;
  }, []);

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
            [activeConversationId]: result.messages,
          }));
          if (result.conversation.projectDir || result.conversation.workspaceContext) {
            setConversations((current) =>
              current.map((item) =>
                item.id === activeConversationId
                  ? {
                      ...item,
                      projectDir: result.conversation.projectDir ?? item.projectDir,
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

  const activeMessages = activeConversationId
    ? messagesByConversation[activeConversationId] ?? []
    : [];

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
        [sessionId]: result.messages,
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
      const created = await createConversation({ projectDir });
      const nextCreated = projectDir
        ? { ...created, projectDir: created.projectDir ?? projectDir }
        : created;
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
      const created = localConversation(projectDir);
      setConversations((current) => [created, ...current]);
      setMessagesByConversation((current) => ({
        ...current,
        [created.id]: [],
      }));
      setActiveConversationId(created.id);
      return created;
    }
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

  const sendMessage = useCallback(
    async (text: string, queuedConversation?: ConversationSummary) => {
      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }
      if (sendingRef.current) {
        enqueueMessage({
          id: `queued-${crypto.randomUUID()}`,
          text: trimmed,
          conversation: queuedConversation ?? activeConversation,
          createdAt: new Date().toISOString(),
        });
        return;
      }
      const outbound = splitStreamAttachmentMentions(trimmed);
      const conversation =
        queuedConversation ?? activeConversation ?? (await startConversation());
      const sessionId = conversation.id;
      const projectDir = conversation.projectDir?.trim();
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
      setSending(true);
      sendingRef.current = true;
      setError(null);
      const controller = new AbortController();
      abortRef.current = controller;
      activeTurnIdRef.current = null;

      try {
        await streamChat({
          sessionId,
          userInput: outbound.userInput,
          model: selectedModel,
          modelConfig: modelConfigFor(managedModelConfigs, selectedModel),
          projectDir,
          projectUserPrompt,
          allowedSkills: skills
            .map((skill) => skill.name)
            .filter((name) => !requestContext.disabledSkillNames?.has(name)),
          images: outbound.images,
          files: outbound.files,
          signal: controller.signal,
          onStart: (start) => {
            activeTurnIdRef.current = start.turnId;
            setActiveTurnId(start.turnId);
            setMessagesByConversation((current) =>
              assignTurnToLocalMessages(current, sessionId, start.turnId, [
                userMessage.id,
                assistantId,
              ]),
            );
          },
          onDelta: (delta) => {
            setMessagesByConversation((current) =>
              appendAssistantDelta(current, sessionId, assistantId, delta),
            );
          },
          onToolExecution: (execution) => {
            setMessagesByConversation((current) =>
              appendToolExecution(current, sessionId, assistantId, execution),
            );
          },
          onInteractiveRequest: (interaction) => {
            setPendingInteraction({
              ...interaction,
              sessionId: interaction.sessionId ?? sessionId,
            });
          },
          onMessages: (nextMessages, finalSnapshot) => {
            if (finalSnapshot) {
              setMessagesByConversation((current) =>
                mergeFinalStreamMessages(current, sessionId, nextMessages, {
                  turnId: activeTurnIdRef.current ?? undefined,
                  temporaryMessageIds: [userMessage.id, assistantId],
                  toolSourceMessageId: assistantId,
                }),
              );
              return;
            }
            setMessagesByConversation((current) =>
              mergeMessages(current, sessionId, nextMessages),
            );
          },
        });
        void reloadConversations().catch(() => undefined);
      } catch (caught) {
        if (!controller.signal.aborted) {
          setError(errorMessage(caught));
        }
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
          activeTurnIdRef.current = null;
          setActiveTurnId('');
        }
        sendingRef.current = false;
        setSending(false);
        const nextQueued = dequeueMessage();
        if (nextQueued) {
          window.setTimeout(() => {
            void sendMessageRef.current(nextQueued.text, nextQueued.conversation);
          }, 0);
        }
      }
    },
    [
      activeConversation,
      dequeueMessage,
      enqueueMessage,
      reloadConversations,
      managedModelConfigs,
      requestContext.disabledSkillNames,
      requestContext.projectContexts,
      selectedModel,
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
      stream,
    }: {
      conversation: ConversationSummary;
      initialMessages: ChatMessage[];
      rollbackMessages: ChatMessage[];
      tempAssistant: ChatMessage;
      stream: (
        controller: AbortController,
        handlers: {
          onStart: (start: { sessionId: string; turnId: string }) => void;
          onDelta: (delta: string) => void;
          onToolExecution: (execution: ChatToolExecution) => void;
          onInteractiveRequest: (interaction: PendingInteraction) => void;
          onMessages: (messages: ChatMessage[], finalSnapshot: boolean) => void;
        },
      ) => Promise<void>;
    }) => {
      const sessionId = conversation.id;
      const controller = new AbortController();
      let finalSnapshot: ChatMessage[] | null = null;
      abortRef.current = controller;
      activeTurnIdRef.current = null;
      setActiveTurnId('');
      setSending(true);
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
            activeTurnIdRef.current = start.turnId;
            setActiveTurnId(start.turnId);
            setMessagesByConversation((current) => ({
              ...current,
              [sessionId]: (current[sessionId] ?? initialMessages).map((item) =>
                item.id === tempAssistant.id
                  ? { ...item, turnId: start.turnId, conversationId: sessionId }
                  : item,
              ),
            }));
          },
          onDelta: (delta) => {
            setMessagesByConversation((current) =>
              appendAssistantDelta(current, sessionId, tempAssistant.id, delta),
            );
          },
          onToolExecution: (execution) => {
            setMessagesByConversation((current) =>
              appendToolExecution(current, sessionId, tempAssistant.id, execution),
            );
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
              setMessagesByConversation((current) =>
                mergeFinalStreamMessages(current, sessionId, nextMessages, {
                  turnId: activeTurnIdRef.current ?? tempAssistant.turnId,
                  temporaryMessageIds: [tempAssistant.id],
                  toolSourceMessageId: tempAssistant.id,
                }),
              );
              return;
            }
            setMessagesByConversation((current) =>
              mergeMessages(current, sessionId, nextMessages),
            );
          },
        });

        const loadedMessages = await fetchMessages(sessionId).catch(() => finalSnapshot);
        if (loadedMessages && loadedMessages.length > 0) {
          setMessagesByConversation((current) => ({
            ...current,
            [sessionId]: loadedMessages,
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
        if (abortRef.current === controller) {
          abortRef.current = null;
          activeTurnIdRef.current = null;
          setActiveTurnId('');
        }
        setSending(false);
      }
    },
    [reloadConversations],
  );

  const regenerateAssistantMessage = useCallback(
    async (message: ChatMessage) => {
      if (sending) {
        return;
      }
      const conversationId = message.conversationId?.trim() || activeConversationId;
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
        conversationId,
        createdAt: new Date().toISOString(),
      };
      const initialMessages = [...messages];
      initialMessages[index] = tempAssistant;
      const projectDir = conversation.projectDir?.trim();
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
            projectDir,
            projectUserPrompt,
            allowedSkills: skills
              .map((skill) => skill.name)
              .filter((name) => !requestContext.disabledSkillNames?.has(name)),
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
      managedModelConfigs,
      messagesByConversation,
      requestContext.disabledSkillNames,
      requestContext.projectContexts,
      runControlAssistantStream,
      selectedModel,
      sending,
      skills,
    ],
  );

  const editUserMessageAndRegenerate = useCallback(
    async (message: ChatMessage, nextContent: string) => {
      if (sending) {
        return;
      }
      const content = nextContent.trim();
      const outbound = splitStreamAttachmentMentions(content);
      const conversationId = message.conversationId?.trim() || activeConversationId;
      const messageId = message.id.trim();
      const conversation =
        conversations.find((item) => item.id === conversationId) ?? activeConversation;
      if (!conversation || !conversationId || !messageId || !content) {
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
      const createdAt = new Date().toISOString();
      const editedUser: ChatMessage = {
        ...message,
        content,
        conversationId,
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
      const projectDir = conversation.projectDir?.trim();
      const projectUserPrompt = projectDir
        ? requestContext.projectContexts?.[projectKey(projectDir)]?.trim()
        : '';

      await runControlAssistantStream({
        conversation,
        initialMessages,
        rollbackMessages: messages,
        tempAssistant,
        stream: (controller, handlers) =>
          editMessage({
            sessionId: conversationId,
            messageId,
            content,
            model: selectedModel,
            modelConfig: modelConfigFor(managedModelConfigs, selectedModel),
            projectDir,
            projectUserPrompt,
            allowedSkills: skills
              .map((skill) => skill.name)
              .filter((name) => !requestContext.disabledSkillNames?.has(name)),
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
      managedModelConfigs,
      messagesByConversation,
      requestContext.disabledSkillNames,
      requestContext.projectContexts,
      runControlAssistantStream,
      selectedModel,
      sending,
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
      if (!sending) {
        await sendMessage(text);
        return;
      }
      const turnId = message.turnId?.trim() ?? '';
      const conversationId = message.conversationId?.trim() || activeConversationId;
      const active = activeTurnIdRef.current?.trim() ?? '';
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
            if (!sendingRef.current) {
              await sendMessageRef.current(text);
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
    [activeConversationId, sendMessage, sending],
  );

  const sendQueuedMessageAsGuidance = useCallback(
    async (
      queuedId: string,
      mode: 'append_context' | 'interrupt_and_continue' = 'append_context',
    ) => {
      const queued = queuedMessagesRef.current.find((item) => item.id === queuedId);
      const text = queued?.text.trim() ?? '';
      const active = activeTurnIdRef.current?.trim() ?? '';
      const conversationId =
        queued?.conversation?.id?.trim() || activeConversationId.trim();
      if (!queued || !text) {
        return;
      }
      if (!sendingRef.current || !conversationId || !active) {
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
    [activeConversationId, removeQueuedMessage],
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

  const cancelSending = useCallback(async () => {
    abortRef.current?.abort();
    const turnId = activeTurnIdRef.current;
    sendingRef.current = false;
    setSending(false);
    setActiveTurnId('');
    if (turnId) {
      await stopTurn(turnId).catch((caught) => setError(errorMessage(caught)));
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

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
    queuedMessages,
    queuedMessageCount: queuedMessages.length,
    queuedMessagePreview: queuedMessages[0]?.text ?? '',
    pendingInteraction,
    error,
    selectedModel,
    setSelectedModel,
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
  };
}

function readInitialSelectedModel(availableModels: string[]) {
  const stored = window.localStorage.getItem('cardbush.selected_model')?.trim();
  if (stored && availableModels.some((model) => model === stored)) {
    return stored;
  }
  return availableModels[0] ?? '';
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

function appendAssistantDelta(
  current: Record<string, ChatMessage[]>,
  sessionId: string,
  assistantId: string,
  delta: string,
) {
  const messages = current[sessionId] ?? [];
  return {
    ...current,
    [sessionId]: messages.map((message) =>
      message.id === assistantId
        ? { ...message, content: `${message.content}${delta}` }
        : message,
    ),
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
  return {
    ...current,
    [sessionId]: messages.map((message) => {
      if (message.id !== assistantId) {
        return message;
      }
      const contentOffset = message.content.length;
      const nextExecution = {
        ...execution,
        contentOffset,
      };
      const existing = message.toolExecutions ?? [];
      const index = existing.findIndex((item) => item.id === execution.id);
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

function mergeMessages(
  current: Record<string, ChatMessage[]>,
  sessionId: string,
  incoming: ChatMessage[],
) {
  const byId = new Map((current[sessionId] ?? []).map((item) => [item.id, item]));
  for (const message of incoming) {
    const existing = byId.get(message.id);
    byId.set(message.id, {
      ...message,
      toolExecutions:
        (message.toolExecutions?.length ?? 0) > 0
          ? message.toolExecutions
          : existing?.toolExecutions,
    });
  }
  return {
    ...current,
    [sessionId]: Array.from(byId.values()),
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

  const mergedIncoming = incoming.map((message) => {
    const existingMessage = existingById.get(message.id);
    return {
      ...message,
      toolExecutions:
        (message.toolExecutions?.length ?? 0) > 0
          ? message.toolExecutions
          : existingMessage?.toolExecutions,
    };
  });

  if (
    localToolExecutions.length > 0 &&
    !mergedIncoming.some((message) => (message.toolExecutions?.length ?? 0) > 0)
  ) {
    const targetIndex = findLastIndex(
      mergedIncoming,
      (message) => message.role === 'assistant',
    );
    if (targetIndex >= 0) {
      const target = mergedIncoming[targetIndex];
      mergedIncoming[targetIndex] = {
        ...target,
        toolExecutions: localToolExecutions,
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

  const replaceIndex = existing.findIndex(shouldReplace);
  const kept = existing.filter((message) => !shouldReplace(message));
  const insertAt = replaceIndex < 0
    ? kept.length
    : existing.slice(0, replaceIndex).filter((message) => !shouldReplace(message)).length;
  const nextMessages = [...kept];
  nextMessages.splice(insertAt, 0, ...mergedIncoming);
  return {
    ...current,
    [sessionId]: nextMessages,
  };
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
