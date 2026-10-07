import { app, BrowserWindow, dialog, ipcMain, shell, webContents, type DownloadItem, type Session, type WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BrowserBookmarkImporter, browserWebUrl, type BookmarkImportResult, type BrowserProfile } from './browserImport';
import { BrowserLibrary, type BrowserDownload, type BrowserLibraryPage, type BrowserVisit } from './browserLibrary';
import type { WebApplicationInfo } from '@cardbush/bush-protocol' with { 'resolution-mode': 'import' };

export type BrowserPageCommand = { action: 'status' | 'print' | 'screenshot' }
  | { action: 'zoom'; factor: number }
  | { action: 'device'; size: { width: number; height: number; scale: number } | null };
export type BrowserPageResult = { zoom: number; path?: string; cancelled?: boolean };
export type BrowserClearData = { history: boolean; downloads: boolean; cache: boolean; site: boolean; guestId?: number; origin?: string };
export type BrowserUiBridge = {
  profiles: () => Promise<BrowserProfile[]>;
  importBookmarks: (profileId?: string) => Promise<BookmarkImportResult | null>;
  page: (guestId: number, command: BrowserPageCommand) => Promise<BrowserPageResult>;
  webApplication: (guestId: number, expectedUrl: string) => Promise<WebApplicationInfo>;
  history: (query?: string, offset?: number) => Promise<BrowserLibraryPage<BrowserVisit>>;
  downloads: (query?: string, offset?: number) => Promise<BrowserLibraryPage<BrowserDownload>>;
  removeVisit: (id: string) => Promise<void>;
  downloadAction: (id: string, action: 'pause' | 'resume' | 'cancel' | 'show') => Promise<void>;
  clearData: (input: BrowserClearData) => Promise<void>;
  onFind: (callback: (guestId: number) => void) => () => void;
  onAudioStateChanged: (callback: (guestId: number) => void) => () => void;
};

