import { contextBridge, ipcRenderer } from 'electron';

type CardlingDesktopState = {
  enabled: boolean;
  language: 'zh' | 'en';
  theme: 'parchment' | 'bright' | 'dark';
  settings: {
    size: 'compact' | 'normal' | 'large';
    opacity: number;
    motion: 'full' | 'reduced' | 'off';
  };
  status: 'idle' | 'thinking' | 'tool' | 'waiting' | 'queued' | 'complete' | 'error';
  sending: boolean;
  queuedMessageCount: number;
  pendingInteraction: boolean;
  activeChangeCount: number;
  activeChangeFileCount: number;
  error: string | null;
};

type CardlingDesktopAction = 'settings' | 'changes' | 'revertChanges';

const desktopApi = {
  rendererReady: () => ipcRenderer.invoke('app:renderer-ready') as Promise<void>,
  minimize: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
  closeToTray: () => ipcRenderer.invoke('window:close-to-tray'),
  isMaximized: () => ipcRenderer.invoke('window:is-maximized') as Promise<boolean>,
  wallpaperAccent: () =>
    ipcRenderer.invoke('appearance:wallpaper-accent') as Promise<{
      r: number;
      g: number;
      b: number;
      hex: string;
      source: 'wallpaper' | 'fallback';
    }>,
  bushHeaders: (targetUrl: string, json = false) =>
    ipcRenderer.invoke('bush:headers', targetUrl, json) as Promise<Record<string, string>>,
  setProxy: (proxy: {
    mode: 'system' | 'manual';
    httpProxy: string;
    httpsProxy: string;
    noProxy: string;
  }) => ipcRenderer.invoke('network:set-proxy', proxy) as Promise<void>,
  pickAttachments: () => ipcRenderer.invoke('dialog:pick-attachments') as Promise<string[]>,
  pickProjectDirectory: () =>
    ipcRenderer.invoke('dialog:pick-project-directory') as Promise<string | null>,
  pickFont: () => ipcRenderer.invoke('dialog:pick-font') as Promise<string | null>,
  listProjectEntries: (rootPath: string) =>
    ipcRenderer.invoke('project:list-root', rootPath) as Promise<
      Array<{ name: string; path: string; kind: 'file' | 'folder' }>
    >,
  searchProjectFiles: (rootPath: string, query: string) =>
    ipcRenderer.invoke('project:search-files', rootPath, query) as Promise<
      Array<{ name: string; path: string; relativePath: string; kind: 'file' | 'folder' }>
    >,
  gitInfo: (rootPath: string) =>
    ipcRenderer.invoke('project:git-info', rootPath) as Promise<{
      branch: string;
      root: string;
      changedFiles: Array<{ path: string; status: string }>;
      missing?: boolean;
      error?: string;
    }>,
  gitBranches: (rootPath: string) =>
    ipcRenderer.invoke('project:git-branches', rootPath) as Promise<string[]>,
  gitCheckout: (rootPath: string, branch: string) =>
    ipcRenderer.invoke('project:git-checkout', rootPath, branch) as Promise<{
      branch: string;
      output: string;
    }>,
  gitCreateBranch: (rootPath: string, branch: string) =>
    ipcRenderer.invoke('project:git-create-branch', rootPath, branch) as Promise<{
      branch: string;
      output: string;
    }>,
  gitCommit: (rootPath: string, message: string) =>
    ipcRenderer.invoke('project:git-commit', rootPath, message) as Promise<{
      output: string;
    }>,
  gitPush: (rootPath: string) =>
    ipcRenderer.invoke('project:git-push', rootPath) as Promise<{
      output: string;
    }>,
  revertFileChanges: (
    rootPath: string,
    files: Array<{ path: string; diff?: string; lines?: string[] }>,
  ) =>
    ipcRenderer.invoke('project:revert-file-changes', rootPath, files) as Promise<{
      revertedFiles: number;
      output: string;
    }>,
  terminalCreate: (cwd?: string) =>
    ipcRenderer.invoke('terminal:create', cwd) as Promise<{
      id: string;
      cwd: string;
      shell: string;
    }>,
  terminalWrite: (id: string, data: string) => ipcRenderer.send('terminal:write', id, data),
  terminalResize: (id: string, cols: number, rows: number) =>
    ipcRenderer.send('terminal:resize', id, cols, rows),
  terminalClose: (id: string) => ipcRenderer.invoke('terminal:close', id) as Promise<void>,
  onTerminalData: (callback: (payload: { id: string; data: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { id: string; data: string }) => {
      callback(payload);
    };
    ipcRenderer.on('terminal:data', listener);
    return () => ipcRenderer.removeListener('terminal:data', listener);
  },
  onTerminalExit: (
    callback: (payload: { id: string; exitCode: number | null }) => void,
  ) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: { id: string; exitCode: number | null },
    ) => {
      callback(payload);
    };
    ipcRenderer.on('terminal:exit', listener);
    return () => ipcRenderer.removeListener('terminal:exit', listener);
  },
  terminalRun: (command: string, cwd?: string) =>
    ipcRenderer.invoke('terminal:run', command, cwd) as Promise<{
      command: string;
      cwd: string;
      exitCode: number | null;
      stdout: string;
      stderr: string;
    }>,
  captureScreenshot: (options?: { hideWindow?: boolean }) =>
    ipcRenderer.invoke('screenshot:capture', options) as Promise<{
      path: string;
      name: string;
      width: number;
      height: number;
      dataUrl?: string;
      windows?: Array<{
        id: string;
        name: string;
        path: string;
        width: number;
        height: number;
        dataUrl?: string;
      }>;
    }>,
  saveScreenshotDataUrl: (dataUrl: string, name?: string) =>
    ipcRenderer.invoke('screenshot:save-edited', dataUrl, name) as Promise<{
      path: string;
      name: string;
      width: number;
      height: number;
    }>,
  onScreenshotShortcut: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('screenshot:trigger', listener);
    return () => ipcRenderer.removeListener('screenshot:trigger', listener);
  },
  setCardlingState: (payload: CardlingDesktopState) =>
    ipcRenderer.invoke('cardling:update-state', payload) as Promise<void>,
  onCardlingState: (callback: (payload: CardlingDesktopState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: CardlingDesktopState) => {
      callback(payload);
    };
    ipcRenderer.on('cardling:state', listener);
    return () => ipcRenderer.removeListener('cardling:state', listener);
  },
  setCardlingExpanded: (expanded: boolean) =>
    ipcRenderer.invoke('cardling:set-expanded', expanded) as Promise<void>,
  startCardlingDrag: (cursorX: number, cursorY: number) =>
    ipcRenderer.invoke('cardling:drag-start', cursorX, cursorY) as Promise<void>,
  endCardlingDrag: () =>
    ipcRenderer.invoke('cardling:drag-end') as Promise<void>,
  moveCardlingBy: (deltaX: number, deltaY: number) =>
    ipcRenderer.invoke('cardling:move-by', deltaX, deltaY) as Promise<void>,
  resetCardlingPosition: () =>
    ipcRenderer.invoke('cardling:reset-position') as Promise<void>,
  cardlingAction: (action: CardlingDesktopAction) =>
    ipcRenderer.invoke('cardling:action', action) as Promise<void>,
  onCardlingAction: (callback: (action: CardlingDesktopAction) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, action: CardlingDesktopAction) => {
      callback(action);
    };
    ipcRenderer.on('cardling:action', listener);
    return () => ipcRenderer.removeListener('cardling:action', listener);
  },
  onCardlingCollapse: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('cardling:collapse', listener);
    return () => ipcRenderer.removeListener('cardling:collapse', listener);
  },
  openPath: (targetPath: string) =>
    ipcRenderer.invoke('shell:open-path', targetPath) as Promise<string>,
  openExternal: (targetUrl: string) =>
    ipcRenderer.invoke('shell:open-external', targetUrl) as Promise<void>,
};

contextBridge.exposeInMainWorld('cardbushDesktop', desktopApi);
