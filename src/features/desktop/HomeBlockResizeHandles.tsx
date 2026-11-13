import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import type { HomeDimensions } from './homeLayout';

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const edges = ['right', 'bottom', 'corner'] as const;
type Edge = typeof edges[number];

export function HomeBlockResizeHandles({width, column, height, label, onCommit}: HomeDimensions & {
  width: number; label: string; onCommit(dimensions: HomeDimensions): void;
}) {
  const stop = useRef<() => void>(undefined);
  useEffect(() => () => stop.current?.(), []);

  function start(event: ReactPointerEvent<HTMLSpanElement>, edge: Edge) {
    if (event.button !== 0 || !event.isPrimary || stop.current) return;
    const handle = event.currentTarget;
    const card = handle.closest<HTMLElement>('.home-block')!;
    const board = card.parentElement!;
    const body = card.querySelector<HTMLElement>('.home-block-body')!;
    const gap = parseFloat(getComputedStyle(board).columnGap);
    const step = (board.getBoundingClientRect().width + gap) / 12;
    const horizontal = edge !== 'bottom' && getComputedStyle(card).getPropertyValue('--home-single-column').trim() !== '1';
    const vertical = edge !== 'right';
    const initialHeight = height ?? Math.round(body.getBoundingClientRect().height);
    const {pointerId, clientX, clientY} = event;
    event.preventDefault();
    handle.setPointerCapture(pointerId);

    function measure(next: PointerEvent) {
      const dimensions: HomeDimensions = {};
      if (horizontal) {
        const span = clamp(width + Math.round((next.clientX - clientX) / step), 3, 13 - (column ?? 1));
        if (span !== width) dimensions.width = span;
      }
      if (vertical && next.clientY !== clientY) {
        const pixels = clamp(Math.round(initialHeight + next.clientY - clientY), 120, 1200);
        if (pixels !== initialHeight) dimensions.height = pixels;
      }
      return dimensions;
    }
    function preview(next: PointerEvent) {
      if (next.pointerId !== pointerId) return;
      const size = measure(next);
      if (size.width === undefined) card.style.removeProperty('--resize-span');
      else card.style.setProperty('--resize-span', String(size.width));
      if (size.height === undefined) card.style.removeProperty('--resize-height');
      else card.style.setProperty('--resize-height', size.height + 'px');
    }
    function finish(next: PointerEvent) {
      if (next.pointerId !== pointerId) return;
      const size = measure(next);
      cancel();
      if (Object.keys(size).length) onCommit(size);
    }
    function escape(next: KeyboardEvent) {
      if (next.key === 'Escape') { next.preventDefault(); cancel(); }
    }
    function cancel() {
      stop.current = undefined;
      handle.removeEventListener('pointermove', preview);
      handle.removeEventListener('pointerup', finish);
      handle.removeEventListener('lostpointercapture', cancel);
      handle.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', escape);
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      card.style.removeProperty('--resize-span');
      card.style.removeProperty('--resize-height');
    }
    stop.current = cancel;
    handle.addEventListener('pointermove', preview);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', cancel);
    handle.addEventListener('lostpointercapture', cancel);
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', escape);
  }
  // The width and height selectors in the toolbar provide the keyboard equivalents.
  return edges.map(edge => <span key={edge} data-home-resize={edge} aria-hidden="true" title={label}
    onPointerDown={event => start(event, edge)}/>);
}
