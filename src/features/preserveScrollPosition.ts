import { flushSync } from 'react-dom';

export function preserveScrollPositionForToggle(
  element: HTMLElement | null,
  update: () => void,
) {
  if (!element) {
    update();
    return;
  }
  const scroller = element.closest('.message-list') as HTMLElement | null;
  const messageItem = element.closest('[data-message-id]') as HTMLElement | null;
  const anchorElement =
    (element.querySelector(
      '.assistant-completed-summary, .tool-execution-summary, .tool-change-header, .assistant-loop-history-summary',
    ) as HTMLElement | null) ?? element;
  const scrollerRect = scroller?.getBoundingClientRect();
  const beforeTop = anchorElement.getBoundingClientRect().top;
  const beforeOffset = scrollerRect ? beforeTop - scrollerRect.top : 0;
  const beforeScrollTop = scroller?.scrollTop ?? 0;
  const beforeMessageTop = messageItem?.getBoundingClientRect().top ?? beforeTop;
  const previousOverflowAnchor = scroller?.style.overflowAnchor ?? '';
  if (scroller) {
    scroller.style.overflowAnchor = 'none';
    scroller.dataset.cardbushPreserveScroll = '1';
  }
  flushSync(update);
  if (!scroller) {
    return;
  }
  const target = anchorElement.isConnected
    ? anchorElement
    : element.isConnected
      ? element
      : null;
  if (!target) {
    scroller.style.overflowAnchor = previousOverflowAnchor;
    delete scroller.dataset.cardbushPreserveScroll;
    return;
  }
  const nextScrollerRect = scroller.getBoundingClientRect();
  const nextTop = target.getBoundingClientRect().top;
  const nextOffset = nextTop - nextScrollerRect.top;
  const delta = nextOffset - beforeOffset;
  if (Math.abs(delta) > 0.5) {
    const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    scroller.scrollTop = Math.max(
      0,
      Math.min(maxScrollTop, scroller.scrollTop + delta),
    );
  }
  const nextMessageTop = messageItem?.getBoundingClientRect().top ?? nextTop;
  if (Math.abs(delta) > 24) {
    void window.cardbushDesktop
      ?.writeDebugLog?.('scroll', {
        label: 'toggle-anchor-restore',
        beforeScrollTop: Math.round(beforeScrollTop),
        afterScrollTop: Math.round(scroller.scrollTop),
        beforeTop: Math.round(beforeTop),
        beforeOffset: Math.round(beforeOffset),
        beforeMessageTop: Math.round(beforeMessageTop),
        nextMessageTop: Math.round(nextMessageTop),
        finalDelta: Math.round(delta),
        frames: 0,
      })
      .catch(() => undefined);
  }
  // Keep observers from interpreting the synchronous correction as user input,
  // but never write the scroll position again on later frames.
  window.requestAnimationFrame(() => {
    scroller.style.overflowAnchor = previousOverflowAnchor;
    delete scroller.dataset.cardbushPreserveScroll;
  });
}
