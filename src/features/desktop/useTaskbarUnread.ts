import { useEffect, useState } from 'react';
import { PERSONAL_ASSISTANT_SESSION } from '@cardbush/bush-protocol';
import { conversationJournalCommand } from '../../backend/conversationJournal';
import { observeAssistantReceipt, readAssistantReceipt, saveAssistantReceipt } from '../assistant/assistantReadReceipt';

type ReplyStatus = { unread: number; generation: number; latest?: { id: string; at: string } };

/** Only the workspace publishes the combined badge. The capsule shares its read position. */
export function useTaskbarUnread(workspaceUnread: number, ready: boolean) {
  const [assistantUnread, setAssistantUnread] = useState(0);
  useEffect(() => {
    const desktop = window.cardbushDesktop;
    if (!ready || !desktop?.onAssistantReplyAdded) return;
    let disposed = false, reading = false, dirty = false;
    const refresh = async () => {
      dirty = true;
      if (reading) return;
      reading = true;
      try {
        while (dirty && !disposed) {
          dirty = false;
          const receipt = readAssistantReceipt();
          const state = await conversationJournalCommand<ReplyStatus>({
            action: 'reply-status', sessionId: PERSONAL_ASSISTANT_SESSION,
            ...(receipt ? { after: { id: receipt.id, at: receipt.at } } : {}),
          });
          if (disposed || dirty) continue;
          if (!receipt && !readAssistantReceipt()) {
            saveAssistantReceipt({ generation: state.generation, id: state.latest?.id ?? '', at: state.latest?.at ?? '' });
          }
          setAssistantUnread(state.unread);
        }
      } catch { /* Keep the last known count during runtime recovery. */ }
      finally { reading = false; }
    };
    const offReply = desktop.onAssistantReplyAdded(refresh);
    const offRead = observeAssistantReceipt(refresh);
    void refresh();
    return () => { disposed = true; offReply(); offRead(); };
  }, [ready]);
  useEffect(() => {
    void window.cardbushDesktop?.setSessionAttentionCount?.(workspaceUnread + assistantUnread).catch(() => undefined);
  }, [workspaceUnread, assistantUnread]);
}
