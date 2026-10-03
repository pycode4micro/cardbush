import { useLayoutEffect, useRef, useState } from 'react';
import { minimumInspectorWidth } from '../../components/rightInspectorSizing';

const splitWidthKey = 'cardbush.inspector_split_width';
const coveredConversationWidth = 24;
const usableConversationWidth = 340;

/** Observe actual layout: restored widths can hide chat without entering full cover. */
export function useInspectorRecovery({ open, covered, width }: { open: boolean; covered: boolean; width: number }) {
  const mainStageRef = useRef<HTMLElement | null>(null);
  const [conversationCovered, setConversationCovered] = useState(false);
  const splitWidthRef = useRef<number | undefined>(undefined);
  const loaded = useRef(false);
  if (!loaded.current) {
    loaded.current = true;
    const saved = Number.parseFloat(window.localStorage.getItem(splitWidthKey) ?? '');
    if (Number.isFinite(saved) && saved >= minimumInspectorWidth) splitWidthRef.current = saved;
  }

  useLayoutEffect(() => {
    const stage = mainStageRef.current;
    if (!open || covered || !stage) { setConversationCovered(false); return; }
    let frame = 0;
    const measure = () => {
      const panel = stage.parentElement?.querySelector<HTMLElement>(':scope > .right-inspector');
      if (!panel || panel.classList.contains('soft-panel-hidden')) return;
      // Overlay mode has separate navigation; a docked pane may reach zero width.
      if (getComputedStyle(panel).position === 'absolute') { setConversationCovered(false); return; }
      setConversationCovered(stage.clientWidth <= coveredConversationWidth);
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
    if (stage.parentElement) observer.observe(stage.parentElement);
    schedule();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [open, covered, width]);

  return { mainStageRef, conversationCovered, splitWidthRef };
}
