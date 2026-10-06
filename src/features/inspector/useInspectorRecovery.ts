import { useLayoutEffect, useRef, useState } from 'react';
import { minimumConversationWidth, minimumInspectorWidth } from '../../components/rightInspectorSizing';

const splitWidthKey = 'cardbush.inspector_split_width';
const coveredConversationWidth = 320;
const usableConversationWidth = minimumConversationWidth;

/** Keep a readable split, including restored widths and live resize previews. */
export function useInspectorRecovery({ open, covered, width }: { open: boolean; covered: boolean; width: number }) {
  const mainStageRef = useRef<HTMLElement | null>(null);
  const [conversationCovered, setConversationCovered] = useState(false);
  const coveredRef = useRef(false);
  const splitWidthRef = useRef<number | undefined>(undefined);
  const loaded = useRef(false);
  if (!loaded.current) {
    loaded.current = true;
    const saved = Number.parseFloat(window.localStorage.getItem(splitWidthKey) ?? '');
    if (Number.isFinite(saved) && saved >= minimumInspectorWidth) splitWidthRef.current = saved;
  }

  useLayoutEffect(() => {
    const stage = mainStageRef.current;
    const updateCovered = (value: boolean) => { coveredRef.current = value; setConversationCovered(value); };
    if (!open || covered || !stage) { updateCovered(false); return; }
    const shell = stage.parentElement;
    let panel: HTMLElement | null = null;
    let frame = 0;
    const measure = () => {
      const nextPanel = shell?.querySelector<HTMLElement>(':scope > .right-inspector') ?? null;
      if (nextPanel !== panel) {
        if (panel) observer.unobserve(panel);
        previews.disconnect();
        if (shell) previews.observe(shell, { childList: true });
        panel = nextPanel;
        if (panel) {
          observer.observe(panel);
          previews.observe(panel, { attributes: true, attributeFilter: ['style', 'class'] });
        }
      }
      if (!panel || panel.classList.contains('soft-panel-hidden')) return;
      // Overlay mode has separate navigation; a docked pane may reach zero width.
      const style = getComputedStyle(panel);
      if (style.position === 'absolute') { updateCovered(false); return; }
      // Use the target split in both states. Measuring the animated chat width
      // can immediately collapse it again while restoration is still settling.
      // The resolved side-panel width also includes responsive CSS constraints.
      const available = stage.offsetWidth + panel.offsetWidth;
      const requested = Number.parseFloat(style.getPropertyValue('--side-panel-width')) || width;
      const remaining = available - requested;
      updateCovered(remaining < (coveredRef.current ? usableConversationWidth : coveredConversationWidth));
      // Do not remember animation frames, clamped oversized widths, or live drags.
      if (stage.clientWidth >= usableConversationWidth && Math.abs(panel.offsetWidth - width) < 2 &&
        !document.body.classList.contains('right-inspector-resizing') &&
        !document.body.classList.contains('sidebar-resizing')) {
        splitWidthRef.current = width;
        window.localStorage.setItem(splitWidthKey, String(width));
      }
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(stage);
    // Also catches sidebar/window changes while the chat width remains zero.
    if (shell) observer.observe(shell);
    // While collapsed the panel fills the space: live drag previews change its
    // requested CSS width without changing its measured border box. The presence
    // hook can mount/reveal it after this effect, so also watch direct children.
    const previews = new MutationObserver(schedule);
    if (shell) previews.observe(shell, { childList: true });
    schedule();
    return () => { observer.disconnect(); previews.disconnect(); cancelAnimationFrame(frame); };
  }, [open, covered, width]);

  return { mainStageRef, conversationCovered, splitWidthRef };
}
