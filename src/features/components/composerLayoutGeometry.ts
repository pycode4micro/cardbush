import type { ComposerFlow, WelcomePlacement } from './componentModel';

export const composerEdge = 12;
export const composerBottomGap = 20;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

// Saved widths are percentages of the pane. Keep their original scale up to
// the reading column, including when the pane is narrower than the input minimum.
export function composerHorizontalBounds(viewportWidth: number, percent: number | undefined, readingWidth: number) {
  const available = Math.max(0, Math.min(viewportWidth - composerEdge * 2, readingWidth));
  const requested = percent === undefined ? available : viewportWidth * percent / 100;
  const width = clamp(requested, Math.min(280, available), available);
  return { left: Math.max(0, (viewportWidth - width) / 2), width };
}

export function composerVerticalBounds(viewportHeight: number, inputHeight: number, requestedY: number | undefined,
  afterSend: ComposerFlow['afterSend'], pinned = false) {
  const bottom = Math.max(composerEdge, viewportHeight - inputHeight - composerBottomGap);
  const minimumTravel = clamp(viewportHeight * .2, 120, 160);
  const smallWindow = viewportHeight < 360 || bottom - composerEdge < minimumTravel;
  const y = clamp(requestedY ?? bottom, composerEdge, bottom);
  const docked = pinned || requestedY === undefined || afterSend === 'bottom' && (smallWindow || bottom - y < minimumTravel);
  return { top: docked ? bottom : y, bottom, minimumTravel, docked };
}

export function moveComposerPlacement(item: WelcomePlacement, kind: 'move' | 'resize', delta: { x: number; y: number },
  space: { width: number; height: number; readingWidth?: number }) {
  // The right resize handle expands both sides equally. Height follows the live
  // input; it is not a blank resizable container around the actual control.
  const limit = space.readingWidth ?? space.width;
  let width = item.width;
  if (kind === 'resize' && delta.x !== 0) {
    const current = composerHorizontalBounds(space.width, width, limit);
    const next = composerHorizontalBounds(space.width, (current.width + delta.x * 2) / space.width * 100, limit);
    width = next.width >= limit ? 100 : next.width / space.width * 100;
  }
  const vertical = composerVerticalBounds(space.height, item.height, item.y + (kind === 'move' ? delta.y : 0),
    item.composerFlow?.afterSend ?? 'bottom', (kind === 'resize' || delta.y === 0) && item.composerDock === 'bottom');
  return { ...item, x: (100 - width) / 2, width,
    y: vertical.top, composerDock: vertical.docked ? 'bottom' as const : undefined };
}
