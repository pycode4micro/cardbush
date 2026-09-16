import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage } from '../../types';

const transcriptCommitIntervalMs = 500;

/** A bounded display buffer, not an event queue. Runtime state and user actions
 * keep their original timing; one paint receives the newest complete snapshot. */
export function useBatchedTranscript(
  messages: ChatMessage[],
  sessionId: string,
  turnId: string,
  active: boolean,
  urgent = false,
  delivery: 'batched' | 'frame' = 'frame',
) {
  const scope = useMemo(() => {
    let userId = '';
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index].role === 'user') {
        userId = messages[index].id;
        break;
      }
    }
    return JSON.stringify([sessionId, turnId, userId]);
  }, [messages, sessionId, turnId]);
  const [visible, setVisible] = useState(() => ({ scope, messages }));
  // Text is already paced by the stream queue. Keep the existing 500ms tool-only
  // batching, but never make a new text frame wait behind it.
  const immediate = !active || urgent || (delivery === 'frame' && textFrameChanged(visible.messages, messages));
  const latest = useRef({ scope, messages });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useLayoutEffect(() => {
    latest.current = { scope, messages };
    if (immediate || visible.scope !== scope) {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      if (visible.scope !== scope || visible.messages !== messages) {
        setVisible(latest.current);
      }
    } else if (messages !== visible.messages && timer.current === null) {
      // Do not reset on every event: even a continuous stream commits within
      // one interval, and a short queued/running/completed burst commits once.
      timer.current = setTimeout(() => {
        timer.current = null;
        setVisible(latest.current);
      }, transcriptCommitIntervalMs);
    }
  }, [immediate, messages, scope, visible]);

  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  // Never paint the previous conversation/turn or leave a stopped turn stale
  // while waiting for an effect. The layout effect also cancels its timer.
  return immediate || visible.scope !== scope ? messages : visible.messages;
}

function textFrameChanged(previous: ChatMessage[], next: ChatMessage[]) {
  if (previous === next) return false;
  const textMessages = (messages: ChatMessage[]) => messages.filter(message =>
    message.role === 'assistant' && (message.content || message.metadata?.segment_complete));
  const before = textMessages(previous), after = textMessages(next);
  if (before.length !== after.length) return true;
  return after.some((message, index) => {
    const old = before[index];
    return message.id !== old.id || message.content !== old.content ||
      message.metadata?.segment_complete !== old.metadata?.segment_complete ||
      message.metadata?.assistant_segment_id !== old.metadata?.assistant_segment_id;
  });
}
