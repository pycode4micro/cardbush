import * as local from './api';
import { onRuntimeInteractionsChanged } from '../runtime-client/RuntimeInteractionBridge';
import type { ChatStreamRequest } from './api';
import type { QueuedChatMessage } from '../hooks/useCardbushChat';

export const localConversationBackend = {
  cancelInteraction: local.cancelInteraction, createConversation: local.createConversation,
  deleteConversationApi: local.deleteConversationApi, editMessage: local.editMessage,
  fetchConversations: local.fetchConversations, fetchGoalRuntimeStatus: local.fetchGoalRuntimeStatus,
  fetchExperimentalGoals: local.fetchExperimentalGoals, fetchMessages: local.fetchMessages,
  fetchPendingInteraction: local.fetchPendingInteraction, fetchSessionContextWindowUsage: local.fetchSessionContextWindowUsage,
  fetchSessionWorkspaceChanges: local.fetchSessionWorkspaceChanges, fetchSkillDetail: local.fetchSkillDetail,
  fetchSkills: local.fetchSkills, fetchSessionMessages: local.fetchSessionMessages, fetchTeamFlow: local.fetchTeamFlow,
  replyInteraction: local.replyInteraction, sendGuidance: local.sendGuidance, sendTeamFlowAction: local.sendTeamFlowAction,
  stopTurn: local.stopTurn, streamChat: local.streamChat, streamTurnEvents: local.streamTurnEvents,
  updateConversation: local.updateConversation, switchConversationWorkspace: local.switchConversationWorkspace,
  updateExperimentalGoal: local.updateExperimentalGoal, onRuntimeInteractionsChanged,
};

/** Conversation behavior is shared; the host supplies transport and durable work ownership. */
export type ConversationBackend = typeof localConversationBackend & {
  scope?: string;
  isSubmissionRetry?: (sessionId: string, userInput: string) => boolean;
  queue?: {
    enqueue(request: ChatStreamRequest): Promise<void>;
    remove(id: string): Promise<void>;
    reorder(id: string, targetId: string): Promise<void>;
    guide(id: string, turnId: string): Promise<void>;
  };
  watchSession?: (sessionId: string, listener: (state: {
    activeTurnId?: string; queued: QueuedChatMessage[]; revision: string;
  }) => void, onError: (error: unknown) => void) => () => void;
};
