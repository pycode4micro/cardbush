import type { WebContents } from 'electron';

/** Keep the CSP on host-provided srcdoc interfaces until the host replaces the frame. */
export function installSandboxFrameNavigationGuard(contents: WebContents) {
  const protectedFrames = new Set<number>();
  contents.on('frame-created', (_event, { frame }) => {
    if (frame && frame.parent?.frameTreeNodeId === contents.mainFrame.frameTreeNodeId) protectedFrames.add(frame.frameTreeNodeId);
  });
  contents.on('will-frame-navigate', event => {
    const frame = event.frame;
    if (!event.isMainFrame && frame && (protectedFrames.has(frame.frameTreeNodeId) || frame.url === 'about:srcdoc') && event.initiator?.frameTreeNodeId !== contents.mainFrame.frameTreeNodeId) event.preventDefault();
  });
}
