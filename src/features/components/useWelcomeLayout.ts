import { useLayoutEffect, type RefObject } from 'react';
import type { ComposerFlow, ComponentCollection, WelcomeLayout } from './componentModel';
import { composerHorizontalBounds, composerVerticalBounds } from './composerLayoutGeometry';
import { welcomeHeightScale } from './welcomeViewportGeometry';
import { adoptWelcomeViewport } from './componentStore';

// Measure the live input, including attachments and its project selector. A
// stored component height must never create invisible padding around the input.
export function useWelcomeLayout(ref: RefObject<HTMLDivElement | null>, layout: WelcomeLayout | undefined,
  flow: ComposerFlow, collection: ComponentCollection, editing: boolean) {
  useLayoutEffect(() => {
    const canvas = ref.current, slot = canvas?.querySelector<HTMLElement>('.welcome-slot-input');
    const input = slot?.querySelector<HTMLElement>('.welcome-input-stack');
    if (!canvas) return;
    const placement = layout?.items.find(item => item.componentId === 'system-input');
    let referenceHeight = layout?.viewportHeight;
    const measure = () => {
      if (!canvas.clientWidth || !canvas.clientHeight) return;
      referenceHeight ??= canvas.clientHeight;
      const scale = welcomeHeightScale(referenceHeight, canvas.clientHeight);
      canvas.style.setProperty('--welcome-height-scale', String(scale));
      // Expose the legacy reference for editor snapshots after a resize.
      canvas.dataset.layoutViewportHeight = String(referenceHeight);
      if (!editing && layout === collection.welcomeLayout) adoptWelcomeViewport(collection, referenceHeight);
      if (!slot || !input) return;
      const viewportWidth = canvas.offsetWidth;
      const horizontal = composerHorizontalBounds(viewportWidth, placement?.width,
        parseFloat(getComputedStyle(canvas).getPropertyValue('--chat-track-width')) || 704);
      // Set width before measuring height: wrapped text and the standard toolbar
      // can change height when a narrow pane is resized.
      slot.style.left = `${horizontal.left}px`;
      slot.style.width = `${horizontal.width}px`;
      const height = input.getBoundingClientRect().height / (canvas.getBoundingClientRect().height / canvas.offsetHeight || 1);
      const vertical = composerVerticalBounds(canvas.clientHeight, height, placement ? placement.y * scale : undefined, flow.afterSend, placement?.composerDock === 'bottom');
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
    observer.observe(canvas); if (input) observer.observe(input);
    return () => { observer.disconnect(); if (frame !== null) cancelAnimationFrame(frame); };
  }, [ref, layout, flow.afterSend, collection, editing]);
}
