import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type PointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './hover-preview.css';

/** Delayed previews share one interaction policy; they never fetch or steal focus. */
export function useHoverPreview(disabled = false, { interactive = false }: { interactive?: boolean } = {}) {
  const id = useId();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const pending = useRef<HTMLElement | null>(null);
  const dismissed = useRef<HTMLElement | null>(null);
  const openTimer = useRef(0), closeTimer = useRef(0);
  const close = useCallback(() => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
    pending.current = null;
    setAnchor(null);
  }, []);
  const keepOpen = useCallback(() => window.clearTimeout(closeTimer.current), []);
  const open = useCallback((element: HTMLElement) => {
    if (disabled || !element.isConnected || element.closest('[inert]')) return;
    window.clearTimeout(openTimer.current); window.clearTimeout(closeTimer.current);
    pending.current = null; dismissed.current = null; setAnchor(element);
  }, [disabled]);
  const dismiss = useCallback(() => { dismissed.current = anchor ?? pending.current; close(); }, [anchor, close]);
  const leave = useCallback(() => {
    dismissed.current = null;
    window.clearTimeout(openTimer.current);
    pending.current = null;
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(close, 120);
  }, [close]);
  const requestOpen = useCallback((element: HTMLElement) => {
    keepOpen();
    if (disabled || dismissed.current === element || anchor === element || pending.current === element) return;
    pending.current = element;
    window.clearTimeout(openTimer.current);
    openTimer.current = window.setTimeout(() => {
      pending.current = null;
      if (element.isConnected && !element.closest('[inert]')) setAnchor(element);
    }, 280);
  }, [anchor, disabled, keepOpen]);
  const pointer = useCallback((event: PointerEvent<HTMLElement>) => {
    if (event.pointerType === 'touch' || event.buttons) return;
    const action = event.target instanceof Element
      ? event.target.closest('button, input, textarea, [contenteditable="true"]') : null;
    if (action && action !== event.currentTarget) {
      // An open interactive card must remain reachable across the row's actions.
      // Hovering an action alone still does not open it; pointerdown dismisses it.
      if (interactive && anchor === event.currentTarget) keepOpen();
      else close();
      return;
    }
    requestOpen(event.currentTarget);
  }, [anchor, close, interactive, keepOpen, requestOpen]);
  const focus = useCallback((event: FocusEvent<HTMLElement>) => {
    if (event.target === event.currentTarget && event.currentTarget.matches(':focus-visible')) requestOpen(event.currentTarget);
    else close();
  }, [close, requestOpen]);
  useEffect(() => { if (disabled) close(); }, [close, disabled]);
  useEffect(() => () => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
  }, []);
  return { id, anchor, open, close, dismiss, keepOpen, leave, triggerProps: {
    onPointerEnter: pointer, onPointerMove: pointer, onPointerLeave: leave,
    onFocus: focus, onBlur: leave, onPointerDown: dismiss,
    'aria-describedby': anchor ? id : undefined,
  } };
}

export function HoverPreview({ preview, className = '', boundarySelector, interactiveLabel, placement = 'side', children }: {
  preview: ReturnType<typeof useHoverPreview>;
  className?: string;
  boundarySelector?: string;
  interactiveLabel?: string;
  placement?: 'side' | 'top';
  children: ReactNode;
}) {
  const node = useRef<HTMLDivElement>(null);
  const { anchor, dismiss: close } = preview;
  useLayoutEffect(() => {
    const element = node.current;
    if (!anchor || !element) return;
    if (!element.matches(':popover-open')) element.showPopover?.();
    const boundary = boundarySelector ? anchor.closest(boundarySelector) : null;
    const position = () => {
      const trigger = anchor.getBoundingClientRect();
      if (!anchor.isConnected || !trigger.width || !trigger.height) { close(); return; }
      const area = boundary?.getBoundingClientRect() ?? { left: 0, right: innerWidth, top: 0, bottom: innerHeight };
      element.style.maxWidth = `${Math.max(0, Math.min(innerWidth, area.right) - Math.max(0, area.left) - 24)}px`;
      const bounds = element.getBoundingClientRect();
      if (placement === 'top') {
        const above = trigger.top - bounds.height - 8;
        const top = above >= area.top + 12 ? above : trigger.bottom + 8;
        const positionedTop = Math.max(area.top + 12, Math.min(area.bottom - bounds.height - 12, top));
        element.style.left = `${Math.max(area.left + 12, Math.min(area.right - bounds.width - 12, trigger.left + (trigger.width - bounds.width) / 2))}px`;
        element.style.top = `${positionedTop}px`;
        const gap = positionedTop >= trigger.bottom ? positionedTop - trigger.bottom : trigger.top - positionedTop - bounds.height;
        element.dataset.side = gap < 0 ? 'overlap' : positionedTop >= trigger.bottom ? 'bottom' : 'top';
        element.style.setProperty('--hover-preview-gap', `${Math.max(0, gap)}px`);
        return;
      }
      const right = trigger.right + 12;
      const left = right + bounds.width <= area.right - 12 ? right : trigger.left - bounds.width - 12;
      const positionedLeft = Math.max(area.left + 12, Math.min(area.right - bounds.width - 12, left));
      element.style.left = `${positionedLeft}px`;
      element.style.top = `${Math.max(area.top + 12, Math.min(area.bottom - bounds.height - 12, trigger.top + trigger.height / 2 - bounds.height / 2))}px`;
      const gap = positionedLeft >= trigger.right ? positionedLeft - trigger.right
        : trigger.left - (positionedLeft + bounds.width);
      element.dataset.side = gap < 0 ? 'overlap' : positionedLeft >= trigger.right ? 'right' : 'left';
      element.style.setProperty('--hover-preview-gap', `${Math.max(0, gap)}px`);
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(anchor);
    if (boundary) observer.observe(boundary);
    return () => observer.disconnect();
  }, [anchor, boundarySelector, children, close, placement]);
  useEffect(() => {
    if (!anchor) return;
    const pointerDown = (event: globalThis.PointerEvent) => {
      if (interactiveLabel && event.target instanceof Node && node.current?.contains(event.target)) return;
      close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (interactiveLabel) { event.preventDefault(); event.stopPropagation(); }
      const restoreFocus = interactiveLabel && node.current?.contains(document.activeElement);
      close();
      if (restoreFocus) anchor.focus({ preventScroll: true });
    };
    const scroll = (event: Event) => {
      // A long preview may scroll internally; only surrounding content moving
      // invalidates its anchor and dismisses it.
      if (event.target instanceof Node && node.current?.contains(event.target)) return;
      close();
    };
    document.addEventListener('pointerdown', pointerDown, true);
    document.addEventListener('keydown', key, true);
    document.addEventListener('visibilitychange', close);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('pointerdown', pointerDown, true);
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('visibilitychange', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', scroll, true);
    };
  }, [anchor, close, interactiveLabel]);
  if (!anchor) return null;
  return createPortal(<div ref={node} id={preview.id} popover="manual" role={interactiveLabel ? 'dialog' : 'tooltip'} aria-label={interactiveLabel}
    className={`hover-preview ${className}`} data-interactive={!!interactiveLabel} onPointerEnter={preview.keepOpen}
    onPointerLeave={() => {
      if (interactiveLabel && node.current?.contains(document.activeElement)) return;
      preview.leave();
    }}
    onFocus={preview.keepOpen}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) preview.leave(); }}>
    {children}
  </div>, anchor.closest('.app, .cardling-desktop') ?? document.body);
}
