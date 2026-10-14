/** Layout coordinates, excluding arrival transforms and ancestor CSS zoom. */
export function composerLayoutBox(node: HTMLElement, body: HTMLElement) {
  let top = 0, left = 0;
  let current: HTMLElement | null = node;
  while (current && current !== body) {
    top += current.offsetTop;
    left += current.offsetLeft;
    current = current.offsetParent as HTMLElement | null;
  }
  if (current === body) return { top, left, width: node.offsetWidth, height: node.offsetHeight };
  const bounds = body.getBoundingClientRect(), rect = node.getBoundingClientRect();
  const scaleX = bounds.width / body.offsetWidth || 1, scaleY = bounds.height / body.offsetHeight || 1;
  return { top: (rect.top - bounds.top) / scaleY, left: (rect.left - bounds.left) / scaleX,
    width: rect.width / scaleX, height: rect.height / scaleY };
}
