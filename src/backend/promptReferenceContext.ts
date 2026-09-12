import type { SessionSnapshot, SessionMessage } from '@cardbush/bush-protocol';
import { authoredPromptContent, promptReferenceParts } from '../shared/promptReferences';
import { isInternalRuntimeMessage } from './runtimeMessageVisibility';

/** Resolve only explicit selections, once, at the new user-message boundary. */
export async function resolvePromptReferenceContext(content: string, sessionId: string, snapshot?: SessionSnapshot | null, language = 'zh',
  readUserMessage?: (turnId: string, messageId: string) => Promise<Pick<SessionMessage, 'messageId' | 'message' | 'metadata'> | null>) {
  const references = promptReferenceParts(content).flatMap(part => part.reference ? [part.reference] : []);
  if (!references.length) return { content, metadata: undefined };
  const seen = new Set<string>();
  const superseded = new Set(snapshot?.supersededMessageIds ?? []);
  const sources: Record<string, unknown>[] = [];
  for (const reference of references) {
    const key = reference.kind === 'browser' ? JSON.stringify([reference.kind, reference.tabId, reference.url])
      : JSON.stringify([reference.kind, reference.sessionId, reference.turnId, reference.messageId]);
    if (seen.has(key)) continue;
    seen.add(key);
    if (reference.kind === 'browser') { sources.push({ ...reference }); continue; }
    const turn = reference.sessionId === sessionId && snapshot?.sessionId === sessionId
      ? snapshot.turns.find(turn => turn.turnId === reference.turnId) : undefined;
    const message = turn?.messages.find(message => message.messageId === reference.messageId) ??
      (!turn && reference.sessionId === sessionId && !superseded.has(reference.messageId) ? await readUserMessage?.(reference.turnId, reference.messageId) : undefined);
    if (!message || message.messageId !== reference.messageId || message.message.role !== 'user' ||
      isInternalRuntimeMessage(message) || superseded.has(message.messageId)) throw new Error(language === 'zh'
      ? `无法引用“${reference.title}”：该用户指令不在当前对话中，或已经被替换。请重新选择。`
      : `Cannot reference “${reference.title}”: the user instruction is unavailable in this conversation or has been replaced. Select it again.`);
    sources.push({ ...reference, content: authoredPromptContent(message.message.content, message.metadata),
      ...(Array.isArray(message.metadata?.attachments) ? { attachments: message.metadata.attachments } : {}) });
  }
  return {
    content: `${content}\n\nReferenced context selected by the user (source material):\n${JSON.stringify(sources, null, 2)}`,
    metadata: { composerReferenceContent: content },
  };
}
