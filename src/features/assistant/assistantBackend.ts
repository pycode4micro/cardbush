import { uiText } from '../../i18n';
import { readUserPrompt, type UserPromptInput } from '@cardbush/bush-protocol';
import { PERSONAL_ASSISTANT_SESSION as sessionId, type ConversationEntry } from '@cardbush/bush-protocol';
import { createConversation, type ChatStreamRequest } from '../../backend/api';
import { conversationJournalCommand, readConversationJournal, journalMessages } from '../../backend/conversationJournal';
import { prepareRuntimeAgentRequest } from '../../backend/runtimeChat';
import { createRealtimeAgentExecutor } from '../../backend/realtimeAgent';
import { createDesktopRuntimeSession } from '../../runtime-client/ElectronRuntimeSession';
import { readAssistantProfile } from './assistantProfile';
import { splitStreamAttachmentMentions, chatAttachmentsFromOutbound, streamAttachmentsForVision } from '../../shared/chatAttachments';
import { assistantExecutionAttachments } from './assistantAttachments';
let resetting: Promise<void> | undefined;
let contextVersion = 0;

/** Keep UI, conversational inference and the existing execution Agent independently replaceable. */
export const assistantBackend = {
  ensure: (name: string) => createConversation({ sessionId, title: name, metadata: { personalAssistant: true } }),
  read: (after = 0) => readConversationJournal(sessionId, after),
  contextVersion: () => contextVersion,
  async stop() {
    const { generation } = await assistantBackend.read();
    await conversationJournalCommand({ action: 'stop', sessionId, generation });
  },
  async retry(config: ChatStreamRequest) {
    if (resetting) throw Error(uiText()('assistantBackend.context_is_being_reset_try_again_shortly'));
    const version = contextVersion;
    const { generation, entries } = await assistantBackend.read();
    const entry = entries.filter(item => item.role === 'user' && ['text', 'voice'].includes(item.source)).at(-1);
    if (!entry) throw Error(uiText()('assistantBackend.there_is_no_message_to_retry'));
    const runtime = createDesktopRuntimeSession();
    try {
      const profile = readAssistantProfile();
      const { runtimeRequest: parent } = await prepareRuntimeAgentRequest({ ...config, sessionId, userInput: entry.content }, runtime,
        { turnId: `assistant_${crypto.randomUUID()}` });
      parent.metadata.assistantOutputMode = entry.source === 'voice' ? 'voice' : 'text';
      if (resetting || version !== contextVersion) throw Error(uiText()('assistantBackend.context_was_reset_send_the_message_again'));
      // Resume the authoritative model history and tool receipts; do not append
      // another user message or replay an already accepted execution task.
      await conversationJournalCommand({ action: 'retry', sessionId, parent, profile, generation });
    } finally { runtime.dispose(); }
  },
  reset() {
    if (resetting) return resetting;
    contextVersion++;
    return resetting = (async () => {
      await assistantBackend.ensure(readAssistantProfile().name);
      await window.cardbushDesktop?.voice?.realtime?.forgetHistory(sessionId);
      await conversationJournalCommand({ action: 'reset', sessionId });
      window.dispatchEvent(new Event('cardbush:assistant-reset'));
    })().finally(() => { resetting = undefined; });
  },
  async send(text: UserPromptInput, config: ChatStreamRequest, spoken: boolean, expectedVersion = contextVersion) {
    if (resetting) throw Error(uiText()('assistantBackend.context_is_being_reset_send_the_message'));
    if (expectedVersion !== contextVersion) throw Error(uiText()('assistantBackend.context_was_reset_send_the_message_again'));
    const { generation } = await assistantBackend.read();
    if (resetting || expectedVersion !== contextVersion) throw Error(uiText()('assistantBackend.context_was_reset_send_the_message_again'));
    const runtime = createDesktopRuntimeSession();
    try {
      const prompt = readUserPrompt(text);
      const outbound = { ...splitStreamAttachmentMentions(prompt.text), promptContext: prompt.context };
      const profile = readAssistantProfile();
      const attachments = await assistantExecutionAttachments(await chatAttachmentsFromOutbound(outbound), profile.targetAgent);
      const input = streamAttachmentsForVision(outbound, config.standardImageInputEnabled === true);
      const { runtimeRequest: parent } = await prepareRuntimeAgentRequest({ ...config, sessionId, userInput: input.userInput,
        promptContext: outbound.promptContext,
        files: profile.targetAgent ? attachments.map(file => file.execution!.path) : input.files, images: input.images, attachments }, runtime, { turnId: `assistant_${crypto.randomUUID()}` });
      parent.metadata.assistantOutputMode = spoken ? 'voice' : 'text';
      const entry: ConversationEntry = { id: `input-${crypto.randomUUID()}`, role: 'user', content: outbound.displayInput || input.userInput,
        ...(outbound.promptContext ? { promptContext: outbound.promptContext } : {}),
        ...(attachments.length ? { attachments } : {}),
        source: spoken ? 'voice' : 'text', visibility: spoken ? 'internal' : 'conversation', createdAt: new Date().toISOString() };
      await conversationJournalCommand({ action: 'turn', sessionId, entry, parent, profile, generation });
    } finally { runtime.dispose(); }
  },
  voice(prepare: () => Promise<ChatStreamRequest>) {
    const make = (get: () => Promise<ChatStreamRequest>, conversationGeneration?: number) => createRealtimeAgentExecutor(get, () => sessionId,
      { assistant: true, targetAgent: () => readAssistantProfile().targetAgent, conversationGeneration });
    const agent = make(prepare);
    agent.pin = async target => {
      const config = await prepare(), { generation, entries } = await assistantBackend.read(), executor = make(async () => config, generation);
      // A call started just after reset must not seed the old view's cached history.
      const pinned = { ...target, agent: executor, contextGeneration: generation,
        messages: journalMessages(entries.filter(entry => !['page','task'].includes(entry.source)).map(entry => ({ ...entry, visibility: 'conversation' })), sessionId),
        historyMessages: journalMessages(entries.filter(entry => entry.source !== 'task').map(entry => ({ ...entry, visibility: 'conversation' })), sessionId) };
      return { ...pinned, refresh: () => {
        const fresh = target.refresh?.();
        return fresh && fresh.contextGeneration === generation ? { ...fresh, agent: executor } : pinned;
      } };
    };
    return agent;
  },
};
