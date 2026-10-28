import { uiText } from '../i18n';
import type { ChatMessage } from '../types';
import { recordPersonalizationFeedback } from '../backend/personalization';
import { readIndividuation } from './settings/individuation';

export const COPY_FEEDBACK_EVENT = 'cardbush-copy-feedback';
export const ASSISTANT_FEEDBACK_EVENT = 'cardbush-assistant-feedback';

const ASSISTANT_FEEDBACK_STORAGE_KEY = 'cardbush_assistant_feedback';

export type AssistantFeedbackRating = 'up' | 'down';

type AssistantFeedbackRecord = {
  messageId: string;
  conversationId?: string;
  turnId?: string;
  rating: AssistantFeedbackRating;
  memorySaved?: boolean;
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
    throw new Error(uiText()('messageFeedback.copy_failed'));
  }
  window.dispatchEvent(new CustomEvent(COPY_FEEDBACK_EVENT));
}

export function assistantFeedbackKey(message:ChatMessage,connectionId=''):string {
  const sourceId=message.messageId||message.assistantMessageId||String(message.metadata?.message_id||'')||message.id;
  return JSON.stringify([connectionId,message.conversationId??'',message.turnId??'',sourceId]);
}

export function readAssistantFeedback(messageId: string, legacyId?:string): AssistantFeedbackRating | null {
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
              ((item as AssistantFeedbackRecord).messageId === messageId || Boolean(legacyId && (item as AssistantFeedbackRecord).messageId === legacyId)) &&
              ((item as AssistantFeedbackRecord).rating === 'up' ||
                (item as AssistantFeedbackRecord).rating === 'down'),
          ),
      );
    return record?.rating ?? null;
  } catch {
    return null;
  }
}

const pendingFeedback=new Map<string,Promise<void>>();

export function recordAssistantFeedback(
  message: ChatMessage,
  rating: AssistantFeedbackRating | null,
  options:{connectionId?:string;legacyId?:string;memoryAvailable?:boolean}={},
):Promise<void> {
  const messageId=assistantFeedbackKey(message,options.connectionId);
  const operation=(pendingFeedback.get(messageId)??Promise.resolve()).catch(()=>{}).then(async()=>{
    let records:AssistantFeedbackRecord[]=[];
    try { const value=JSON.parse(window.localStorage.getItem(ASSISTANT_FEEDBACK_STORAGE_KEY)??'[]');if(Array.isArray(value))records=value; } catch { /* Legacy cache is optional. */ }
    const previous=records.find(item=>item?.messageId===messageId||Boolean(options.legacyId&&item?.messageId===options.legacyId));
    const settings=readIndividuation();
    let memorySaved=false;
    if(options.memoryAvailable!==false&&(settings.habits||previous?.memorySaved)) {
      const result=await recordPersonalizationFeedback({sessionId:message.conversationId??'',turnId:message.turnId??'',
        messageId:message.messageId||message.assistantMessageId||String(message.metadata?.message_id||'')||message.id,
        // Disabling habits does not prevent explicitly withdrawing a previously recorded vote.
        rating:settings.habits?rating:null},settings,crypto.randomUUID(),options.connectionId);
      if(result.status!=='ok')throw new Error(result.reason??result.status);
      memorySaved=settings.habits&&rating!==null;
    }
    // Read again: unrelated messages may have been rated while the host was saving.
    try { const value=JSON.parse(window.localStorage.getItem(ASSISTANT_FEEDBACK_STORAGE_KEY)??'[]');if(Array.isArray(value))records=value; } catch { /* Keep the available cache. */ }
    records=records.filter(item=>item?.messageId!==messageId&&item?.messageId!==options.legacyId);
    if(rating)records.push({messageId,conversationId:message.conversationId,turnId:message.turnId,rating,memorySaved,createdAt:new Date().toISOString()});
    try { window.localStorage.setItem(ASSISTANT_FEEDBACK_STORAGE_KEY,JSON.stringify(records.slice(-500))); } catch { /* The host receipt remains authoritative. */ }
    window.dispatchEvent(new CustomEvent(ASSISTANT_FEEDBACK_EVENT,{detail:{messageId,rating}}));
  });
  pendingFeedback.set(messageId,operation);
  void operation.finally(()=>{if(pendingFeedback.get(messageId)===operation)pendingFeedback.delete(messageId);}).catch(()=>{});
  return operation;
}
