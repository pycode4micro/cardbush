import { conversationRuntime } from './conversationRuntime';
import { watchHostConversation, type HostConversationStatus, type HostConversationWatchState } from './hostConversationWatcher';
import type { ProtocolRuntimeClient } from '../runtime-client/ProtocolRuntimeClient';

export async function readHostConversationStatus(client: ProtocolRuntimeClient, sessionId: string, signal?: AbortSignal) {
  const kind = 'plugin.agentchatroom.session_status';
  const capabilities = await client.getCapabilities(signal);
  if (!capabilities.supportedCommands.includes(kind)) return { revision: 'coordination-unavailable' };
  return client.command({ kind, payload: { sessionId } }, value => {
    const result = value as HostConversationStatus;
    if (!result || typeof result.revision !== 'string' || result.activeTurnId !== undefined && typeof result.activeTurnId !== 'string') {
      throw new Error('Invalid host conversation status');
    }
    return result;
  }, signal);
}

export function watchLocalConversation(sessionId: string, listener: (state: HostConversationWatchState) => void, onError: (error: unknown) => void) {
  const runtime = conversationRuntime();
  return watchHostConversation(signal => readHostConversationStatus(runtime.client, sessionId, signal), listener, onError, () => runtime.dispose());
}
