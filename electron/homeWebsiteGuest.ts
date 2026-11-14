import { session, type Session, type WebContents, type WebPreferences } from 'electron';
import { homeWebsitePartitionPrefix, websiteAddress } from './homeWebsiteAddress';

const siteOrigins = new WeakMap<Session, string>();

export function isHomeWebsiteGuest(guest: WebContents) {
  return siteOrigins.has(guest.session);
}

/** A site selected from Home gets its own in-memory session. */
export function configureHomeWebsite(event: Electron.Event, preferences: WebPreferences, params: Record<string, string>) {
  const partition = params.partition;
  if (!partition?.startsWith(homeWebsitePartitionPrefix)) return false;
  const url = websiteAddress(params.src);
  if (!url || partition !== homeWebsitePartitionPrefix + new URL(url).origin) {
    event.preventDefault();
    return true;
  }
  delete preferences.preload;
  Object.assign(preferences, {
    sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false, webviewTag: false, webSecurity: true, allowRunningInsecureContent: false,
  });
  const site = session.fromPartition(partition);
  if (!siteOrigins.has(site)) {
    const origin = new URL(url).origin;
    siteOrigins.set(site, origin);
    site.setPermissionCheckHandler(() => false);
    site.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    site.setDevicePermissionHandler(() => false);
    site.on('will-download', event => event.preventDefault());
    site.webRequest.onBeforeRequest((request, callback) => {
      const target = URL.parse(request.url);
      // Keep redirects and subsequent document navigations within the displayed origin.
      const allowed = target && (request.resourceType === 'mainFrame'
        ? target.origin === origin && !!websiteAddress(request.url)
        : ['https:', 'wss:', 'data:', 'blob:', 'about:'].includes(target.protocol) || target.origin === origin);
      callback({ cancel: !allowed });
    });
  }
  return true;
}

export function attachHomeWebsite(guest: WebContents) {
  const origin = siteOrigins.get(guest.session);
  if (!origin) return false;
  guest.on('will-frame-navigate', event => {
    const target = URL.parse(event.url);
    const allowed = target && (event.isMainFrame
      ? target.origin === origin && !!websiteAddress(event.url)
      : ['https:', 'http:', 'data:', 'blob:', 'about:'].includes(target.protocol));
    if (!allowed) event.preventDefault();
  });
  guest.setWindowOpenHandler(details => {
    // Sites often use target=_blank for ordinary links. Follow within the same
    // isolated card. Never create a native popup or transfer POST bodies.
    const url = websiteAddress(details.url);
    if (!details.postBody && url && new URL(url).origin === origin) {
      setImmediate(() => { if (!guest.isDestroyed()) void guest.loadURL(url).catch(() => {}); });
    }
    return { action: 'deny' };
  });
  return true;
}
