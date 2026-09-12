import type { BrowserWindow, WebContents } from 'electron';
import type { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type WindowScrollDiagnosticConfig = { runId: string; expiresAt: number; logPath: string };
export const windowScrollDiagnosticChannel = 'debug:window-scroll-event';

/** Opt-in capture that survives a normal app restart, with a fixed expiry. */
export class WindowScrollDiagnostics {
  readonly config: WindowScrollDiagnosticConfig;
  #writes: Promise<unknown> = Promise.resolve();
  #cleanups: Array<() => void> = [];
  #contents?: WebContents;
  #disposed = false;

  constructor(private readonly target: BrowserWindow, logsDir: string) {
    const now = Date.now();
    let expiresAt = 0;
    try {
      const setting = JSON.parse(fs.readFileSync(path.join(logsDir, 'window-scroll-debug.json'), 'utf8'));
      const requested = Date.parse(setting.expiresAt);
      if (setting.enabled === true && Number.isFinite(requested) && requested > now) {
        expiresAt = Math.min(requested, now + 24 * 60 * 60 * 1000);
      }
    } catch { /* No diagnostic request: ordinary launches stay uninstrumented. */ }
    if (process.env.CARDBUSH_WINDOW_SCROLL_DEBUG === '1') expiresAt = now + 30 * 60 * 1000;
    this.config = { runId: randomUUID(), expiresAt, logPath: path.join(logsDir, 'window-scroll.log') };
    if (!expiresAt || target.isDestroyed()) return;
    // BrowserWindow.webContents is a native getter and throws after `closed`.
    // Retain the emitter while it is alive so cleanup never re-reads that getter.
    const contents = this.#contents = target.webContents;
    const events = ['focus', 'blur', 'show', 'hide', 'minimize', 'restore', 'resize', 'resized', 'maximize', 'unmaximize'];
    for (const event of events) {
      const listener = () => this.#sample(event);
      (target as EventEmitter).on(event, listener);
      this.#cleanups.push(() => (target as EventEmitter).removeListener(event, listener));
    }
    const loaded = () => this.#sample('renderer-loaded');
    contents.on('did-finish-load', loaded);
    this.#cleanups.push(() => contents.removeListener('did-finish-load', loaded));
    const dispose = () => this.dispose();
    target.once('closed', dispose);
    this.#cleanups.push(() => target.removeListener('closed', dispose));
    contents.once('destroyed', dispose);
    this.#cleanups.push(() => contents.removeListener('destroyed', dispose));
    const expiry = setTimeout(dispose, expiresAt - now);
    expiry.unref();
    this.#cleanups.push(() => clearTimeout(expiry));
    this.#sample('diagnostics-enabled');
  }

  append(payload: unknown): Promise<string> {
    if (!this.config.expiresAt || Date.now() > this.config.expiresAt + 5000) return Promise.resolve(this.config.logPath);
    // The renderer sends one bounded batch after each capture. Disk writes must
    // not block the Electron event loop while measuring a visual disturbance.
    const line = JSON.stringify({ at: new Date().toISOString(), runId: this.config.runId, payload }) + '\n';
    if (Buffer.byteLength(line) > 1024 * 1024) return Promise.reject(new Error('Diagnostic batch exceeds limit'));
    const write = this.#writes.then(async () => {
      const file = this.config.logPath;
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      const size = await fs.promises.stat(file).then(stat => stat.size, () => 0);
      if (size >= 12 * 1024 * 1024) {
        const previous = file.replace(/\.log$/, '.previous.log');
        await fs.promises.rm(previous, { force: true });
        await fs.promises.rename(file, previous);
      }
      await fs.promises.appendFile(file, line, 'utf8');
      return file;
    });
    this.#writes = write.catch(() => undefined);
    return write;
  }

  #sample(event: string) {
    const target = this.target;
    const contents = this.#contents;
    if (this.#disposed || target.isDestroyed() || !contents || contents.isDestroyed() || Date.now() >= this.config.expiresAt) return;
    const entry = {
      source: 'native', event, at: new Date().toISOString(), runId: this.config.runId,
      windowId: target.id, visible: target.isVisible(), focused: target.isFocused(),
      minimized: target.isMinimized(), maximized: target.isMaximized(),
      bounds: target.getBounds(), contentBounds: target.getContentBounds(),
      viewBounds: target.contentView.getBounds(), zoom: contents.getZoomFactor(),
    };
    void this.append(entry).catch(() => undefined);
    if (!contents.isDestroyed()) contents.send(windowScrollDiagnosticChannel, entry);
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const cleanup of this.#cleanups.splice(0)) cleanup();
    this.#contents = undefined;
  }
}
