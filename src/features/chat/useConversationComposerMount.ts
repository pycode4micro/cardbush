import { useCallback, useLayoutEffect, useRef, useState } from 'react';

/** One portal container survives the welcome-to-transcript placement change. */
export function useConversationComposerMount(sessionId: string, hostId?: string) {
  const [container] = useState(() => {
    const node = document.createElement('div');
    node.className = 'conversation-composer-mount';
    return node;
  });
  const target = useRef<HTMLElement | null>(null);
  const firstSubmission = useRef<object | null>(null);
  const [settledSubmission, setSettledSubmission] = useState<object | null>(null);
  const identity = useRef({ sessionId, hostId, key: 0 });
  const identityChanged = identity.current.sessionId !== sessionId || identity.current.hostId !== hostId;
  const adoptingFirstSession = firstSubmission.current && !identity.current.sessionId && Boolean(sessionId)
    && identity.current.hostId === hostId;
  const key = identity.current.key + (identityChanged && !adoptingFirstSession ? 1 : 0);
  // Removing the old welcome slot can blur a focused editor even though its
  // React tree survives. Restore only that same editor, before the next paint.
  const focused = document.activeElement instanceof HTMLElement && container.contains(document.activeElement)
    ? document.activeElement : null;
  const attach = useCallback((node: HTMLDivElement | null) => {
    target.current = node;
    if (node && container.parentElement !== node) node.appendChild(container);
  }, [container]);
  useLayoutEffect(() => {
    if (identityChanged) {
      identity.current = { sessionId, hostId, key };
      firstSubmission.current = null;
    }
    if (target.current && container.parentElement !== target.current) target.current.appendChild(container);
    if (focused?.isConnected && document.activeElement === document.body) focused.focus({ preventScroll: true });
  });
  // Acknowledgement and session allocation may be batched into the same
  // render. Keep the adoption token until that render has committed.
  useLayoutEffect(() => {
    if (firstSubmission.current === settledSubmission) firstSubmission.current = null;
  }, [settledSubmission]);
  useLayoutEffect(() => () => container.remove(), [container]);
  const beginSubmission = useCallback(() => {
    const token = !sessionId ? {} : null;
    if (token) firstSubmission.current = token;
    return () => { if (token && firstSubmission.current === token) setSettledSubmission(token); };
  }, [sessionId]);
  return { container, attach, key, beginSubmission };
}
