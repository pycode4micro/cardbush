import { conversationRuntime, type ConversationRuntime } from './conversationRuntime';

export async function controlTerminalTask(sessionId: string, terminalSessionId: string, action: 'status' | 'stop', runtimeOverride?: ConversationRuntime, signal?: AbortSignal) {
  const runtime = conversationRuntime(runtimeOverride);
  try { return await runtime.client.terminalControl({ sessionId, terminalSessionId, action }, signal); }
  finally { if (!runtimeOverride) runtime.dispose(); }
}
