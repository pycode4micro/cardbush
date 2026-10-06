import { useCallback, useLayoutEffect, useMemo, useRef, type RefObject } from 'react';
import { useConversationComposerLayout } from '../chat/useConversationComposerLayout';
import { useScrollBottomPresence } from '../../hooks/useScrollBottomPresence';
import { createChatScrollMotion } from '../chat/chatScrollMotion';
import { PERSONAL_ASSISTANT_SESSION } from '@cardbush/bush-protocol';

/** Keep assistant's bubble renderer on the same composer geometry and scroll controls. */
export function useAssistantViewport({ active, bodyRef, dockRef, scrollerRef, revision, portaled }: {
  active: boolean; bodyRef: RefObject<HTMLDivElement | null>; dockRef: RefObject<HTMLDivElement | null>;
  scrollerRef: RefObject<HTMLDivElement | null>; revision: string | undefined; portaled: boolean;
}) {
  const layout = useConversationComposerLayout({ bodyRef, dockRef, scrollerRef, scope: PERSONAL_ASSISTANT_SESSION,
    welcome: false, loading: !active || portaled, embedded: false, interaction: false });
  const following = useRef(true), followTail = useRef(false), motion = useMemo(createChatScrollMotion, []);
  const followTarget = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return 0;
    const bottom = scroller.scrollHeight - scroller.clientHeight;
    if (followTail.current) return bottom;
    const rows = Array.from(scroller.querySelectorAll<HTMLElement>('.assistant-message-row'));
    let userIndex = rows.length - 1;
    while (userIndex >= 0 && rows[userIndex].dataset.messageRole !== 'user') userIndex--;
    const answer = rows.slice(userIndex + 1).find(row => row.dataset.messageRole === 'assistant');
    const last = rows.at(-1), content = scroller.querySelector<HTMLElement>('.message-list-content');
    if (!answer || !last || !content) return bottom;
    const viewport = scroller.getBoundingClientRect(), scale = viewport.height / scroller.clientHeight || 1;
    const answerRect = answer.getBoundingClientRect();
    const inset = parseFloat(getComputedStyle(content).paddingBottom) || 0;
    const available = Math.max(0, scroller.clientHeight - inset - 16);
    // Short results can be shown in full, even when the question itself is huge.
    // A long or multi-part reply starts at its beginning, keeping a small question
    // above it when that still leaves most of the viewport for the answer.
    if ((last.getBoundingClientRect().bottom - answerRect.top) / scale <= available) return bottom;
    const question = rows[userIndex]?.getBoundingClientRect();
    const start = question && (answerRect.top - question.top) / scale <= Math.min(160, available / 4)
      ? question.top : answerRect.top;
    return Math.min(bottom, Math.max(0, scroller.scrollTop + (start - viewport.top) / scale - 16));
  }, [scrollerRef]);
  const scrollBottomVisible = useScrollBottomPresence({ scrollerRef, scope: PERSONAL_ASSISTANT_SESSION,
    requestedVisible: true, enabled: active });
  const scrollToBottom = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    following.current = true;
    followTail.current = true;
    scroller.focus({ preventScroll: true });
    motion.move(scroller, () => scroller.scrollHeight - scroller.clientHeight, 'jump');
  }, [motion, scrollerRef]);
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!active || !scroller) return;
    // Content growth and native scroll anchoring also emit scroll events. Only
    // user navigation detaches following; layout alone must not cancel it.
    const scroll = () => {
      if (!following.current && !motion.isActive() && scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop < 2) {
        following.current = true; followTail.current = true;
      }
    };
    const detach = () => { motion.cancel(); following.current = false; };
    const key = (event: KeyboardEvent) => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) detach(); };
    scroller.addEventListener('scroll', scroll, { passive: true });
    scroller.addEventListener('wheel', detach, { passive: true });
    scroller.addEventListener('pointerdown', detach);
    scroller.addEventListener('keydown', key);
    return () => {
      motion.cancel(); scroller.removeEventListener('scroll', scroll); scroller.removeEventListener('wheel', detach);
      scroller.removeEventListener('pointerdown', detach); scroller.removeEventListener('keydown', key);
    };
  }, [active, motion, scrollerRef]);
  useLayoutEffect(() => {
    const body = bodyRef.current, dock = dockRef.current, scroller = scrollerRef.current;
    const content = scroller?.querySelector<HTMLElement>('.message-list-content');
    if (!active || !body || !dock || !scroller || !content) return;
    const measure = () => {
      const surface = dock.querySelector<HTMLElement>('.composer-surface');
      const bounds = body.getBoundingClientRect(), rect = surface?.getBoundingClientRect();
      if (!bounds.height) return;
      if (rect) {
        const scaleY = bounds.height / body.clientHeight || 1, scaleX = bounds.width / body.clientWidth || 1;
        body.style.setProperty('--composer-content-top', `${(rect.top - bounds.top) / scaleY}px`);
        body.style.setProperty('--composer-surface-center-x', `${(rect.left + rect.width / 2 - bounds.left) / scaleX}px`);
      }
      body.style.setProperty('--message-list-scrollbar-inset', `${Math.max(0, scroller.offsetWidth - scroller.clientWidth)}px`);
      content.style.paddingBottom = `${portaled || layout.anchored ? 32 : dock.offsetHeight + 16}px`;
      if (following.current && !layout.anchored) motion.move(scroller, followTarget, 'follow');
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const node of [body, dock, content]) observer.observe(node);
    return () => observer.disconnect();
  }, [active, bodyRef, dockRef, scrollerRef, layout.anchored, motion, portaled, followTarget]);
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!revision) { following.current = true; followTail.current = false; }
    if (active && following.current && scroller && !layout.anchored) motion.move(scroller, followTarget, 'follow');
  }, [active, revision, layout.anchored, motion, scrollerRef, followTarget]);
  return { ...layout, scrollBottomVisible, scrollToBottom,
    prepareSend: () => { layout.capture(true); following.current = true; followTail.current = false; } };
}
