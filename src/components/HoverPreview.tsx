import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type PointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './hover-preview.css';

/** Delayed previews share one interaction policy; they never fetch or steal focus. */
export function useHoverPreview(disabled = false) {
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
    if (action && action !== event.currentTarget) { close(); return; }
    requestOpen(event.currentTarget);
  }, [close, requestOpen]);
  const focus = useCallback((event: FocusEvent<HTMLElement>) => {
    if (event.target === event.currentTarget && event.currentTarget.matches(':focus-visible')) requestOpen(event.currentTarget);
    else close();
  }, [close, requestOpen]);
  useEffect(() => { if (disabled) close(); }, [close, disabled]);
  useEffect(() => () => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
  }, []);
  return { id, anchor, close, dismiss, keepOpen, leave, triggerProps: {
    onPointerEnter: pointer, onPointerMove: pointer, onPointerLeave: leave,
    onFocus: focus, onBlur: leave, onPointerDown: dismiss,
    'aria-describedby': anchor ? id : undefined,
  } };
}

export function HoverPreview({ preview, className = '', boundarySelector, children }: {
  preview: ReturnType<typeof useHoverPreview>;
  className?: string;
  boundarySelector?: string;
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
      const bounds = element.getBoundingClientRect(), right = trigger.right + 12;
      const left = right + bounds.width <= area.right - 12 ? right : trigger.left - bounds.width - 12;
      element.style.left = `${Math.max(area.left + 12, Math.min(area.right - bounds.width - 12, left))}px`;
      element.style.top = `${Math.max(area.top + 12, Math.min(area.bottom - bounds.height - 12, trigger.top + trigger.height / 2 - bounds.height / 2))}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(anchor);
    if (boundary) observer.observe(boundary);
    return () => observer.disconnect();
  }, [anchor, boundarySelector, children, close]);
  useEffect(() => {
    if (!anchor) return;
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    document.addEventListener('pointerdown', close, true);
    document.addEventListener('keydown', key, true);
    document.addEventListener('visibilitychange', close);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', close, true);
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('visibilitychange', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [anchor, close]);
  if (!anchor) return null;
  return createPortal(<div ref={node} id={preview.id} popover="manual" role="tooltip"
    className={`hover-preview ${className}`} onPointerEnter={preview.keepOpen} onPointerLeave={preview.leave}>
    {children}
  </div>, anchor.closest('.app, .cardling-desktop') ?? document.body);
}
