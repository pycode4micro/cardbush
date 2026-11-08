import { randomUUID } from 'node:crypto';
import { compactConversationTitle, conversationTitleLimit, readUserPrompt, type ModelRequest, type RuntimeSessionCommitCheckpoint } from '@cardbush/bush-protocol';
import { renderPromptTemplate } from '@cardbush/platform/prompts';
import type { ModelProvider } from './modelProvider.js';
import { executeModelRound } from './modelRound.js';

export function firstTitleSource(commit: RuntimeSessionCommitCheckpoint) {
  const input = commit.inputMessages.find(({ message }) => message.role === 'user' && message.visibility !== 'internal');
  if (!input) return '';
  const text = readUserPrompt(input.message.content, input.metadata).text.trim();
  if (text) return text;
  const attachments = input.metadata?.attachments;
  return Array.isArray(attachments) ? attachments.flatMap(item => typeof item?.name === 'string' ? [item.name] : []).join(' ') : '';
}

export async function summarizeConversationTitle(provider: ModelProvider, request: ModelRequest, source: string, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(15_000);
  try {
    const result = await executeModelRound(provider, {
      protocol: request.protocol, requestId: randomUUID(), sessionId: request.sessionId, turnId: 'title_' + randomUUID(),
      model: request.model, providerBinding: request.providerBinding, maxOutputTokens: 256,
      messages: [{ role: 'system', content: renderPromptTemplate('conversation-title', { limit: conversationTitleLimit }) },
        { role: 'user', content: source.slice(0, 12000) }],
      tools: [], permissionMode: 'task_free', requestCapabilities: { vision: false, interactiveRequests: false },
      metadata: { runtimeMaintenance: 'conversation_title' },
    }, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (result.status === 'completed' && !result.toolCalls.length) {
      const title = compactConversationTitle(result.text);
      if (title) return { title, titleGeneration: 'generated' as const };
    }
  } catch { /* A title-only provider failure must not fail the user's task. */ }
  return { title: compactConversationTitle(source), titleGeneration: 'fallback' as const };
}
