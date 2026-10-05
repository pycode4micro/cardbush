import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';
import { useComponents } from '../components/componentStore';
import { welcomeComposerFlow } from '../components/componentModel';
import { composerHorizontalBounds, composerVerticalBounds } from '../components/composerLayoutGeometry';
import { welcomeHeightScale } from '../components/welcomeViewportGeometry';

const edge = 12, gap = 16;
type Anchor = { y: number; viewportHeight: number; docked?: boolean; documentY?: number; belowStart?: number; submission?: string };
type Clearance = { node: HTMLElement; padding: string; priority: string };
const conversationAnchors = new Map<string, { configKey: string; anchor: Anchor }>();

// Keep a single transcript and a single composer. Only their presentation
// geometry changes; no messages, markdown, inputs or event handlers are cloned.
export function useConversationComposerLayout({ bodyRef, dockRef, scrollerRef, scope, welcome, loading, embedded, interaction }: {
  bodyRef: RefObject<HTMLDivElement | null>; dockRef: RefObject<HTMLDivElement | null>;
  scrollerRef: RefObject<HTMLElement | null>; scope: string; welcome: boolean; loading: boolean; embedded: boolean; interaction: boolean;
}) {
  const collection = useComponents(), flow = welcomeComposerFlow(collection);
  const placement = collection.welcomeLayout?.items.find(item => item.componentId === 'system-input');
  const referenceHeight = collection.welcomeLayout?.viewportHeight;
  const anchored = !embedded && (flow.afterSend === 'keep' || flow.output === 'below');
  const configKey = JSON.stringify([flow, placement?.y, placement?.width, placement?.composerDock, referenceHeight]);
  const anchors = useRef(conversationAnchors);
  const pending = useRef<{ scope: string; configKey: string; anchor: Anchor } | null>(null), clearance = useRef<Clearance | null>(null);
  const departure = useRef<{ scope: string; configKey: string; y: number } | null>(null);
  const motion = useRef<Animation | null>(null);
  const pendingBottom = useRef<{ scope: string; count: number } | null>(null);
  const geometry = useRef({ y: 0, height: 0 });

  const clear = useCallback(() => {
    const saved = clearance.current;
    if (!saved) return;
    if (saved.padding) saved.node.style.setProperty('padding-top', saved.padding, saved.priority);
    else saved.node.style.removeProperty('padding-top');
    delete saved.node.dataset.composerClearance;
    clearance.current = null;
  }, []);
  const capture = useCallback((newTurn: boolean) => {
    if (embedded || !newTurn) return;
    if (!welcome) {
      if (flow.afterSend === 'bottom' && flow.output === 'below') pendingBottom.current = {
        scope, count: scrollerRef.current?.querySelectorAll('[data-message-role="user"]').length ?? 0,
      };
      return;
    }
    const body = bodyRef.current, input = body?.querySelector<HTMLElement>('.welcome-slot-input .composer-stack');
    if (!body || !input) return;
    const bounds = body.getBoundingClientRect(), rect = input.getBoundingClientRect();
    if (!bounds.width || !body.clientHeight) return;
    const scale = bounds.height / body.clientHeight || 1;
    const anchor: Anchor = { y: (rect.top - bounds.top) / scale, viewportHeight: body.clientHeight,
      docked: input.closest<HTMLElement>('.welcome-slot-input')?.dataset.composerDocked === 'true' };
    if (flow.afterSend === 'bottom') { departure.current = { scope, configKey, y: anchor.y }; return; }
    pending.current = { scope, configKey, anchor };
    anchors.current.set(scope, { configKey, anchor });
  }, [embedded, flow.afterSend, flow.output, welcome, bodyRef, scrollerRef, scope, configKey]);

  const animateArrival = useCallback(() => {
    const start = departure.current, body = bodyRef.current, dock = dockRef.current;
    if (!start || !body || !dock) return;
    departure.current = null;
    // New conversations can acquire their persisted ID during the send. The
    // one pending departure is consumed by the first mounted conversation dock.
    if (start.configKey !== configKey || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const input = dock.querySelector<HTMLElement>('.composer-stack');
    if (!input) return;
    const rect = body.getBoundingClientRect(), scale = rect.height / body.clientHeight || 1;
    const distance = (input.getBoundingClientRect().top - rect.top) / scale - start.y;
    const { minimumTravel } = composerVerticalBounds(body.clientHeight, input.offsetHeight, start.y, 'bottom');
    if (distance < minimumTravel - 1) return;
    motion.current?.cancel();
    motion.current = dock.animate([{ transform: `translateY(${-distance}px)` }, { transform: 'translateY(0)' }],
      { duration: 240, easing: 'cubic-bezier(.2,.7,.2,1)' });
  }, [bodyRef, dockRef, configKey]);

  const position = useCallback(() => {
    const body = bodyRef.current, dock = dockRef.current, scroller = scrollerRef.current;
    if (!anchored || !body || !dock || !scroller || dock.classList.contains('interaction-only')) return;
    const top = Math.max(edge, geometry.current.y - scroller.scrollTop);
    body.style.setProperty('--flow-composer-top', `${top}px`);
    const bounds = body.getBoundingClientRect(), rect = dock.getBoundingClientRect();
    const scale = bounds.height / body.clientHeight || 1;
    body.style.setProperty('--composer-content-top', `${(rect.top - bounds.top) / scale}px`);
    body.style.setProperty('--composer-surface-top', `${(rect.top - bounds.top) / scale}px`);
    body.style.setProperty('--composer-surface-center-x', `${(rect.left + rect.width / 2 - bounds.left) / (bounds.width / body.clientWidth || 1)}px`);
    scroller.style.scrollPaddingTop = `${top + geometry.current.height + gap}px`;
  }, [anchored, bodyRef, dockRef, scrollerRef]);

  const refresh = useCallback(() => {
    const body = bodyRef.current, dock = dockRef.current, scroller = scrollerRef.current;
    if (welcome || loading || !body || !dock || !scroller) { clear(); return; }
    // Confirmation cards keep their existing bottom placement. Retain the last
    // input clearance until the normal composer returns, avoiding transcript jumps.
    if (dock.classList.contains('interaction-only')) return;
    const content = scroller.querySelector<HTMLElement>('.message-list-content');
    if (!content || !scroller.clientWidth || !scroller.clientHeight) return;
    const contentStyle = getComputedStyle(content);
    const summaryInset = Math.max(0, parseFloat(contentStyle.marginRight) || 0);
    const height = scroller.clientHeight;
    if (!embedded) {
      // Without a custom width, use the same available track as the transcript,
      // including its gutters and scrollbar when a summary column is docked.
      const readingWidth = Math.max(0, content.clientWidth - (parseFloat(contentStyle.paddingLeft) || 0) - (parseFloat(contentStyle.paddingRight) || 0));
      const horizontal = composerHorizontalBounds(body.clientWidth, placement?.width,
        Math.min(parseFloat(getComputedStyle(body).getPropertyValue('--chat-track-width')) || 704, readingWidth), body.clientWidth - summaryInset);
      body.style.setProperty('--flow-composer-left', `${horizontal.left}px`);
      body.style.setProperty('--flow-composer-width', `${horizontal.width}px`);
    }
    if (!anchored) {
      clear();
      content.style.removeProperty('padding-top'); content.style.removeProperty('min-height');
      scroller.style.removeProperty('scroll-padding-top');
      animateArrival();
      return;
    }
    const dockHeight = dock.offsetHeight || geometry.current.height || 100;
    const saved = anchors.current.get(scope);
    let anchor = saved?.configKey === configKey ? saved.anchor : null;
    if (!anchor) {
      const vertical = composerVerticalBounds(height, dockHeight, placement ? placement.y * welcomeHeightScale(referenceHeight, height) : undefined,
        flow.afterSend, placement?.composerDock === 'bottom');
      anchor = pending.current?.configKey === configKey ? pending.current.anchor : {
        y: vertical.top, viewportHeight: height, docked: vertical.docked };
      pending.current = null;
      anchors.current.set(scope, { configKey, anchor });
      if (anchors.current.size > 128) anchors.current.delete(anchors.current.keys().next().value!);
    }
    pending.current = null;
    const stack = dock.querySelector<HTMLElement>('.composer-stack');
    const scale = body.getBoundingClientRect().height / body.clientHeight || 1;
    const stackOffset = stack ? (stack.getBoundingClientRect().top - dock.getBoundingClientRect().top) / scale : 0;
    clear();
    const viewport = scroller.getBoundingClientRect(), listScale = viewport.height / height || 1;
    const topOf = (node: HTMLElement) => (node.getBoundingClientRect().top - viewport.top) / listScale + scroller.scrollTop;
    const users = scroller.querySelectorAll<HTMLElement>('[data-message-role="user"]');
    if (anchor.submission && !Array.from(users).some(row => row.dataset.messageId === anchor.submission)) {
      delete anchor.documentY; delete anchor.submission;
    }
    const bottomPending = pendingBottom.current;
    const newSubmission = bottomPending?.scope === scope && users.length > bottomPending.count ? users[users.length - 1] : null;
    if (newSubmission) {
      anchor.documentY = Math.max(scroller.scrollTop + height - dockHeight - 20, topOf(newSubmission));
      anchor.submission = newSubmission.dataset.messageId;
      pendingBottom.current = null;
    }
    const initialY = Math.max(edge, Math.min(Math.max(edge, height - Math.min(dockHeight, height - 2 * edge) - 20),
      flow.afterSend === 'bottom' || anchor.docked ? height - dockHeight - 20 : anchor.y * welcomeHeightScale(anchor.viewportHeight, height) - stackOffset));
    const y = anchor.documentY ?? initialY;
    geometry.current = { y, height: dockHeight };
    if (flow.output === 'below' && !anchor.submission) anchor.belowStart = initialY + dockHeight + gap;
    content.style.paddingTop = `${flow.output === 'below' ? anchor.belowStart : 28}px`;
    content.style.minHeight = `${y + dockHeight + gap}px`;
    const reserve = (target: HTMLElement) => {
      const offset = Math.max(0, y + dockHeight + gap - topOf(target));
      if (!offset) return;
      clearance.current = { node: target, padding: target.style.getPropertyValue('padding-top'), priority: target.style.getPropertyPriority('padding-top') };
      target.style.setProperty('padding-top', `${(parseFloat(getComputedStyle(target).paddingTop) || 0) + offset}px`, 'important');
      target.dataset.composerClearance = String(offset);
    };
    if (flow.output === 'above') {
      const bottomOf = (node: HTMLElement) => (node.getBoundingClientRect().bottom - viewport.top) / listScale + scroller.scrollTop;
      const boundary = y - gap;
      const find = (node: HTMLElement): HTMLElement => {
        // Atomic content moves intact: no cutting lines, code or table rows.
        if (topOf(node) >= boundary || node.matches('p, h1, h2, h3, h4, h5, h6, pre, table, figure, .markdown-table-scroll, .user-bubble, .assistant-message')) return node;
        for (const child of node.children) {
          if (!(child instanceof HTMLElement) || bottomOf(child) <= boundary) continue;
          const style = getComputedStyle(child);
          if (style.position === 'absolute' || style.position === 'fixed' || style.display === 'none' || style.display.startsWith('inline')) continue;
          return find(child);
        }
        return node;
      };
      for (const row of content.querySelectorAll<HTMLElement>('.message-list-item')) {
        if (bottomOf(row) <= boundary) continue;
        reserve(find(row));
        break;
      }
    } else if (anchor.submission) {
      const submission = Array.from(users).find(row => row.dataset.messageId === anchor.submission);
      if (submission) reserve(submission);
    }
    if (newSubmission) {
      // Explicit sending may move the bottom-mode input. Streaming never does.
      scroller.scrollTo({ top: Math.max(0, y + dockHeight + 20 - height), behavior: 'instant' });
    }
    position();
    animateArrival();
  }, [anchored, embedded, welcome, loading, bodyRef, dockRef, scrollerRef, scope, configKey, placement, referenceHeight, flow.afterSend, flow.output, clear, position, animateArrival]);

  useLayoutEffect(() => () => {
    clear();
    motion.current?.cancel(); motion.current = null;
    const content = scrollerRef.current?.querySelector<HTMLElement>('.message-list-content');
    content?.style.removeProperty('padding-top'); content?.style.removeProperty('min-height');
    scrollerRef.current?.style.removeProperty('scroll-padding-top');
  }, [scope, anchored, clear, scrollerRef]);
  // Run before paint, including streamed markdown, so there is no transient overlap.
  useLayoutEffect(() => { refresh(); });
  useLayoutEffect(() => {
    if (embedded || welcome || loading) return;
    const body = bodyRef.current, dock = dockRef.current, scroller = scrollerRef.current;
    if (!body || !dock || !scroller) return;
    let frame: number | null = null;
    const schedule = () => { if (frame == null) frame = requestAnimationFrame(() => { frame = null; refresh(); }); };
    const observer = new ResizeObserver(schedule);
    for (const element of [body, dock, scroller, scroller.querySelector('.message-list-content')]) if (element) observer.observe(element);
    scroller.addEventListener('scroll', position, { passive: true });
    const wheel = (event: WheelEvent) => {
      if (!anchored || event.defaultPrevented || !(event.target instanceof Element) || !dock.contains(event.target)) return;
      let node: Element | null = event.target;
      while (node && node !== dock) {
        if (node instanceof HTMLElement && node.scrollHeight > node.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(node).overflowY)
          && (event.deltaY < 0 ? node.scrollTop > 0 : node.scrollTop + node.clientHeight < node.scrollHeight - 1)) return;
        node = node.parentElement;
      }
      event.preventDefault();
      scroller.scrollBy({ top: event.deltaY * (event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? scroller.clientHeight : 1), behavior: 'instant' });
    };
    body.addEventListener('wheel', wheel, { passive: false });
    return () => { observer.disconnect(); scroller.removeEventListener('scroll', position); body.removeEventListener('wheel', wheel); if (frame != null) cancelAnimationFrame(frame); };
  }, [anchored, embedded, welcome, loading, scope, refresh, position, bodyRef, dockRef, scrollerRef, interaction]);
  return { anchored, flow, capture };
}
