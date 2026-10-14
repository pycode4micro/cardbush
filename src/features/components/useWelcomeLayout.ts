import { useLayoutEffect, type RefObject } from 'react';
import type { ComposerFlow, ComponentCollection, WelcomeLayout } from './componentModel';
import { composerBottomGap, composerEdge, composerHorizontalBounds, composerVerticalBounds } from './composerLayoutGeometry';
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
      // Derive this from saved placements, not the reflowed element widths;
      // otherwise entering compact mode could immediately switch it off again.
      const compactWidgets = !editing && Boolean(layout?.items.some(item => {
        const minimum = item.componentId === 'system-calendar' ? 264
          : ['system-clock', 'system-digital-clock'].includes(item.componentId) ? 152 : 0;
        return minimum > 0 && canvas.clientWidth * item.width / 100 < minimum;
      }));
      canvas.dataset.compactWidgets = String(compactWidgets);
      canvas.style.setProperty('--welcome-widgets-top', '16px');
      canvas.style.setProperty('--welcome-widgets-bottom', '16px');
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
      // Let a docked input grow upward in the same layout as native typing or
      // paste. A measured top/height pair leaves one frame at the old top.
      // Custom canvases can extend below the visible pane, hence the offset
      // from their containing block's bottom rather than a fixed bottom gap.
      const pinnedBottom = vertical.docked && canvas.clientHeight - height - composerBottomGap >= composerEdge;
      slot.style.top = pinnedBottom ? 'auto' : `${vertical.top}px`;
      slot.style.bottom = pinnedBottom ? `calc(100% - ${canvas.clientHeight - composerBottomGap}px)` : 'auto';
      slot.style.height = 'auto';
      slot.dataset.composerDocked = String(vertical.docked);
      canvas.style.setProperty('--welcome-composer-height', `${height}px`);
      if (compactWidgets) {
        // Keep the user's composer anchor; put the readable widgets in the
        // larger free region and scroll that region on short windows only.
        const below = canvas.clientHeight - vertical.top - height;
        canvas.style.setProperty('--welcome-widgets-top', `${vertical.top >= below ? 16 : vertical.top + height + 16}px`);
        canvas.style.setProperty('--welcome-widgets-bottom', `${vertical.top >= below ? canvas.clientHeight - vertical.top + 16 : 16}px`);
      }
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
    // Native bottom anchoring handles text growth immediately. Batch the
    // remaining measurements: changing a custom width inside this callback
    // can resize the observed input again and start a ResizeObserver loop.
    let frame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (frame === null) frame = requestAnimationFrame(() => { frame = null; measure(); });
    });
    observer.observe(canvas); if (input) observer.observe(input);
    return () => { observer.disconnect(); if (frame !== null) cancelAnimationFrame(frame); };
  }, [ref, layout, flow.afterSend, collection, editing]);
}
