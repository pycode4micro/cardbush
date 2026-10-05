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
  async send(text: string, config: ChatStreamRequest, spoken: boolean, expectedVersion = contextVersion) {
    if (resetting) throw Error('正在重置上下文，请稍后发送。');
    if (expectedVersion !== contextVersion) throw Error('上下文已重置，请重新发送。');
    const { generation } = await assistantBackend.read();
    if (resetting || expectedVersion !== contextVersion) throw Error('上下文已重置，请重新发送。');
    const runtime = createDesktopRuntimeSession();
    try {
      const outbound = splitStreamAttachmentMentions(text);
      const profile = readAssistantProfile();
      const attachments = await assistantExecutionAttachments(await chatAttachmentsFromOutbound(outbound), profile.targetAgent);
      const input = streamAttachmentsForVision(outbound, config.standardImageInputEnabled === true);
      const { runtimeRequest: parent } = await prepareRuntimeAgentRequest({ ...config, sessionId, userInput: input.userInput,
        files: profile.targetAgent ? attachments.map(file => file.execution!.path) : input.files, images: input.images, attachments }, runtime, { turnId: `assistant_${crypto.randomUUID()}` });
      parent.metadata.assistantOutputMode = spoken ? 'voice' : 'text';
      const entry: ConversationEntry = { id: `input-${crypto.randomUUID()}`, role: 'user', content: outbound.displayInput || input.userInput,
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
