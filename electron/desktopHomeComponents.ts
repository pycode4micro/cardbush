import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type { HomeToolHost, HomeSnapshot, HomeItem } from './homeComponentTools.mjs' with { 'resolution-mode': 'import' };

type HomeLibrary = HomeToolHost & {
  snapshot(revision?: number): HomeSnapshot | null;
  save(items: HomeItem[], revision: number): HomeSnapshot;
  migrate(items: HomeItem[]): HomeSnapshot;
  close(): void;
};

export function registerDesktopHomeComponents(options: {
  profileDirectory: () => string;
  scriptsDirectory: () => string;
  requireWorkspaceFrame: (event: IpcMainInvokeEvent) => void;
  requireAppFrame: (event: IpcMainInvokeEvent) => void;
  onChanged: () => void;
  onWatchError: (error: unknown) => void;
}) {
  let db: HomeLibrary | undefined;
  let watcher: FSWatcher | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  function stopWatching() {
    clearTimeout(timer);
    watcher?.close();
    watcher = undefined;
  }
  function watchError(error: unknown) {
    stopWatching();
    options.onWatchError(error);
  }
  function library(): HomeLibrary {
    if (disposed) throw new Error('home_components_closed');
    if (db) return db;
    const profile = options.profileDirectory();
    const { openLibrary } = require(join(options.scriptsDirectory(), 'home-library.cjs'));
    const opened: HomeLibrary = openLibrary(profile);
    db = opened;
    try {
      watcher = watch(profile, { persistent: false }, (_event, name) => {
        if (name && !String(name).startsWith('home-components.sqlite')) return;
        clearTimeout(timer);
        timer = setTimeout(options.onChanged, 100);
      });
      watcher.on('error', watchError);
    } catch (error) {
      // Filesystem notifications affect live refresh, not access to the database.
      watchError(error);
    }
    return opened;
  }

  ipcMain.handle('home-components:assemble', (event, files) => {
    options.requireWorkspaceFrame(event);
    const { assembleComponent } = require(join(options.scriptsDirectory(), 'component-files.cjs'));
    return assembleComponent(files);
  });
  ipcMain.handle('assistant:home-component-catalog', event => {
    options.requireAppFrame(event);
    return library().snapshot()?.items.slice(0, 40).map(({ id, title }) => ({ id, title })) ?? [];
  });
  ipcMain.handle('home-components:library', (event, action: unknown, revision, items) => {
    options.requireWorkspaceFrame(event);
    if (action === 'read') return library().snapshot(revision);
    if (action === 'migrate') return library().migrate(items);
    if (action === 'save') return library().save(items, revision);
    throw Error('INVALID_ACTION');
  });

  return { library, dispose() {
    if (disposed) return;
    disposed = true;
    stopWatching();
    db?.close();
    db = undefined;
  } };
}
