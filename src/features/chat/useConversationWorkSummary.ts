import { useCallback, useEffect, useLayoutEffect, useState, type RefObject } from 'react';
import { useSoftPanelPresence } from '../../hooks/useSoftPanelPresence';

/** Shared header summary placement and dismissal for every conversation surface. */
export function useConversationWorkSummary(chatBodyRef: RefObject<HTMLDivElement | null>, activeConversationId: string, inspectorOpen: boolean) {
  const [workSummaryVisible, setWorkSummaryVisible] = useState(false);
  const [workSummaryDocked, setWorkSummaryDocked] = useState(false);
  const [workSummaryAnchorRight, setWorkSummaryAnchorRight] = useState(12);
  const showWorkSummary = workSummaryVisible;
  const workSummaryPresence = useSoftPanelPresence(showWorkSummary);
  const updateWorkSummaryLayout = useCallback((anchor?: HTMLElement | null) => {
    const chatBody = chatBodyRef.current;
    const toggle = anchor ?? chatBody
      ?.closest('.chat-panel')
      ?.querySelector<HTMLElement>('[data-work-summary-toggle]');
    if (!chatBody || !toggle) return;
    const bodyBounds = chatBody.getBoundingClientRect();
    const toggleBounds = toggle.getBoundingClientRect();
    // Measure the whole chat pane, not the content frame that we shrink.
    // 1100px leaves about 600px of readable text beside the 336px summary.
    setWorkSummaryDocked(bodyBounds.width >= 1100);
    const maximumRight = Math.max(12, bodyBounds.width - 24);
    setWorkSummaryAnchorRight(Math.min(
      maximumRight,
      Math.max(12, Math.round(bodyBounds.right - toggleBounds.right)),
    ));
  }, [chatBodyRef]);
  useLayoutEffect(() => {
    const chatBody = chatBodyRef.current;
    if (!workSummaryPresence.mounted || !chatBody) return undefined;
    updateWorkSummaryLayout();
    // Sidebars can resize the chat without a window resize. Also remeasure
    // when the inspector toggle disappears, moving the summary button.
    const observer = new ResizeObserver(() => updateWorkSummaryLayout());
    observer.observe(chatBody);
    return () => observer.disconnect();
  }, [workSummaryPresence.mounted, inspectorOpen, updateWorkSummaryLayout]);
  useEffect(() => {
    if (!showWorkSummary || workSummaryDocked) {
      return undefined;
    }
    const closeOverlaySummary = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      if (
        target.closest('.conversation-work-summary') ||
        target.closest('[data-work-summary-toggle]') ||
        target.closest('[data-inspector-toggle]') ||
        target.closest('.right-inspector')
      ) {
        return;
      }
      setWorkSummaryVisible(false);
    };
    const closeOverlaySummaryWithKeyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setWorkSummaryVisible(false);
      }
    };
    document.addEventListener('pointerdown', closeOverlaySummary);
    document.addEventListener('keydown', closeOverlaySummaryWithKeyboard);
    return () => {
      document.removeEventListener('pointerdown', closeOverlaySummary);
      document.removeEventListener('keydown', closeOverlaySummaryWithKeyboard);
    };
  }, [showWorkSummary, workSummaryDocked]);
  useEffect(() => {
    setWorkSummaryVisible(false);
  }, [activeConversationId]);

  return { showWorkSummary, workSummaryDocked, workSummaryAnchorRight, workSummaryPresence, updateWorkSummaryLayout, setWorkSummaryVisible };
}