/** Desktop UI only; none of these data-management endpoints is exposed to models or websites. */
export class BrowserUiService {
  readonly library: BrowserLibrary;
  private guests = new Map<number, number>();
  private sessions = new Set<Session>();
  private downloads = new Map<string, DownloadItem>();
  private devices = new Map<number, Extract<BrowserPageCommand, { action: 'device' }>['size']>();
  private owners = new WeakSet<WebContents>();
  constructor(directory: string, readonly importer = new BrowserBookmarkImporter()) { this.library = new BrowserLibrary(join(directory, 'library.json')); }
  private downloadRecord(id: string, item: DownloadItem): BrowserDownload {
    return { id, url: item.getURL(), name: item.getFilename(), path: item.getSavePath(), received: item.getReceivedBytes(),
      total: item.getTotalBytes(), state: item.getState(), paused: item.isPaused(), startedAt: item.getStartTime() * 1000 };
  }
  attach(owner: WebContents) {
    if (this.owners.has(owner)) return;
    this.owners.add(owner);
    // A URL may download before dom-ready. Attach before the first navigation,
    // while keeping URL filtering in the history store (local previews are excluded).
    owner.on('did-attach-webview', (_event, guest) => this.track(owner, guest.id));
  }
  guest(owner: WebContents, id: number) {
    const guest = Number.isSafeInteger(id) ? webContents.fromId(id) : undefined;
    if (!guest || guest.isDestroyed() || guest.getType() !== 'webview' || guest.hostWebContents?.id !== owner.id || this.guests.get(id) !== owner.id) throw Error('此浏览器标签页已关闭或不属于当前窗口。Browser tab unavailable.');
    return guest;
  }
  track(owner: WebContents, id: number) {
    const guest = webContents.fromId(id);
    if (!guest || guest.isDestroyed() || guest.getType() !== 'webview' || guest.hostWebContents?.id !== owner.id) throw Error('Invalid browser guest.');
    if (this.guests.has(id)) return;
    this.guests.set(id, owner.id);
    let titleTimer: ReturnType<typeof setTimeout> | undefined, lastTitle = '', lastUrl = '';
    const record = (count = true) => {
      if (guest.isDestroyed()) return;
      const url = guest.getURL(), title = guest.getTitle();
      if (!count && url === lastUrl && title === lastTitle) return;
      lastUrl = url; lastTitle = title;
      void this.library.visit(url, title, count).catch(() => {});
    };
    record();
    guest.on('did-navigate', () => record());
    guest.on('did-navigate-in-page', (_event, _url, main) => { if (main) record(); });
    guest.on('page-title-updated', () => { clearTimeout(titleTimer); titleTimer = setTimeout(() => record(false), 200); });
    guest.on('dom-ready', () => { const size = this.devices.get(id); if (size) this.emulate(guest, size); });
    // Chromium aggregates audio from frames and Web Audio, including hidden
    // tabs. Media element play/pause events alone miss some of these changes.
    guest.on('audio-state-changed', () => {
      if (!owner.isDestroyed()) owner.send('browser:audio-state-changed', id);
    });
    guest.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && (input.control || input.meta) && !input.alt && input.key.toLowerCase() === 'f') {
        event.preventDefault();
        if (!owner.isDestroyed()) owner.send('browser:find', id);
      }
    });
    guest.once('destroyed', () => { clearTimeout(titleTimer); this.guests.delete(id); this.devices.delete(id); });
    if (!this.sessions.has(guest.session)) {
      this.sessions.add(guest.session);
      guest.session.on('will-download', (_event, item, source) => {
        if (!source || !this.guests.has(source.id)) return;
        const downloadId = randomUUID();
        this.downloads.set(downloadId, item);
        let lastSave = 0;
        const save = (force = false) => {
          if (!force && Date.now() - lastSave < 1000) return;
          lastSave = Date.now();
          void this.library.download(this.downloadRecord(downloadId, item)).catch(() => {});
        };
        save(true);
        item.on('updated', () => save());
        item.once('done', () => { save(true); this.downloads.delete(downloadId); });
      });
    }
  }
  private emulate(guest: WebContents, size: NonNullable<Extract<BrowserPageCommand, { action: 'device' }>['size']>) {
    guest.enableDeviceEmulation({ screenPosition: 'mobile', screenSize: { width: size.width, height: size.height },
      viewSize: { width: size.width, height: size.height }, viewPosition: { x: 0, y: 0 }, deviceScaleFactor: 1, scale: size.scale });
  }
  async page(owner: WebContents, id: number, command: BrowserPageCommand): Promise<BrowserPageResult> {
    const guest = this.guest(owner, id);
    const result = () => ({ zoom: guest.isDestroyed() ? 1 : guest.getZoomFactor() });
    if (command?.action === 'status') return result();
    if (command?.action === 'zoom') {
      if (!Number.isFinite(command.factor) || command.factor < .25 || command.factor > 5) throw Error('Invalid zoom.');
      guest.setZoomFactor(command.factor); return result();
    }
    if (command?.action === 'device') {
      const size = command.size;
      if (size !== null && (!size || !Number.isInteger(size.width) || !Number.isInteger(size.height) || size.width < 240 || size.width > 3840 || size.height < 240 || size.height > 3840 || !Number.isFinite(size.scale) || size.scale < .05 || size.scale > 1)) throw Error('Invalid device viewport.');
      if (size) { this.emulate(guest, size); this.devices.set(id, size); }
      else { guest.disableDeviceEmulation(); this.devices.delete(id); }
      return result();
    }
    if (command?.action === 'print') {
      const printed = await new Promise<{ success: boolean; reason: string }>(resolve => guest.print({ silent: false, printBackground: true }, (success, reason) => resolve({ success, reason })));
      if (!printed.success && !/cancel/i.test(printed.reason)) throw Error(printed.reason || '打印失败。Printing failed.');
      return { ...result(), cancelled: !printed.success };
    }
    if (command?.action === 'screenshot') {
      const image = await guest.capturePage();
      if (image.isEmpty()) throw Error('当前页面尚未绘制，请稍后再试。Page is not ready for capture.');
      const parent = BrowserWindow.fromWebContents(owner);
      if (!parent) throw Error('Browser window unavailable.');
      const chosen = await dialog.showSaveDialog(parent, { defaultPath: join(app.getPath('downloads'), `CardBush-${Date.now()}.png`), filters: [{ name: 'PNG', extensions: ['png'] }] });
      if (chosen.canceled || !chosen.filePath) return { ...result(), cancelled: true };
      await writeFile(chosen.filePath, image.toPNG()); return { ...result(), path: chosen.filePath };
    }
    throw Error('Unknown browser action.');
  }
  async downloadAction(id: string, action: string) {
    if (action === 'show') {
      const saved = await this.library.findDownload(id);
      if (!saved?.path) throw Error('下载文件尚未保存。Download not saved yet.');
      shell.showItemInFolder(saved.path); return;
    }
    const item = this.downloads.get(id);
    if (!item) throw Error('下载已结束；中断的下载请在原网页重新开始。Download is no longer active.');
    if (action === 'pause') item.pause();
    else if (action === 'resume' && item.canResume()) item.resume();
    else if (action === 'cancel') { item.cancel(); return; }
    else throw Error('Unsupported download action.');
    // Pausing stops progress events, so publish the resulting state immediately.
    await this.library.download(this.downloadRecord(id, item));
  }
  async clear(owner: WebContents, input: BrowserClearData) {
    if (!input || ['history', 'downloads', 'cache', 'site'].some(key => typeof input[key as keyof BrowserClearData] !== 'boolean')) throw Error('Invalid data selection.');
    if (input.site) {
      const guest = this.guest(owner, input.guestId!);
      const url = browserWebUrl(guest.getURL()), appUrl = browserWebUrl(owner.getURL());
      if (!url || new URL(url).origin !== input.origin || appUrl && new URL(appUrl).origin === input.origin) throw Error('页面地址已改变，请重新选择要清理的网站。The selected site changed.');
      // Origin-scoped deletion must never clear the application's localStorage.
      await guest.session.clearData({ origins: [input.origin!], dataTypes: ['cookies', 'localStorage', 'indexedDB', 'fileSystems', 'serviceWorkers', 'cache'] });
    }
    if (input.cache) await owner.session.clearCache();
    await this.library.clear(input.history, input.downloads);
  }
}

