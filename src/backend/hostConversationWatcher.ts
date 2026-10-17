import type { QueuedChatMessage } from '../hooks/useCardbushChat';
export interface HostConversationStatus { activeTurnId?: string; revision: string }
export interface HostConversationWatchState extends HostConversationStatus {
  queued: QueuedChatMessage[];
  queueState?: { locked: boolean; revision: number };
}

/** Same UI subscription contract as service jobs/subagents; never drives model execution. */
export function watchHostConversation(
  read: (signal: AbortSignal) => Promise<HostConversationStatus>,
  listener: (state: HostConversationWatchState) => void,
  onError: (error: unknown) => void,
  dispose: () => void,
  intervalMs = 1200,
) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const poll = async () => {
    try {
      const status = await read(controller.signal);
      if (!controller.signal.aborted) listener({ ...status, queued: [] });
    } catch (error) { if (!controller.signal.aborted) onError(error); }
    finally { if (!controller.signal.aborted) timer = setTimeout(() => void poll(), intervalMs); }
  };
  void poll();
  return () => { controller.abort(); clearTimeout(timer); dispose(); };
}
