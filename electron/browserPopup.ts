import { BrowserWindow, Menu, clipboard, shell, type HandlerDetails, type WebContents } from 'electron';

export type BrowserPopupEvent = {
  phase: 'requested' | 'opened' | 'navigated' | 'failed' | 'closed';
  guestId: number;
  popupId?: number;
  origin: string;
  disposition?: string;
  named?: boolean;
  errorCode?: number;
};

function webUrl(value: string): string {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

function popupTarget(value: string): boolean {
  return Boolean(webUrl(value)) || /^about:blank(?:[?#]|$)/i.test(value);
}

function wantsPopup(details: HandlerDetails): boolean {
  return details.disposition === 'new-window' || Boolean(details.postBody)
    || Boolean(details.frameName && !/^_(?:blank|self|parent|top)$/i.test(details.frameName));
}

/** Preserve Chromium's WindowProxy, opener, POST body and named-window reuse.
 * Recreating an OAuth URL in an unrelated webview loses all four. */
export function installBrowserPopupHandler(
  guest: WebContents,
  owner: WebContents,
  openTab: (url: string) => void,
  onEvent?: (event: BrowserPopupEvent) => void,
): void {
  const windows = new Set<BrowserWindow>();
  const report = (phase: BrowserPopupEvent['phase'], url: string, detail: Partial<BrowserPopupEvent> = {}) => {
    // OAuth query strings/fragments contain state/codes; never write them to logs.
    const origin = webUrl(url) ? new URL(url).origin : 'about:blank';
    try { onEvent?.({ phase, guestId: guest.id, origin, ...detail }); } catch { /* Diagnostics cannot interrupt login. */ }
  };
  const attach = (contents: WebContents) => {
    contents.setWindowOpenHandler(details => {
      if (owner.isDestroyed() || guest.isDestroyed() || contents.isDestroyed() || guest.hostWebContents?.id !== owner.id) return { action: 'deny' };
      const parent = BrowserWindow.fromWebContents(owner);
      const sourceAllowed = contents === guest ? Boolean(webUrl(contents.getURL())) : popupTarget(contents.getURL());
      if (parent && sourceAllowed && popupTarget(details.url) && wantsPopup(details)) {
        report('requested', details.url, { disposition: details.disposition, named: Boolean(details.frameName) });
        return {
          action: 'allow',
          outlivesOpener: false,
          overrideBrowserWindowOptions: {
            parent, show: parent.isVisible(), width: 560, height: 720, minWidth: 360, minHeight: 400,
            autoHideMenuBar: true, fullscreenable: false,
            webPreferences: {
              session: guest.session, contextIsolation: true, sandbox: true,
              nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false,
              webviewTag: false, webSecurity: true, allowRunningInsecureContent: false,
            },
          },
        };
      }
      openTab(details.url);
      return { action: 'deny' };
    });
    contents.on('did-create-window', (popup, details) => {
      windows.add(popup);
      const child = popup.webContents;
      const originalUrl = webUrl(guest.getURL());
      report('opened', details.url, { popupId: child.id });
      const updateTitle = () => {
        if (popup.isDestroyed() || child.isDestroyed()) return;
        const url = webUrl(child.getURL());
        // Website titles cannot hide which site owns this login window.
        popup.setTitle(url ? `${new URL(url).origin} — CardBush` : 'CardBush');
      };
      popup.on('page-title-updated', event => { event.preventDefault(); updateTitle(); });
      popup.setMenu(Menu.buildFromTemplate([{ label: '页面 / Page', submenu: [
        { label: '重新加载 / Reload', accelerator: 'CmdOrCtrl+R', click: () => child.reload() },
        { label: '复制网址 / Copy address', click: () => { const url = webUrl(child.getURL()); if (url) clipboard.writeText(url); } },
        { label: '在默认浏览器打开原网页 / Open original page in browser', enabled: Boolean(originalUrl),
          click: () => { if (originalUrl) void shell.openExternal(originalUrl).catch(() => {}); } },
        { type: 'separator' }, { role: 'close' },
      ] }]));
      child.on('will-frame-navigate', event => {
        // Local/app resources and external protocols never become popup pages.
        const frameData = !event.isMainFrame && /^(?:data:|blob:)/i.test(event.url);
        if (!popupTarget(event.url) && !frameData) event.preventDefault();
      });
      child.on('will-redirect', (event, url) => { if (!popupTarget(url)) event.preventDefault(); });
      child.on('did-navigate', (_event, url) => { updateTitle(); report('navigated', url, { popupId: child.id }); });
      child.on('did-fail-load', (_event, code, _description, url, main) => {
        if (main && code !== -3) report('failed', url, { popupId: child.id, errorCode: code });
      });
      const popupId = child.id;
      popup.once('closed', () => { windows.delete(popup); report('closed', details.url, { popupId }); });
      attach(child);
      updateTitle();
    });
  };
  attach(guest);
  const close = () => { for (const popup of windows) if (!popup.isDestroyed()) popup.destroy(); windows.clear(); };
  guest.once('destroyed', close);
}
