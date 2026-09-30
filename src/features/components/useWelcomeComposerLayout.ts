import { useLayoutEffect, type RefObject } from 'react';
import type { ComposerFlow, WelcomePlacement } from './componentModel';
import { composerHorizontalBounds, composerVerticalBounds } from './composerLayoutGeometry';

// Measure the live input, including attachments and its project selector. A
// stored component height must never create invisible padding around the input.
export function useWelcomeComposerLayout(ref: RefObject<HTMLDivElement | null>, placement: WelcomePlacement | undefined,
  flow: ComposerFlow, layoutKey: unknown) {
  useLayoutEffect(() => {
    const canvas = ref.current, slot = canvas?.querySelector<HTMLElement>('.welcome-slot-input');
    const input = slot?.querySelector<HTMLElement>('.welcome-input-stack');
    if (!canvas || !slot || !input) return;
    const measure = () => {
      const viewportWidth = canvas.offsetWidth;
      const horizontal = composerHorizontalBounds(viewportWidth, placement?.width,
        parseFloat(getComputedStyle(canvas).getPropertyValue('--chat-track-width')) || 704);
      // Set width before measuring height: wrapped text and the standard toolbar
      // can change height when a narrow pane is resized.
      slot.style.left = `${horizontal.left}px`;
      slot.style.width = `${horizontal.width}px`;
      const height = input.getBoundingClientRect().height / (canvas.getBoundingClientRect().height / canvas.offsetHeight || 1);
      const vertical = composerVerticalBounds(canvas.clientHeight, height, placement?.y, flow.afterSend, placement?.composerDock === 'bottom');
      slot.style.top = `${vertical.top}px`;
      slot.style.height = `${height}px`;
      slot.dataset.composerDocked = String(vertical.docked);
      canvas.style.setProperty('--welcome-composer-height', `${height}px`);
      const landing = canvas.querySelector<HTMLElement>('.welcome-composer-landing');
      if (landing) {
        Object.assign(landing.style, { left: `${horizontal.left}px`, top: `${vertical.bottom}px`, width: `${horizontal.width}px`, height: `${height}px` });
        landing.dataset.docked = String(vertical.docked);
        landing.style.setProperty('--composer-travel', `${Math.round(vertical.bottom - vertical.top)}px`);
        const distance = landing.querySelector<HTMLElement>('[data-composer-travel]');
        if (distance) distance.textContent = `${Math.round(vertical.bottom - vertical.top)} px`;
      }
    };
    measure();
    let frame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (frame === null) frame = requestAnimationFrame(() => { frame = null; measure(); });
    });
    observer.observe(canvas); observer.observe(input);
    return () => { observer.disconnect(); if (frame !== null) cancelAnimationFrame(frame); };
  }, [ref, placement, flow.afterSend, layoutKey]);
}
