import type { ComposerFlow, WelcomePlacement } from './componentModel';

export const composerEdge = 12;
export const composerBottomGap = 20;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

// Both the editor and the conversation use the pane width, not the transcript's
// scrollbar width. Custom widths remain proportional when the pane is resized.
export function composerHorizontalBounds(viewportWidth: number, percent?: number, defaultWidth = 704, availableWidth = viewportWidth) {
  const available = Math.max(0, availableWidth - composerEdge * 2);
  const requested = percent === undefined ? defaultWidth : viewportWidth * percent / 100;
  const width = clamp(requested, Math.min(280, available), available);
  return { left: Math.max(0, (availableWidth - width) / 2), width };
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
  space: { width: number; height: number }) {
  // The right resize handle expands both sides equally. Height follows the live
  // input; it is not a blank resizable container around the actual control.
  const horizontal = composerHorizontalBounds(space.width, item.width + (kind === 'resize' ? delta.x * 200 / space.width : 0));
  const vertical = composerVerticalBounds(space.height, item.height, item.y + (kind === 'move' ? delta.y : 0),
    item.composerFlow?.afterSend ?? 'bottom', (kind === 'resize' || delta.y === 0) && item.composerDock === 'bottom');
  return { ...item, x: horizontal.left / space.width * 100, width: horizontal.width / space.width * 100,
    y: vertical.top, composerDock: vertical.docked ? 'bottom' as const : undefined };
}
