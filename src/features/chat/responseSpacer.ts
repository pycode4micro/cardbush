import { cssEscape } from '../../shared/cssEscape';

type ResponseSpaceMeasurement = { anchorKey: string; contentHeight: number; height: number };
const measurements = new WeakMap<HTMLElement, ResponseSpaceMeasurement>();

// scrollTop/clientHeight are layout pixels; bounding rects include CSS zoom.
const viewportScale = (scroller: HTMLElement) =>
  scroller.getBoundingClientRect().height / scroller.offsetHeight || 1;

export function captureResponseSpacer(scroller: HTMLElement) {
  const spacer = scroller.querySelector<HTMLElement>('.assistant-response-spacer');
  const measurement = spacer && measurements.get(spacer);
  return measurement ? { ...measurement } : undefined;
}

/** Restore the remaining footprint before restoring the viewport. Output that
 * arrived while away consumes the saved space through the ordinary path. */
export function restoreResponseSpacer(scroller: HTMLElement, anchorKey: string, measurement?: ResponseSpaceMeasurement) {
  const spacer = scroller.querySelector<HTMLElement>('.assistant-response-spacer');
  if (spacer && measurement?.anchorKey === anchorKey) measurements.set(spacer, { ...measurement });
  updateResponseSpacer(scroller, anchorKey, 'consume');
}

/** Seed lazy history from measured rows, including a turn leaving live layout.
 * Batch reads before writes so streaming never measures the entire history. */
export function rememberConversationMessageSizes(scroller: HTMLElement, selector = '.message-list-item') {
  const scale = viewportScale(scroller);
  const sizes = Array.from(scroller.querySelectorAll<HTMLElement>(selector), item => {
    const style = getComputedStyle(item);
    return { item, height: item.getBoundingClientRect().height / scale
      - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
      - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth) };
  });
  for (const { item, height } of sizes) {
    const size = `auto ${Math.max(0, height)}px`;
    if (item.style.containIntrinsicBlockSize !== size) item.style.containIntrinsicBlockSize = size;
  }
}

export function submittedUserReadingOffset(availableHeight: number, messageHeight: number) {
  // Keep context above the new bubble. Like Codex's bounded response spacer,
  // leave at least 240px for the turn instead of reserving almost a whole page.
  const replySpace = Math.max(0, Math.min(availableHeight * 2 / 3, availableHeight - 240));
  return Math.max(24, Math.round(availableHeight - replySpace - messageHeight));
}

/** Reserve only the unfilled tail of a submitted turn, never a message row. */
export function updateResponseSpacer(scroller: HTMLElement, anchorKey: string, mode: 'place' | 'consume' = 'place') {
  const spacer = scroller.querySelector<HTMLElement>('.assistant-response-spacer');
  if (!spacer) return;
  const setHeight = (height: number) => {
    const value = `${height}px`;
    if (spacer.style.height !== value) spacer.style.height = value;
  };
  const anchor = anchorKey ? scroller.querySelector<HTMLElement>(
    `[data-message-render-key="${cssEscape(anchorKey)}"]`,
  ) : null;
  if (!anchor) {
    setHeight(0);
    measurements.delete(spacer);
    if (spacer.dataset.anchorKey) spacer.dataset.anchorKey = '';
    return;
  }
  const footer = scroller.querySelector<HTMLElement>('.message-list-footer');
  const scale = viewportScale(scroller);
  const availableHeight = Math.max(0, scroller.clientHeight - (footer?.getBoundingClientRect().height ?? 0) / scale);
  const anchorBounds = anchor.getBoundingClientRect();
  const readingAnchor = submittedUserReadingOffset(availableHeight, anchorBounds.height / scale);
  // The spacer's top excludes its own height. Growing replies, guidance and
  // async media therefore consume this space without creating internal gaps.
  const contentHeight = (spacer.getBoundingClientRect().top - anchorBounds.top) / scale;
  const availableSpace = Math.max(0, Math.ceil(availableHeight - readingAnchor - contentHeight));
  const previous = measurements.get(spacer);
  // Keep the reserved turn's footprint while it still has space. A status
  // disappearing returns its occupied pixels to that same reservation.
  // Once spent, it cannot reappear on a later shrink or viewport resize.
  // Explicit submissions/disclosures can still place/refill their own space.
  const height = mode === 'consume' && previous?.anchorKey === anchorKey
    ? previous.height > 0
      ? Math.min(availableSpace, Math.max(0, previous.height - (contentHeight - previous.contentHeight)))
      : 0
    : availableSpace;
  setHeight(height);
  measurements.set(spacer, { anchorKey, contentHeight, height });
  if (spacer.dataset.anchorKey !== anchorKey) spacer.dataset.anchorKey = anchorKey;
  const offset = `${readingAnchor}px`;
  if (scroller.style.getPropertyValue('--submitted-user-reading-anchor') !== offset) {
    scroller.style.setProperty('--submitted-user-reading-anchor', offset);
  }
}

/** A submitted turn keeps its reading position while it has reserved space.
 * Once spent, use the native bottom for streaming, restoration and reflow.
 * A second tail/inset calculation would omit footer spacing and drift at zoom. */
export function responseFollowScrollTop(scroller: HTMLElement, readingTop = scroller.scrollTop) {
  const maximum = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const spacer = scroller.querySelector<HTMLElement>('.assistant-response-spacer');
  const remaining = parseFloat(spacer?.style.height ?? '') || 0;
  return remaining > 0.5 ? Math.max(0, Math.min(maximum, readingTop)) : maximum;
}

/** One layout transaction, called from layout effects and ResizeObserver.
 * Consume space before choosing a destination; never schedule a follow frame.
 * History reading keeps browser anchoring and the existing disclosure/reflow
 * owners. Explicit navigation owns its position until its animation completes. */
export function reconcileResponseLayout(
  scroller: HTMLElement,
  { anchorKey, follow, navigationActive, readingTop }: {
    anchorKey: string;
    follow: boolean;
    navigationActive: boolean;
    readingTop?: number;
  },
) {
  const beforeTop = scroller.scrollTop;
  // A removed status can clamp scrollTop during DOM commit, before layout
  // effects run. Restore the last settled position after refilling its pixels.
  const retainedTop = Math.max(beforeTop, readingTop ?? beforeTop);
  rememberConversationMessageSizes(scroller, '.latest-turn');
  updateResponseSpacer(scroller, anchorKey, 'consume');
  if (follow && !navigationActive) {
    const target = responseFollowScrollTop(scroller, retainedTop);
    if (Math.abs(scroller.scrollTop - target) > 0.5) {
      scroller.scrollTo({ top: target, behavior: 'instant' });
    }
  }
  return scroller.scrollTop !== beforeTop;
}

/** Retire only space that can disappear without clamping the reader upward.
 * A later upward scroll can retire the remainder; content still consumes it. */
export function releaseResponseSpacer(scroller: HTMLElement) {
  const spacer = scroller.querySelector<HTMLElement>('.assistant-response-spacer');
  if (!spacer) return true;
  const height = parseFloat(spacer.style.height) || 0;
  const removable = Math.max(0, scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop);
  const remaining = Math.max(0, height - removable);
  spacer.style.height = `${remaining}px`;
  const previous = measurements.get(spacer);
  if (previous) previous.height = remaining;
  if (remaining <= 0.5) {
    updateResponseSpacer(scroller, '');
    return true;
  }
  return false;
}
