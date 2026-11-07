import { readAssistantProfile, saveAssistantProfile } from '../assistantProfile';
import { FRIENDS_COMMAND, ANSWER_RUNTIME_SOLUTION_SELECTION_COMMAND,
  PERSONAL_ASSISTANT_SESSION, type AssistantEventPreferences, type AssistantProfile, type FriendInput, type FriendsSnapshot, type FriendsConnectionStatus, type RuntimePermissionAnswer, type RuntimeSolutionAnswer } from '@cardbush/bush-protocol';
import { createConversation, type ChatStreamRequest } from '../../../backend/api';
import { prepareRuntimeAgentRequest } from '../../../backend/runtimeChat';
import { createDesktopRuntimeSession } from '../../../runtime-client/ElectronRuntimeSession';
import { emptyEventPreferences } from './eventPreferences';

async function command<T = FriendsSnapshot>(payload: unknown): Promise<T> {
  const runtime = createDesktopRuntimeSession();
  try { return await runtime.client.command({ kind: FRIENDS_COMMAND, payload }, value => value as T); }
  finally { runtime.dispose(); }
}
export const eventBackend = {
  read: () => command({ action: 'read' }),
  status: () => command<FriendsConnectionStatus>({ action: 'status' }),
  targets: () => command<Array<{ sourceRef: string; botName: string; senderId: string; conversationId: string }>>({ action: 'targets' }),
  async configure(config: ChatStreamRequest, assistant: AssistantProfile, language: string, signal: AbortSignal) {
    if (!assistant.proactive) {
      const previous = await command<AssistantEventPreferences | null>({ action: 'preferences' });
      signal.throwIfAborted();
      if (previous && readAssistantProfile() === assistant) {
        assistant = { ...assistant, proactive: previous };
        saveAssistantProfile(assistant);
      }
    }
    const preferences = assistant.proactive ?? emptyEventPreferences();
    await createConversation({ sessionId: PERSONAL_ASSISTANT_SESSION, title: assistant.name, metadata: { personalAssistant: true } });
    const runtime = createDesktopRuntimeSession();
    try {
      const { runtimeRequest: parent } = await prepareRuntimeAgentRequest({ ...config, sessionId: PERSONAL_ASSISTANT_SESSION, userInput: '', uiLanguage: language }, runtime);
      signal.throwIfAborted();
      await command({ action: 'configure', parent, assistant, profile: { name: assistant.name, language,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        recognition: preferences.confirmedAt ? preferences.recognition : {}, confirmedAt: preferences.confirmedAt ?? new Date(0).toISOString(),
        interactionPreferences: { beforeExecution: preferences.beforeExecution, report: preferences.report } } });
    } finally { runtime.dispose(); }
  },
  submit: (input: FriendInput) => command({ action: 'submit', input }),
  manage: (action: 'pause' | 'resume' | 'archive' | 'restore' | 'delete', eventId: string) => command({ action, eventId }),
  async answerPermission(answer: RuntimePermissionAnswer) {
    const runtime = createDesktopRuntimeSession();
    try { return await runtime.answerPermission(answer); } finally { runtime.dispose(); }
  },
  async answerSolution(answer: RuntimeSolutionAnswer) {
    const runtime = createDesktopRuntimeSession();
    try { return await runtime.client.command({ kind: ANSWER_RUNTIME_SOLUTION_SELECTION_COMMAND, payload: answer }, value => value); }
    finally { runtime.dispose(); }
  },
};
