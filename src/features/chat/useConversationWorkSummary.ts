import { useCallback, useEffect, useLayoutEffect, useState, type FocusEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { useSoftPanelPresence } from '../../hooks/useSoftPanelPresence';
import { useHoverPreview } from '../../components/HoverPreview';

/** Shared header summary placement and dismissal for every conversation surface. */
export function useConversationWorkSummary(chatBodyRef: RefObject<HTMLDivElement | null>, activeConversationId: string, inspectorOpen: boolean) {
  const [workSummaryVisible, setWorkSummaryVisible] = useState(false);
  const [widePane, setWidePane] = useState(false);
  const [pinnedLayout, setPinnedLayout] = useState(false);
  const [workSummaryAnchorRight, setWorkSummaryAnchorRight] = useState(12);
  const hover = useHoverPreview(workSummaryVisible, { interactive: true });
  const showWorkSummary = workSummaryVisible || Boolean(hover.anchor);
  // Hovering never changes the reading width. Clicking retains the existing dock.
  const workSummaryDocked = pinnedLayout && widePane;
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
    setWidePane(bodyBounds.width >= 1100);
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
      hover.dismiss();
    };
    const closeOverlaySummaryWithKeyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setWorkSummaryVisible(false);
        hover.dismiss();
      }
    };
    document.addEventListener('pointerdown', closeOverlaySummary);
    document.addEventListener('keydown', closeOverlaySummaryWithKeyboard);
    return () => {
      document.removeEventListener('pointerdown', closeOverlaySummary);
      document.removeEventListener('keydown', closeOverlaySummaryWithKeyboard);
    };
  }, [showWorkSummary, workSummaryDocked, hover.dismiss]);
  useEffect(() => {
    setWorkSummaryVisible(false);
    setPinnedLayout(false);
    hover.close();
  }, [activeConversationId]);
  useLayoutEffect(() => {
    if (hover.anchor) setPinnedLayout(false);
  }, [hover.anchor]);
  useEffect(() => {
    if (!hover.anchor) return;
    window.addEventListener('blur', hover.dismiss);
    document.addEventListener('visibilitychange', hover.dismiss);
    return () => {
      window.removeEventListener('blur', hover.dismiss);
      document.removeEventListener('visibilitychange', hover.dismiss);
    };
  }, [hover.anchor, hover.dismiss]);

  return { showWorkSummary, workSummaryDocked, workSummaryAnchorRight, workSummaryPresence,
    toggleWorkSummary: (anchor: HTMLElement) => {
      updateWorkSummaryLayout(anchor);
      hover.close();
      if (!workSummaryVisible) setPinnedLayout(true);
      setWorkSummaryVisible(value => !value);
    },
    workSummaryHoverProps: { ...hover.triggerProps, 'aria-describedby': undefined,
      'aria-controls': showWorkSummary ? hover.id : undefined,
      'data-summary-preview': Boolean(hover.anchor) && !workSummaryVisible },
    keepWorkSummaryOpenUntil: hover.keepOpenUntil,
    workSummaryPanelProps: {
      id: hover.id,
      onPointerEnter: hover.keepOpen, onPointerMove: hover.keepOpen,
      onPointerLeave: (event: ReactPointerEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(document.activeElement)) hover.leave();
      },
      onFocus: hover.keepOpen,
      onBlur: (event: FocusEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget)) hover.leave();
      },
    },
  };
}
