import type { WebContents } from 'electron';

/** Route guest popups into the owning inspector instead of creating native windows. */
export function installInspectorWindowOpen(owner: WebContents): void {
  owner.on('did-attach-webview', (_event, guest) => {
    guest.setWindowOpenHandler(({ url }) => {
      if (!owner.isDestroyed() && !guest.isDestroyed() && guest.hostWebContents?.id === owner.id) {
        const target = inspectorWindowTarget(url, guest.getURL());
        if (target) owner.send('inspector:open-link', { guestWebContentsId: guest.id, target });
      }
      return { action: 'deny' };
    });
  });
}

function inspectorWindowTarget(value: string, opener: string): string {
  try {
    const target = new URL(value);
    if (target.protocol === 'http:' || target.protocol === 'https:') return target.href;
    // Local HTML previews can link to neighboring files; websites cannot open local resources.
    const local = (protocol: string) => protocol === 'file:' || protocol === 'cardbush-file:';
    if (local(target.protocol) && local(new URL(opener).protocol)) return target.href;
  } catch { /* Ignore empty, malformed and executable popup targets. */ }
  return '';
}
