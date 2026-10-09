import { useCallback, useLayoutEffect, useMemo, useRef, type RefObject } from 'react';
import { useConversationComposerLayout } from '../chat/useConversationComposerLayout';
import { useScrollBottomPresence } from '../../hooks/useScrollBottomPresence';
import { createChatScrollMotion } from '../chat/chatScrollMotion';
import { scrollDebug } from '../chat/scrollDebug';
import { suspendScrollAnchoring } from '../scrollAnchoring';
import { PERSONAL_ASSISTANT_SESSION } from '@cardbush/bush-protocol';

/** Keep assistant's bubble renderer on the same composer geometry and scroll controls. */
export function useAssistantViewport({ active, bodyRef, dockRef, scrollerRef, revision, portaled }: {
  active: boolean; bodyRef: RefObject<HTMLDivElement | null>; dockRef: RefObject<HTMLDivElement | null>;
  scrollerRef: RefObject<HTMLDivElement | null>; revision: string | undefined; portaled: boolean;
}) {
  const layout = useConversationComposerLayout({ bodyRef, dockRef, scrollerRef, scope: PERSONAL_ASSISTANT_SESSION,
    welcome: false, loading: !active || portaled, embedded: false, interaction: false });
  const following = useRef(true), followTail = useRef(false), motion = useMemo(createChatScrollMotion, []);
  const previousRevision = useRef(revision);
  const anchoring = useRef<{ frame: number; release(): void } | null>(null);
  const state = useRef({ revision, anchored: layout.anchored });
  state.current = { revision, anchored: layout.anchored };
  const trace = useCallback((reason: string, detail: Record<string, unknown> = {}) => {
    const scroller = scrollerRef.current;
    scrollDebug('assistant-viewport', { reason, following: following.current, followTail: followTail.current,
      ...state.current, scrollTop: scroller?.scrollTop, scrollHeight: scroller?.scrollHeight,
      clientHeight: scroller?.clientHeight, ...detail });
  }, [scrollerRef]);
  const followTarget = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return 0;
    const bottom = scroller.scrollHeight - scroller.clientHeight;
    if (followTail.current) return bottom;
    const rows = Array.from(scroller.querySelectorAll<HTMLElement>('.assistant-message-row'));
    let userIndex = rows.length - 1;
    while (userIndex >= 0 && rows[userIndex].dataset.messageRole !== 'user') userIndex--;
    const answer = rows.slice(userIndex + 1).reverse().find(row => row.dataset.messageRole === 'assistant');
    const last = rows.at(-1), content = scroller.querySelector<HTMLElement>('.message-list-content');
    if (!answer || !last || !content) return bottom;
    const viewport = scroller.getBoundingClientRect(), scale = viewport.height / scroller.clientHeight || 1;
    const answerRect = answer.getBoundingClientRect();
    const inset = parseFloat(getComputedStyle(content).paddingBottom) || 0;
    const available = Math.max(0, scroller.clientHeight - inset - 16);
    // Short results can be shown in full, even when the question itself is huge.
    // Follow the newest bubble, not the combined height of every answer in a
    // turn. Background tasks can publish a short conclusion after a long page.
    // Keep a nearby question above a long answer when enough reading space remains.
    if ((last.getBoundingClientRect().bottom - answerRect.top) / scale <= available) return bottom;
    const question = rows[userIndex]?.getBoundingClientRect();
    const start = question && (answerRect.top - question.top) / scale <= Math.min(160, available / 4)
      ? question.top : answerRect.top;
    return Math.min(bottom, Math.max(0, scroller.scrollTop + (start - viewport.top) / scale - 16));
  }, [scrollerRef]);
  const scrollBottomVisible = useScrollBottomPresence({ scrollerRef, scope: PERSONAL_ASSISTANT_SESSION,
    requestedVisible: true, enabled: active });
  const releaseAnchoring = useCallback(() => {
    if (!anchoring.current) return;
    cancelAnimationFrame(anchoring.current.frame); anchoring.current.release(); anchoring.current = null;
  }, []);
  const reveal = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !following.current || layout.anchored) return;
    motion.cancel(); releaseAnchoring();
    const release = suspendScrollAnchoring(scroller), target = followTarget();
    scroller.scrollTo({ top: target, behavior: 'instant' });
    trace('revealed', { target });
    anchoring.current = { frame: requestAnimationFrame(releaseAnchoring), release };
  }, [scrollerRef, layout.anchored, motion, releaseAnchoring, followTarget, trace]);
  useLayoutEffect(() => releaseAnchoring, [active, releaseAnchoring]);
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
        trace('reached-bottom');
      }
    };
    const detach = (reason: string) => { motion.cancel(); releaseAnchoring(); following.current = false; trace(reason); };
    const atBottom = () => scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop < 2;
    const wheel = (event: WheelEvent) => {
      if (!event.defaultPrevented && !event.ctrlKey && event.deltaY && !(event.deltaY > 0 && atBottom())) detach('wheel');
    };
    let pointer: { id: number; x: number; y: number; touch: boolean } | undefined;
    const down = (event: PointerEvent) => {
      pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, touch: event.pointerType === 'touch' };
      const rect = scroller.getBoundingClientRect(), scale = rect.width / scroller.offsetWidth || 1;
      const scrollbar = event.target === scroller && event.clientX >= rect.left + scroller.clientWidth * scale;
      if (scrollbar || event.button === 1) detach(scrollbar ? 'scrollbar' : 'autoscroll');
    };
    const move = (event: PointerEvent) => {
      if (!pointer || event.pointerId !== pointer.id || Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) < 6) return;
      if (!pointer.touch && event.buttons !== 1) return;
      if (pointer.touch || window.getSelection()?.type === 'Range') { detach(pointer.touch ? 'touch-scroll' : 'selection'); pointer = undefined; }
    };
    const up = () => { pointer = undefined; scroll(); };
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey ||
        event.target instanceof Element && event.target.closest('input, textarea, select, button, a, [contenteditable="true"]')) return;
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key) &&
        !(atBottom() && ['ArrowDown', 'PageDown', 'End', ' '].includes(event.key) && !event.shiftKey)) detach('keyboard');
    };
    scroller.addEventListener('scroll', scroll, { passive: true });
    scroller.addEventListener('wheel', wheel, { passive: true });
    scroller.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    window.addEventListener('blur', up);
    scroller.addEventListener('keydown', key);
    return () => {
      motion.cancel(); scroller.removeEventListener('scroll', scroll); scroller.removeEventListener('wheel', wheel);
      scroller.removeEventListener('pointerdown', down); scroller.removeEventListener('keydown', key);
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
      window.removeEventListener('blur', up);
    };
  }, [active, motion, releaseAnchoring, scrollerRef, trace]);
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
      trace('measure', { paddingBottom: content.style.paddingBottom });
      // Markdown mounts and image dimensions may settle after the entry itself.
      // Complete that positioning before paint too, instead of animating a
      // partly hidden bubble out from underneath the composer.
      reveal();
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const node of [body, dock, content]) observer.observe(node);
    return () => observer.disconnect();
  }, [active, bodyRef, dockRef, scrollerRef, layout.anchored, portaled, trace, reveal]);
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!revision) { following.current = true; followTail.current = false; }
    if (!active || !scroller) return;
    // Publish a newly received bubble in view before paint. The observer follows
    // later Markdown/image measurements; deliberate history reading stays put.
    if (previousRevision.current !== revision) followTail.current = false;
    previousRevision.current = revision;
    trace('revision', { action: following.current && !layout.anchored ? 'reveal' : 'preserve' });
    reveal();
  }, [active, revision, layout.anchored, scrollerRef, trace, reveal]);
  return { ...layout, scrollBottomVisible, scrollToBottom,
    prepareSend: () => { layout.capture(true); following.current = true; followTail.current = false; } };
}
