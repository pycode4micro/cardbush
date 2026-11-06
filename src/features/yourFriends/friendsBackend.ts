import { FRIENDS_COMMAND, FRIENDS_SESSION, ANSWER_RUNTIME_SOLUTION_SELECTION_COMMAND,
  type FriendInput, type FriendsSnapshot, type FriendsConnectionStatus, type RuntimePermissionAnswer, type RuntimeSolutionAnswer } from '@cardbush/bush-protocol';
import { createConversation, type ChatStreamRequest } from '../../backend/api';
import { prepareRuntimeAgentRequest } from '../../backend/runtimeChat';
import { createDesktopRuntimeSession } from '../../runtime-client/ElectronRuntimeSession';
import type { FriendsState } from './friendsStore';

async function command<T = FriendsSnapshot>(payload: unknown): Promise<T> {
  const runtime = createDesktopRuntimeSession();
  try { return await runtime.client.command({ kind: FRIENDS_COMMAND, payload }, value => value as T); }
  finally { runtime.dispose(); }
}
export const friendsBackend = {
  read: () => command({ action: 'read' }),
  status: () => command<FriendsConnectionStatus>({ action: 'status' }),
  async configure(config: ChatStreamRequest, state: FriendsState, language: string) {
    if (!state.introduction.confirmedAt) return;
    await createConversation({ sessionId: FRIENDS_SESSION, title: state.name || FRIENDS_SESSION, metadata: { hidden: true, friends: true } });
    const runtime = createDesktopRuntimeSession();
    try {
      const { runtimeRequest: parent } = await prepareRuntimeAgentRequest({ ...config, sessionId: FRIENDS_SESSION, userInput: '', uiLanguage: language }, runtime);
      await command({ action: 'configure', parent, profile: { name: state.name, language,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        recognition: state.introduction.answers, confirmedAt: state.introduction.confirmedAt } });
    } finally { runtime.dispose(); }
  },
  submit: (input: FriendInput) => command({ action: 'submit', input }),
  manage: (action: 'pause' | 'resume' | 'archive' | 'restore', eventId: string) => command({ action, eventId }),
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
