import { uiText } from '../../i18n';
import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { computerUseAppearance as appearance } from '@cardbush/bush-protocol';
import './aiEditingCursor.css';

export type AiEditPosition = { left: number; top: number; bottom: number };
export function AiEditingCursor({ locate, surface, revision, state, language }: {
  locate: () => AiEditPosition | undefined; surface: () => HTMLElement | null; revision: string;
  state: 'streaming' | 'ready'; language: string;
}) {
  const [point, setPoint] = useState<(AiEditPosition & { labelLeft: number; labelTop: number })>();
  const following = useRef(true);
  useLayoutEffect(() => {
    const element = surface(); if (!element) return;
    const scroller = element.closest<HTMLElement>('.md-article-scroll, .creation-source-content');
    let frame = 0;
    const update = () => {
      let rect = locate(); if (!rect) { setPoint(undefined); return; }
      const bounds = (scroller ?? element).getBoundingClientRect();
      const top = Math.max(0, bounds.top), bottom = Math.min(innerHeight, bounds.bottom);
      if (following.current && scroller && scroller.classList.contains('md-article-scroll') && (rect.top < top + 28 || rect.bottom > bottom - 55)) {
        scroller.scrollTop += rect.bottom - bottom + 70; rect = locate();
      }
      if (following.current && rect && element instanceof HTMLTextAreaElement) {
        if (rect.top < top + 8) element.scrollTop -= top + 8 - rect.top;
        else if (rect.bottom > bottom - 45) element.scrollTop += rect.bottom - bottom + 45;
        if (rect.left > bounds.right - 30) element.scrollLeft += rect.left - bounds.right + 40;
        else if (rect.left < bounds.left) element.scrollLeft -= bounds.left - rect.left + 8;
        rect = locate();
      }
      if (!rect || rect.bottom < top || rect.top > bottom || rect.left < bounds.left || rect.left > bounds.right) { setPoint(undefined); return; }
      const left = Math.min(rect.left, innerWidth - 26);
      setPoint({ top: rect.top, bottom: rect.bottom, left, labelLeft: Math.max(bounds.left + 4, Math.min(left + 15, bounds.right - 89)),
        labelTop: rect.bottom + 24 < bottom ? rect.bottom + 3 : Math.max(top + 3, rect.top - 26) });
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update); };
    const pause = (event: Event) => { if (event.isTrusted) following.current = false; };
    schedule();
    document.addEventListener('scroll', schedule, true); window.addEventListener('resize', schedule);
    scroller?.addEventListener('wheel', pause, { passive: true }); scroller?.addEventListener('pointerdown', pause);
    const observer = new ResizeObserver(schedule); observer.observe(element);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); document.removeEventListener('scroll', schedule, true); window.removeEventListener('resize', schedule); scroller?.removeEventListener('wheel', pause); scroller?.removeEventListener('pointerdown', pause); };
  }, [revision, locate, surface]);
  if (!point) return null;
  return createPortal(<div className="ai-editing-cursor" data-state={state} role="img" aria-label={uiText(language)('aiEditingCursor.cardbushIsEditing')}>
    <span className="ai-editing-caret" style={{ left: point.left, top: point.top, height: Math.max(16, point.bottom - point.top), background: `rgb(${appearance.pointer.join(',')})` }}/>
    <svg width="24" height="25" viewBox="-2 -2 24 25" style={{ left: point.left + 2, top: point.bottom - 6 }} aria-hidden="true">
      <polygon points={appearance.points.map(point => point.join(',')).join(' ')} fill={`rgb(${appearance.pointer.join(',')})`} stroke={`rgb(${appearance.outline.join(',')})`} strokeWidth="1.4"/>
    </svg>
    <span className="ai-editing-label" style={{ left: point.labelLeft, top: point.labelTop, background: `rgb(${appearance.label.join(',')})` }}>{uiText(language)('aiEditingCursor.cardbush')}</span>
  </div>, document.body);
}

/** Measure without moving the user's focus, selection or system mouse. */
export function textareaCaretRect(input: HTMLTextAreaElement | HTMLInputElement | null, offset: number): AiEditPosition | undefined {
  if (!input) return;
  const box = input.getBoundingClientRect(), style = getComputedStyle(input), mirror = document.createElement('div');
  for (const key of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'tabSize', 'paddingTop', 'paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderTopWidth', 'boxSizing'] as const) mirror.style[key] = style[key];
  Object.assign(mirror.style, { position: 'fixed', visibility: 'hidden', pointerEvents: 'none', left: `${box.left - input.scrollLeft}px`, top: `${box.top - input.scrollTop}px`, width: `${input.clientWidth}px`, whiteSpace: input instanceof HTMLInputElement || input.wrap === 'off' ? 'pre' : 'pre-wrap', overflowWrap: 'break-word' });
  mirror.textContent = input.value.slice(0, offset);
  const marker = document.createElement('span'); marker.textContent = input.value[offset] || '\u200b'; mirror.append(marker); document.body.append(mirror);
  const rect = marker.getBoundingClientRect(); mirror.remove();
  return { left: rect.left, top: rect.top, bottom: rect.bottom };
}