export function registerBrowserUiIpc(assertSender: (id: number) => void, createService = () => new BrowserUiService(join(app.getPath('userData'), 'browser'))) {
  let service: BrowserUiService | undefined;
  const get = () => service ??= createService();
  const handle = (channel: string, action: (owner: WebContents, ...args: any[]) => unknown) => ipcMain.handle(`browser:${channel}`, (event, ...args) => {
    assertSender(event.sender.id);
    if (event.senderFrame !== event.sender.mainFrame) throw Error('Browser management is available only in the application.');
    return action(event.sender, ...args);
  });
  handle('profiles', () => get().importer.profiles());
  handle('bookmarks-import', async (owner, profileId?: string) => {
    if (profileId !== undefined) return get().importer.profile(profileId);
    const parent = BrowserWindow.fromWebContents(owner);
    if (!parent) throw Error('Browser window unavailable.');
    const chosen = await dialog.showOpenDialog(parent, { properties: ['openFile'], filters: [{ name: 'Bookmarks', extensions: ['html', 'htm', 'json'] }, { name: 'All files', extensions: ['*'] }] });
    return chosen.canceled || !chosen.filePaths[0] ? null : get().importer.file(chosen.filePaths[0]);
  });
  handle('page', (owner, id: number, command: BrowserPageCommand) => get().page(owner, id, command));
  handle('web-application', async (owner, id: number, expectedUrl: string) => {
    const guest = get().guest(owner, id);
    const { readWebsiteApplication } = await import('./browserWebApplications.mjs');
    return readWebsiteApplication(guest, expectedUrl);
  });
  handle('history', (_owner, query: string, offset: number) => get().library.list('history', typeof query === 'string' ? query : '', offset));
  handle('downloads', (_owner, query: string, offset: number) => get().library.list('downloads', typeof query === 'string' ? query : '', offset));
  handle('history-remove', (_owner, id: string) => get().library.removeVisit(id));
  handle('download-action', (_owner, id: string, action: string) => get().downloadAction(id, action));
  handle('clear-data', (owner, input: BrowserClearData) => get().clear(owner, input));
  return { attach: (owner: WebContents) => get().attach(owner), track: (owner: WebContents, id: number) => get().track(owner, id) };
}
