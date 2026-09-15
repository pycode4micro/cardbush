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
  const immediate = !active || urgent;
  const [visible, setVisible] = useState(() => ({ scope, messages }));
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
