import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { ReasoningEffort } from '@cardbush/bush-protocol' with { 'resolution-mode': 'import' };

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
  miniChat: {
    title: string;
    lastUser: string;
    lastAssistant: string;
  };
};

type CardlingDesktopAction =
  | 'settings'
  | 'changes'
  | 'revertChanges'
  | 'openMain'
  | { type: 'miniChatSend'; text: string };

type SessionAttentionPayload = {
  sessionId: string;
  title: string;
  body: string;
  kind: 'completed' | 'waiting' | 'error';
};

type RuntimeStartupStatus = {
  phase: 'initializing' | 'ready' | 'error';
  attempt: number;
  startedAt: string;
  completedAt?: string;
  elapsedMs?: number;
  error?: string;
};

type ShadowWindowPayload = {
  windowId: string;
  sessionId: string;
  sourceTurnId: string;
  title: string;
  language: 'zh' | 'en';
  theme: 'parchment' | 'bright' | 'dark';
  accentColor: string;
  modelConfig: Record<string, unknown>;
  reasoningLevel?: ReasoningEffort;
  projectDir: string;
  initialMode: 'readonly' | 'fork';
};

const desktopApi = {
  runtime: {
    command: (message: unknown) =>
      ipcRenderer.invoke('bush-runtime:command', message) as Promise<unknown>,
    startStream: (message: unknown) =>
      ipcRenderer.invoke('bush-runtime:start-stream', message) as Promise<void>,
    stopStream: (message: unknown) =>
      ipcRenderer.invoke('bush-runtime:stop-stream', message) as Promise<void>,
    cancelOperation: (message: unknown) =>
      ipcRenderer.invoke('bush-runtime:cancel-operation', message) as Promise<void>,
    onStreamFrame: (callback: (message: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, message: unknown) =>
        callback(message);
      ipcRenderer.on('bush-runtime:stream-frame', listener);
      return () => ipcRenderer.removeListener('bush-runtime:stream-frame', listener);
    },
  },
  rendererReady: () => ipcRenderer.invoke('app:renderer-ready') as Promise<void>,
  ensureTaskWorkspace: (sessionId: string) =>
    ipcRenderer.invoke('workspace:ensure-task-directory', sessionId) as Promise<string>,
  runtimeStartupStatus: () =>
    ipcRenderer.invoke('app:runtime-startup-status') as Promise<RuntimeStartupStatus>,
  retryRuntimeStartup: () =>
    ipcRenderer.invoke('app:retry-runtime') as Promise<RuntimeStartupStatus>,
  onRuntimeStartupStatus: (callback: (status: RuntimeStartupStatus) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: RuntimeStartupStatus) => callback(status);
    ipcRenderer.on('app:runtime-startup-status', listener);
    return () => ipcRenderer.removeListener('app:runtime-startup-status', listener);
  },
  minimize: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
  closeToTray: () => ipcRenderer.invoke('window:close-to-tray'),
  isMaximized: () => ipcRenderer.invoke('window:is-maximized') as Promise<boolean>,
  openShadowWindow: (payload: Omit<ShadowWindowPayload, 'windowId'>) =>
    ipcRenderer.invoke('shadow:open-window', payload) as Promise<{
      windowId: string;
      reused: boolean;
    }>,
  shadowWindowContext: () =>
    ipcRenderer.invoke('shadow:window-context') as Promise<ShadowWindowPayload>,
  minimizeShadowWindow: () => ipcRenderer.invoke('shadow:window-minimize') as Promise<void>,
  toggleMaximizeShadowWindow: () =>
    ipcRenderer.invoke('shadow:window-toggle-maximize') as Promise<void>,
  isShadowWindowMaximized: () =>
    ipcRenderer.invoke('shadow:window-is-maximized') as Promise<boolean>,
  closeShadowWindow: () => ipcRenderer.invoke('shadow:window-close') as Promise<void>,
  onShadowCloseRequest: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('shadow:close-request', listener);
    return () => ipcRenderer.removeListener('shadow:close-request', listener);
  },
  notifySessionAttention: (payload: SessionAttentionPayload) =>
    ipcRenderer.invoke('attention:notify-session', payload) as Promise<{ shown: boolean }>,
  setSessionAttentionCount: (count: number) =>
    ipcRenderer.invoke('attention:set-count', count) as Promise<void>,
  consumeSessionAttentionOpen: () =>
    ipcRenderer.invoke('attention:consume-open-session') as Promise<{
      sessionId: string;
      queuedAt: number;
    } | null>,
  onOpenSessionAttention: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('attention:open-session', listener);
    return () => ipcRenderer.removeListener('attention:open-session', listener);
  },
  writeDebugLog: (scope: string, payload: unknown) =>
    ipcRenderer.invoke('debug:append-log', scope, payload) as Promise<string>,
  wallpaperAccent: () =>
    ipcRenderer.invoke('appearance:wallpaper-accent') as Promise<{
      r: number;
      g: number;
      b: number;
      hex: string;
      source: 'wallpaper' | 'fallback';
    }>,
  wallpaperPath: () => ipcRenderer.invoke('appearance:wallpaper-path') as Promise<string>,
  wallpaperDataUrl: () => ipcRenderer.invoke('appearance:wallpaper-data-url') as Promise<string>,
  setWindowTheme: (theme: 'parchment' | 'bright' | 'dark') =>
    ipcRenderer.invoke('appearance:set-window-theme', theme) as Promise<void>,
  productHostCommand: (command: unknown) =>
    ipcRenderer.invoke('cardbush-product-host:command', command) as Promise<unknown>,
  a2aInspect: (agentUrl: string) =>
    ipcRenderer.invoke('a2a:inspect', agentUrl) as Promise<unknown>,
  a2aDispatch: (input: {
    agentUrl: string;
    text: string;
    contextId?: string;
    taskId?: string;
  }) => ipcRenderer.invoke('a2a:dispatch', input) as Promise<unknown>,
  setProxy: (proxy: {
    mode: 'none' | 'system' | 'manual';
    httpProxy: string;
    httpsProxy: string;
    noProxy: string;
  }) => ipcRenderer.invoke('network:set-proxy', proxy) as Promise<void>,
  osLoginSettings: () =>
    ipcRenderer.invoke('os:login-settings') as Promise<{
      enabled: boolean;
      startInOsMode: boolean;
      supported: boolean;
    }>,
  setOsLoginSettings: (value: { enabled: boolean; startInOsMode: boolean }) =>
    ipcRenderer.invoke('os:set-login-settings', value) as Promise<{
      enabled: boolean;
      startInOsMode: boolean;
      supported: boolean;
    }>,
  osStartupContext: () =>
    ipcRenderer.invoke('os:startup-context') as Promise<{
      launchedInOsMode: boolean;
      supported: boolean;
    }>,
  setOsShellMode: (enabled: boolean) =>
    ipcRenderer.invoke('os:set-shell-mode', enabled) as Promise<{
      enabled: boolean;
    }>,
  osFilesystemLocations: () =>
    ipcRenderer.invoke('os:filesystem-locations') as Promise<Array<{
      id: string;
      name: string;
      path: string;
    }>>,
  osListDirectory: (targetPath?: string) =>
    ipcRenderer.invoke('os:list-directory', targetPath) as Promise<{
      path: string;
      parentPath: string;
      truncated: boolean;
      items: Array<{
        id: string;
        name: string;
        path: string;
        kind: 'file' | 'directory';
        extension: string;
        size: number;
        modifiedAt: string;
        hidden: boolean;
      }>;
    }>,
  osCreateDirectory: (parentPath: string, name: string) =>
    ipcRenderer.invoke('os:create-directory', parentPath, name) as Promise<string>,
  osRenamePath: (sourcePath: string, name: string) =>
    ipcRenderer.invoke('os:rename-path', sourcePath, name) as Promise<string>,
  osTrashPath: (targetPath: string) =>
    ipcRenderer.invoke('os:trash-path', targetPath) as Promise<void>,
  osListApplications: (forceRefresh?: boolean) => ipcRenderer.invoke('os:list-applications', forceRefresh) as Promise<Array<{
    id: string;
    name: string;
    path: string;
    source: 'start_menu';
    icon: string;
  }>>,
  osRunningApplications: () => ipcRenderer.invoke('os:running-applications') as Promise<Array<{
    id: string;
    name: string;
    path: string;
    source: 'start_menu';
    icon: string;
  }>>,
  osListWindows: () => ipcRenderer.invoke('os:list-windows') as Promise<Array<{
    id: string;
    processId: number;
    handle: number;
    title: string;
    processName: string;
    minimized: boolean;
    maximized: boolean;
    icon: string;
  }>>,
  osWindowAction: (windowId: string, action: 'focus' | 'minimize' | 'maximize' | 'restore' | 'close') =>
    ipcRenderer.invoke('os:window-action', windowId, action) as Promise<{
      ok: boolean;
      windowId: string;
      action: string;
    }>,
  osLaunchApplication: (appId: string) =>
    ipcRenderer.invoke('os:launch-application', appId) as Promise<{
      status: 'focused' | 'launched' | 'launched_and_focused';
      applicationId: string;
    }>,
  osSearchAppCatalog: (query: string) =>
    ipcRenderer.invoke('os:search-app-catalog', query) as Promise<Array<{
      name: string;
      id: string;
      version: string;
      source: string;
    }>>,
  osInstallCatalogApplication: (packageId: string) =>
    ipcRenderer.invoke('os:install-catalog-application', packageId) as Promise<{
      installed: boolean;
      output: string;
    }>,
  listProviderModels: (baseUrl: string, apiKey: string) =>
    ipcRenderer.invoke('models:list', baseUrl, apiKey) as Promise<{
      endpoint: string;
      models: string[];
      rawCount: number;
    }>,
  pickAttachments: () => ipcRenderer.invoke('dialog:pick-attachments') as Promise<string[]>,
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  inspectAttachments: (paths: string[]) =>
    ipcRenderer.invoke('files:inspect-attachments', paths) as Promise<Array<{
      path: string;
      name: string;
      kind: 'file' | 'folder';
      size?: number;
    }>>,
  inspectLocalReference: (targetPath: string) =>
    ipcRenderer.invoke('files:inspect-local-reference', targetPath) as Promise<{
      path: string;
      name: string;
      kind: 'file' | 'folder' | 'application';
      icon?: string;
    } | null>,
  listSkills: () => ipcRenderer.invoke('skills:list') as Promise<unknown[]>,
  readSkill: (skillName: string) =>
    ipcRenderer.invoke('skills:read', skillName) as Promise<unknown>,
  installLocalPlugin: () => ipcRenderer.invoke('plugins:install-local') as Promise<{
    id: string;
    manifestPath: string;
  } | null>,
  pickProjectDirectory: () =>
    ipcRenderer.invoke('dialog:pick-project-directory') as Promise<string | null>,
  pickFont: () => ipcRenderer.invoke('dialog:pick-font') as Promise<string | null>,
  pickBackgroundImage: () =>
    ipcRenderer.invoke('dialog:pick-background-image') as Promise<string | null>,
  cacheBackgroundImage: (path: string) =>
    ipcRenderer.invoke('dialog:cache-background-image', path) as Promise<string>,
  listProjectEntries: (rootPath: string) =>
    ipcRenderer.invoke('project:list-root', rootPath) as Promise<
      Array<{ name: string; path: string; kind: 'file' | 'folder' }>
    >,
  validateProjectRoots: (rootPaths: string[]) =>
    ipcRenderer.invoke('project:validate-roots', rootPaths) as Promise<
      Array<{ rootPath: string; resolvedPath: string; exists: boolean }>
    >,
  searchProjectFiles: (rootPath: string, query: string) =>
    ipcRenderer.invoke('project:search-files', rootPath, query) as Promise<
      Array<{ name: string; path: string; relativePath: string; kind: 'file' | 'folder' }>
    >,
  saveTeamWorkflow: (input: { projectDir?: string; workflowId: string; yaml: string }) =>
    ipcRenderer.invoke('team-workflow:save', input) as Promise<{
      path: string;
      scope: 'project' | 'global';
    }>,
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
  terminalCreate: (
    cwd?: string,
    runtime?: 'powershell' | 'wsl' | 'git_bash' | 'bash',
  ) =>
    ipcRenderer.invoke('terminal:create', cwd, runtime) as Promise<{
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
  terminalRun: (
    command: string,
    cwd?: string,
    runtime?: 'powershell' | 'wsl' | 'git_bash' | 'bash',
  ) =>
    ipcRenderer.invoke('terminal:run', command, cwd, runtime) as Promise<{
      command: string;
      cwd: string;
      exitCode: number | null;
      stdout: string;
      stderr: string;
    }>,
  saveImageDataUrl: (
    dataUrl: string,
    name?: string,
    options?: { copyToClipboard?: boolean },
  ) =>
    ipcRenderer.invoke('image:save-data-url', dataUrl, name, options) as Promise<{
      path: string;
      name: string;
      width: number;
      height: number;
      copiedToClipboard?: boolean;
    }>,
  readImageDataUrl: (targetPath: string) =>
    ipcRenderer.invoke('image:read-data-url', targetPath) as Promise<string>,
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
  openFileInCardbush: (targetPath: string) =>
    ipcRenderer.invoke('shell:open-file-in-cardbush', targetPath) as Promise<string>,
  showFileContextMenu: (targetPath: string) =>
    ipcRenderer.invoke('shell:file-context-menu', targetPath) as Promise<string>,
  openUiPreview: (target: string) =>
    ipcRenderer.invoke('shell:open-ui-preview', target) as Promise<void>,
  readTextPreview: (targetPath: string) =>
    ipcRenderer.invoke('shell:read-text-preview', targetPath) as Promise<{
      path: string;
      content: string;
      size: number;
      modifiedAt: number;
      truncated: boolean;
    }>,
  showInspectorContextMenu: (payload: {
    guestWebContentsId: number;
    target: string;
    x: number;
    y: number;
    mediaType?: string;
    srcURL?: string;
    linkURL?: string;
    selectionText?: string;
    isEditable?: boolean;
  }) => ipcRenderer.invoke('clipboard:show-inspector-context-menu', payload) as Promise<void>,
  onOpenInspectorRequest: (
    callback: (payload: { target: string; title?: string }) => void,
  ) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: { target: string; title?: string },
    ) => callback(payload);
    ipcRenderer.on('shell:open-inspector', listener);
    return () => ipcRenderer.removeListener('shell:open-inspector', listener);
  },
  openExternal: (targetUrl: string) =>
    ipcRenderer.invoke('shell:open-external', targetUrl) as Promise<void>,
};

contextBridge.exposeInMainWorld('cardbushDesktop', desktopApi);
