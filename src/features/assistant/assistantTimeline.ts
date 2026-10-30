import { readUserPrompt, type ConversationEntry, type UserPromptInput } from '@cardbush/bush-protocol';
import { chatAttachmentsFromOutbound, splitStreamAttachmentMentions } from '../../shared/chatAttachments';

/** A local receipt is visible before configuration, attachment inspection or IPC. */
export async function assistantInputEntry(text: UserPromptInput): Promise<ConversationEntry> {
  const id = `input-${crypto.randomUUID()}`, createdAt = new Date().toISOString();
  const prompt = readUserPrompt(text), outbound = splitStreamAttachmentMentions(prompt.text);
  const attachments = await chatAttachmentsFromOutbound(outbound, false);
  return { id, createdAt, role: 'user', source: 'text', visibility: 'conversation', content: outbound.displayInput || outbound.userInput,
    ...(prompt.context ? { promptContext: prompt.context } : {}), ...(attachments.length ? { attachments } : {}) };
}

/** Conversation gaps, rather than individual bubbles, carry visible timestamps. */
export function assistantTimeSeparators(items: readonly { key: string; at: string }[]) {
  const separators = new Set<string>();
  let previous: Date | undefined;
  for (const item of items) {
    const date = new Date(item.at);
    if (!Number.isFinite(date.getTime())) continue;
    if (!previous || date.toDateString() !== previous.toDateString() || date.getTime() - previous.getTime() >= 5 * 60_000) separators.add(item.key);
    previous = date;
  }
  return separators;
}

export function assistantTimeLabel(at: string, language: string, now = new Date()) {
  const date = new Date(at), sameDay = date.toDateString() === now.toDateString();
  return new Intl.DateTimeFormat(language, { hour: '2-digit', minute: '2-digit',
    ...(!sameDay ? { month: 'short', day: 'numeric', ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) } as const : {}) }).format(date);
}
