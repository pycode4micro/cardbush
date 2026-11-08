import type { BrowserWindow } from 'electron';

const owners = new WeakMap<Electron.WebContents, BrowserWindow>();

/** One session policy for the app and its embedded pages, installed before loading. */
export function installAppSessionPermissions(window: BrowserWindow): void {
  owners.set(window.webContents, window);
  const session = window.webContents.session;
  const trusted = (contents: Electron.WebContents | null, isMainFrame: boolean, url?: string) => {
    if (!contents || contents.session !== session || !isMainFrame) return false;
    const owner = owners.get(contents);
    return Boolean(owner && !owner.isDestroyed() && (!url || url === contents.getURL()));
  };
  session.setPermissionCheckHandler((contents, permission, _origin, details) => {
    // A website's custom-protocol probe must not launch an OS app/Store chooser.
    // Explicit app UI actions use the main-process shell bridge separately.
    if (permission === 'openExternal') return false;
    if (permission !== 'media') return true;
    return trusted(contents, details.isMainFrame, details.requestingUrl) && details.mediaType === 'audio';
  });
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (permission === 'openExternal') { callback(false); return; }
    if (permission !== 'media') { callback(true); return; }
    const types = (details as Electron.MediaAccessPermissionRequest).mediaTypes;
    callback(trusted(contents, details.isMainFrame, details.requestingUrl) && Boolean(types?.length && types.every(type => type === 'audio')));
  });
}
