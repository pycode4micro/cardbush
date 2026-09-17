import { cssEscape } from '../../shared/cssEscape';

export function submittedUserReadingOffset(availableHeight: number, messageHeight: number) {
  // Keep context above the new bubble. Like Codex's bounded response spacer,
  // leave at least 240px for the turn instead of reserving almost a whole page.
  const replySpace = Math.max(0, Math.min(availableHeight * 2 / 3, availableHeight - 240));
  return Math.max(24, Math.round(availableHeight - replySpace - messageHeight));
}

/** Reserve only the unfilled tail of a submitted turn, never a message row. */
export function updateResponseSpacer(scroller: HTMLElement, anchorKey: string) {
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
    if (spacer.dataset.anchorKey) spacer.dataset.anchorKey = '';
    return;
  }
  const footer = scroller.querySelector<HTMLElement>('.message-list-footer');
  const availableHeight = Math.max(0, scroller.clientHeight - (footer?.getBoundingClientRect().height ?? 0));
  const anchorBounds = anchor.getBoundingClientRect();
  const readingAnchor = submittedUserReadingOffset(availableHeight, anchorBounds.height);
  // The spacer's top excludes its own height. Growing replies, guidance and
  // async media therefore consume this space without creating internal gaps.
  const contentHeight = spacer.getBoundingClientRect().top - anchorBounds.top;
  const height = Math.max(0, Math.ceil(availableHeight - readingAnchor - contentHeight));
  setHeight(height);
  if (spacer.dataset.anchorKey !== anchorKey) spacer.dataset.anchorKey = anchorKey;
  const offset = `${readingAnchor}px`;
  if (scroller.style.getPropertyValue('--submitted-user-reading-anchor') !== offset) {
    scroller.style.setProperty('--submitted-user-reading-anchor', offset);
  }
}
