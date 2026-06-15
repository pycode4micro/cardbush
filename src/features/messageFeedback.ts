import type { ChatMessage } from '../types';
import { truncateText } from '../shared/text';

export const COPY_FEEDBACK_EVENT = 'cardbush-copy-feedback';
export const ASSISTANT_FEEDBACK_EVENT = 'cardbush-assistant-feedback';

const ASSISTANT_FEEDBACK_STORAGE_KEY = 'cardbush_assistant_feedback';

export type AssistantFeedbackRating = 'up' | 'down';

type AssistantFeedbackRecord = {
  messageId: string;
  conversationId?: string;
  turnId?: string;
  rating: AssistantFeedbackRating;
  contentPreview: string;
  createdAt: string;
};

export async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    window.dispatchEvent(new CustomEvent(COPY_FEEDBACK_EVENT));
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) {
    throw new Error('Copy failed');
  }
  window.dispatchEvent(new CustomEvent(COPY_FEEDBACK_EVENT));
}

export function readAssistantFeedback(messageId: string): AssistantFeedbackRating | null {
  try {
    const raw = window.localStorage.getItem(ASSISTANT_FEEDBACK_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const records = JSON.parse(raw);
    if (!Array.isArray(records)) {
      return null;
    }
    const record = [...records]
      .reverse()
      .find(
        (item): item is AssistantFeedbackRecord =>
          Boolean(
            item &&
              typeof item === 'object' &&
              (item as AssistantFeedbackRecord).messageId === messageId &&
              ((item as AssistantFeedbackRecord).rating === 'up' ||
                (item as AssistantFeedbackRecord).rating === 'down'),
          ),
      );
    return record?.rating ?? null;
  } catch {
    return null;
  }
}

export function recordAssistantFeedback(
  message: ChatMessage,
  rating: AssistantFeedbackRating | null,
) {
  const messageId = message.id.trim();
  if (!messageId) {
    return;
  }
  try {
    const raw = window.localStorage.getItem(ASSISTANT_FEEDBACK_STORAGE_KEY);
    const previous = raw ? JSON.parse(raw) : [];
    const records = Array.isArray(previous)
      ? previous.filter(
          (item) =>
            !(
              item &&
              typeof item === 'object' &&
              (item as AssistantFeedbackRecord).messageId === messageId
            ),
        )
      : [];
    if (rating) {
      records.push({
        messageId,
        conversationId: message.conversationId,
        turnId: message.turnId,
        rating,
        contentPreview: truncateText(message.content.trim(), 600),
        createdAt: new Date().toISOString(),
      } satisfies AssistantFeedbackRecord);
    }
    window.localStorage.setItem(
      ASSISTANT_FEEDBACK_STORAGE_KEY,
      JSON.stringify(records.slice(-500)),
    );
    window.dispatchEvent(
      new CustomEvent(ASSISTANT_FEEDBACK_EVENT, {
        detail: { messageId, rating },
      }),
    );
  } catch {
    // Feedback is best-effort and should never disrupt the chat UI.
  }
}
