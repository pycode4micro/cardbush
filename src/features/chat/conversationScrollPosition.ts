import { absoluteBottomScrollTop } from '../chatScroll';
import { cssEscape } from '../../shared/cssEscape';

export type ConversationScrollPosition = {
  scrollTop: number;
  followLatest: boolean;
  assistantStageReserved: boolean;
  submittedUserReadingAnchor: string;
  anchor: { messageId: string; offset: number } | null;
};

// Capture while the old list is still attached. A message anchor survives
// changes above the viewport; the pixel position is a fallback if it was removed.
export function captureConversationScrollPosition(
  scroller: HTMLElement,
  followLatest: boolean,
): ConversationScrollPosition {
  const viewportTop = scroller.getBoundingClientRect().top;
  let anchor: ConversationScrollPosition['anchor'] = null;
  for (const item of scroller.querySelectorAll<HTMLElement>('.message-list-item')) {
    const bounds = item.getBoundingClientRect();
    if (bounds.bottom <= viewportTop) continue;
    if (item.dataset.messageId) {
      anchor = { messageId: item.dataset.messageId, offset: bounds.top - viewportTop };
    }
    break;
  }
  return {
    scrollTop: scroller.scrollTop,
    followLatest,
    assistantStageReserved: Boolean(scroller.querySelector('.assistant-render-stage')),
    submittedUserReadingAnchor: scroller.style.getPropertyValue('--submitted-user-reading-anchor'),
    anchor,
  };
}

export function restoreConversationScrollPosition(
  scroller: HTMLElement,
  position: ConversationScrollPosition | undefined,
  composerBottomInset: number,
) {
  // Chromium forgets the auto intrinsic size when a keyed list is remounted.
  // Seed the lazy-layout fallback from this mount's actual geometry, otherwise
  // removing the restoration override puts the 220px estimate back above the
  // reading anchor. Batch all reads before writes to avoid per-message reflow.
  const measurements = Array.from(
    scroller.querySelectorAll<HTMLElement>('.message-list-item'),
    (item) => {
      const style = getComputedStyle(item);
      const contentHeight = item.getBoundingClientRect().height
        - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
        - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth);
      return { item, contentHeight };
    },
  );
  for (const { item, contentHeight } of measurements) {
    item.style.containIntrinsicBlockSize = `auto ${Math.max(0, contentHeight)}px`;
  }
  const maximum = absoluteBottomScrollTop(scroller);
  const stage = scroller.querySelector<HTMLElement>('.assistant-render-stage .message-row.assistant');
  let top = position?.scrollTop ?? maximum;
  if (!position || (position.followLatest && !stage)) {
    top = maximum;
  } else {
    const anchor = position.anchor && scroller.querySelector<HTMLElement>(
      `[data-message-id="${cssEscape(position.anchor.messageId)}"]`,
    );
    const viewport = scroller.getBoundingClientRect();
    if (anchor && position.anchor) {
      top = scroller.scrollTop + anchor.getBoundingClientRect().top - viewport.top - position.anchor.offset;
    }
    if (position.followLatest && stage) {
      const tailTop = scroller.scrollTop + stage.getBoundingClientRect().bottom
        - (viewport.bottom - composerBottomInset - 18);
      top = Math.max(top, tailTop);
    }
  }
  // Session restoration is a layout operation, never a user scroll animation.
  scroller.scrollTo({ top: Math.max(0, Math.min(maximum, top)), behavior: 'instant' });
}
