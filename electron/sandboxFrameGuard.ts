import type { WebContents } from 'electron';

/** Keep the CSP on host-provided srcdoc interfaces until the host replaces the frame. */
export function installSandboxFrameNavigationGuard(contents: WebContents) {
  const protectedFrames = new Set<number>();
  contents.on('frame-created', (_event, { frame }) => {
    if (frame && frame.parent?.frameTreeNodeId === contents.mainFrame.frameTreeNodeId) protectedFrames.add(frame.frameTreeNodeId);
  });
  contents.on('will-frame-navigate', event => {
    const frame = event.frame;
    if (event.isMainFrame || !frame || event.initiator?.frameTreeNodeId === contents.mainFrame.frameTreeNodeId) return;
    if (!protectedFrames.has(frame.frameTreeNodeId) && frame.url !== 'about:srcdoc') return;
    // A website may follow its own links. Host-authored srcdoc documents retain their CSP.
    if (frame.name === 'cardbush-home-website' && event.initiator?.frameTreeNodeId === frame.frameTreeNodeId) {
      const from = URL.parse(frame.url), to = URL.parse(event.url);
      if (from && to && ['http:', 'https:'].includes(from.protocol) && from.origin === to.origin && from.protocol === to.protocol) return;
    }
    event.preventDefault();
  });
}
