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
  const following = useRef(true), motion = useMemo(createChatScrollMotion, []);
  const scrollBottomVisible = useScrollBottomPresence({ scrollerRef, scope: PERSONAL_ASSISTANT_SESSION,
    requestedVisible: true, enabled: active });
  const scrollToBottom = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    following.current = true;
    scroller.focus({ preventScroll: true });
    motion.move(scroller, () => scroller.scrollHeight - scroller.clientHeight, 'jump');
  }, [motion, scrollerRef]);
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!active || !scroller) return;
    const scroll = () => { if (!motion.isActive()) following.current = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop < 64; };
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
      if (following.current && !layout.anchored) motion.move(scroller, () => scroller.scrollHeight - scroller.clientHeight, 'follow');
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const node of [body, dock, content]) observer.observe(node);
    return () => observer.disconnect();
  }, [active, bodyRef, dockRef, scrollerRef, layout.anchored, motion, portaled]);
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!revision) following.current = true;
    if (active && following.current && scroller && !layout.anchored) motion.move(scroller, () => scroller.scrollHeight - scroller.clientHeight, 'follow');
  }, [active, revision, layout.anchored, motion, scrollerRef]);
  return { ...layout, scrollBottomVisible, scrollToBottom,
    prepareSend: () => { layout.capture(true); following.current = true; } };
}
