import { suspendScrollAnchoring } from '../scrollAnchoring';

type ReadingAnchor = {
  element: HTMLElement;
  text?: { node: Text; offset: number; elementOffset: number };
  fraction: number;
  offset: number;
};
type ReflowOptions = {
  paused: () => boolean;
  following: () => boolean;
  beforeRestore: () => void;
  followTop: (readingTop: number) => number;
  restored: () => void;
};

function captureReadingAnchor(scroller: HTMLElement): ReadingAnchor | null {
  const viewport = scroller.getBoundingClientRect();
  const y = viewport.top + 20;
  const item = Array.from(scroller.querySelectorAll<HTMLElement>('.message-list-item'))
    .find(node => node.getBoundingClientRect().bottom > y);
  if (!item) return null;
  const element = Array.from(item.querySelectorAll<HTMLElement>(
    'p, li, h1, h2, h3, h4, h5, h6, pre, table, img, video, .user-bubble, .tool-execution-row, .assistant-completed-summary',
  )).find(node => { const rect = node.getBoundingClientRect(); return rect.height > 0 && rect.bottom > y; }) ?? item;
  // Images often fill many screens. Keep the same point in the image instead
  // of retaining a pixel offset measured at a different display width.
  const media = element.matches('img, video') ? element
    : Array.from(element.querySelectorAll<HTMLElement>('img, video')).find(node => {
      const rect = node.getBoundingClientRect(); return rect.top <= y && rect.bottom > y;
    });
  if (media) {
    const rect = media.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (y - rect.top) / rect.height));
    return { element: media, fraction, offset: rect.top + fraction * rect.height - viewport.top };
  }
  const rect = element.getBoundingClientRect();
  // Keep a character offset through wrapping, including a paragraph whose
  // beginning has scrolled offscreen. A retained live Range would reset its
  // offsets when React appends streaming text to that node.
  const point = scroller.ownerDocument.caretPositionFromPoint(
    Math.max(viewport.left + 4, rect.left + 4), Math.max(y, rect.top + 4),
  );
  if (point?.offsetNode.nodeType === Node.TEXT_NODE && element.contains(point.offsetNode)) {
    const range = scroller.ownerDocument.createRange();
    const length = point.offsetNode.textContent?.length ?? 0;
    const start = Math.min(point.offset, Math.max(0, length - 1));
    range.setStart(point.offsetNode, start); range.setEnd(point.offsetNode, Math.min(length, start + 1));
    const bounds = range.getBoundingClientRect();
    if (bounds.height > 0) return { element, fraction: 0, offset: bounds.top - viewport.top,
      text: { node: point.offsetNode as Text, offset: start, elementOffset: rect.top - viewport.top } };
  }
  return { element, fraction: 0, offset: rect.top - viewport.top };
}

/** Own only viewport reflows. Content streaming and session restoration retain
 * their existing scroll policies. No permanent animation/polling loop. */
export function observeConversationReflow(scroller: HTMLElement, options: () => ReflowOptions) {
  let width = scroller.clientWidth, height = scroller.clientHeight;
  let anchor = captureReadingAnchor(scroller);
  let settling = false, correctedTop: number | null = null;
  let captureFrame: number | null = null, settleFrame: number | null = null;
  let releaseAnchoring: (() => void) | null = null;
  const resized = () => scroller.clientWidth !== width || scroller.clientHeight !== height;
  const capture = () => { anchor = captureReadingAnchor(scroller); };
  const finish = () => {
    if (settleFrame != null) cancelAnimationFrame(settleFrame);
    settleFrame = null; settling = false;
    releaseAnchoring?.(); releaseAnchoring = null;
  };
  const scroll = () => {
    if (resized() || settling || options().paused() || correctedTop === scroller.scrollTop) return;
    correctedTop = null;
    // Coalesce native scroll events into one reading measurement per frame.
    if (captureFrame != null) cancelAnimationFrame(captureFrame);
    captureFrame = requestAnimationFrame(() => { captureFrame = null; if (!resized() && !settling) capture(); });
  };
  const input = (event: Event) => {
    if (event instanceof KeyboardEvent && !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) return;
    correctedTop = null;
    // A user gesture supersedes a previous anchor, even during a transition.
    finish();
    capture();
  };
  const observer = new ResizeObserver(() => {
    if (!resized()) return;
    width = scroller.clientWidth; height = scroller.clientHeight;
    if (width <= 0 || height <= 0) return;
    if (options().paused()) { capture(); return; }
    const policy = options();
    settling = true;
    releaseAnchoring ??= suspendScrollAnchoring(scroller);
    policy.beforeRestore();
    let top = scroller.scrollTop;
    if (anchor?.element.isConnected) {
      let rect = anchor.element.getBoundingClientRect();
      let offset = anchor.text?.elementOffset ?? anchor.offset;
      if (anchor.text?.node.isConnected) {
        const { node } = anchor.text;
        const range = node.ownerDocument.createRange();
        const start = Math.min(anchor.text.offset, Math.max(0, node.length - 1));
        range.setStart(node, start); range.setEnd(node, Math.min(node.length, start + 1));
        const bounds = range.getBoundingClientRect();
        if (bounds.height > 0) { rect = bounds; offset = anchor.offset; }
      }
      top += rect.top + anchor.fraction * rect.height - scroller.getBoundingClientRect().top - offset;
    }
    if (policy.following()) top = policy.followTop(top);
    scroller.scrollTo({ top: Math.max(0, Math.min(scroller.scrollHeight - height, top)), behavior: 'instant' });
    correctedTop = scroller.scrollTop;
    policy.restored();
    if (captureFrame != null) cancelAnimationFrame(captureFrame);
    captureFrame = null;
    if (settleFrame != null) cancelAnimationFrame(settleFrame);
    settleFrame = requestAnimationFrame(finish);
  });
  observer.observe(scroller);
  scroller.addEventListener('scroll', scroll, { passive: true });
  for (const name of ['wheel', 'pointerdown', 'keydown']) scroller.addEventListener(name, input, { capture: true, passive: true });
  return {
    // Chromium may emit a layout scroll before ResizeObserver. It must never
    // detach bottom-follow or replace the pre-resize reading anchor.
    isReflowing: () => resized() || settling,
    isReflowScroll: () => resized() || settling || correctedTop === scroller.scrollTop,
    dispose() {
      observer.disconnect();
      if (captureFrame != null) cancelAnimationFrame(captureFrame);
      finish();
      scroller.removeEventListener('scroll', scroll);
      for (const name of ['wheel', 'pointerdown', 'keydown']) scroller.removeEventListener(name, input, true);
    },
  };
}
