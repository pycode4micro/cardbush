import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { BrowserConfiguration, ReasoningEffort } from '@cardbush/bush-protocol' with { 'resolution-mode': 'import' };
import type { AgentInstructionDocument } from '@cardbush/bush-product-agent' with { 'resolution-mode': 'import' };
import type { readTextPreviewResult } from './textPreview';
import type { TerminalRuntime } from '@cardbush/platform' with { 'resolution-mode': 'import' };

type CardlingDesktopState = {
  enabled: boolean;
  language: 'zh' | 'en';
  theme: 'bright' | 'dark' | 'cyberpunk';
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

type ChromeConnectorStatus = {
  protocol: 'cardbush.chrome_connector.v1';
  platformSupported: boolean;
  packagedApplication: boolean;
  bridgeRegistered: boolean;
  nativeHostAvailable: boolean;
  nativeHostPath: string;
  bridgeRunning: boolean;
  extensionConnected: boolean;
  extensionVersion?: string;
  extensionDirectory: string;
  extensionId: string;
  storeUrl?: string;
  setupMessage?: string;
  connectedAt?: string;
  activeTabId?: number;
  activeTabTitle?: string;
  activeTabUrl?: string;
  controlledTabCount: number;
  lastError?: string;
};

type ShadowWindowPayload = {
  windowId: string;
  sessionId: string;
  sourceTurnId: string;
  title: string;
  language: 'zh' | 'en';
  theme: 'bright' | 'dark' | 'cyberpunk';
  accentColor: string;
  themeVariables?: Record<string, string>;
  modelConfig: Record<string, unknown>;
  reasoningLevel?: ReasoningEffort;
  projectDir: string;
  initialMode: 'readonly' | 'fork';
};

const desktopApi = {
  agents: {
    filePreview: (id: string, sessionId: string, path: string) => ipcRenderer.invoke('agents:command', 'file-preview', { id, sessionId, path }),
    releaseFilePreview: (id: string) => ipcRenderer.invoke('agents:command', 'release-file-preview', id),
    list: () => ipcRenderer.invoke('agents:command', 'list'),
    save: (input: unknown) => ipcRenderer.invoke('agents:command', 'save', input),
    remove: (id: string) => ipcRenderer.invoke('agents:command', 'remove', id),
    connect: (id: string) => ipcRenderer.invoke('agents:command', 'connect', id),
    disconnect: (id: string) => ipcRenderer.invoke('agents:command', 'disconnect', id),
    call: (id: string, operation: string, input?: Record<string, unknown>) => ipcRenderer.invoke('agents:command', 'call', { id, operation, input }),
    watchEvents: (id: string, request: import('./agentTypes.js').AgentEventRequest, callback: (frame: import('./agentTypes.js').AgentEventFrame) => void) => {
      const subscriptionId = crypto.randomUUID();
      const listener = (_event: Electron.IpcRendererEvent, receivedId: string, frame: import('./agentTypes.js').AgentEventFrame) => { if (receivedId === subscriptionId) callback(frame); };
      ipcRenderer.on('agents:events:frame', listener);
      ipcRenderer.send('agents:events:start', { subscriptionId, id, request });
      return () => { ipcRenderer.removeListener('agents:events:frame', listener); ipcRenderer.send('agents:events:stop', subscriptionId); };
    },
  },
  platform: process.platform,
  hostCapabilities: () => ipcRenderer.invoke('app:host-capabilities'),
  mcpRequests: () => ipcRenderer.invoke('mcp:requests'),
  answerMcpRequest: (id: string, answer: unknown) => ipcRenderer.invoke('mcp:answer', id, answer),
  openMcpRequestUrl: (id: string) => ipcRenderer.invoke('mcp:open-request-url', id),
  mcpConnectionAction: (serverId: string, action: string) => ipcRenderer.invoke('mcp:connection-action', serverId, action),
  openAiAccountStatus: () => ipcRenderer.invoke('openai:account-status'),
  accountsSnapshot: () => ipcRenderer.invoke('accounts:snapshot'),
  accountsAction: (input: import('@cardbush/bush-protocol', { with: { 'resolution-mode': 'import' } }).AccountCommand) => ipcRenderer.invoke('accounts:action', input),
  onAccountsChanged: (callback: () => void) => { const listener = () => callback(); ipcRenderer.on('accounts:changed', listener); return () => ipcRenderer.removeListener('accounts:changed', listener); },
  openAiAccountAction: (action: string) => ipcRenderer.invoke('openai:account-action', action),
  onOpenAiAccountChanged: (callback: () => void) => { const listener = () => callback(); ipcRenderer.on('openai:account-changed', listener); return () => ipcRenderer.removeListener('openai:account-changed', listener); },
  savePluginConnections: (input: unknown) => ipcRenderer.invoke('plugins:save-connections', input),
  pluginTroubleshootingContext: (pluginId: string, componentId: string) => ipcRenderer.invoke('plugins:troubleshooting-context', pluginId, componentId),
  automationCommand: (input: unknown) => ipcRenderer.invoke('automation:command', input),
  calendarCommand: (input: unknown) => ipcRenderer.invoke('calendar:command', input),
  conversationExtracts: {
    preview: (selection: unknown) => ipcRenderer.invoke('conversation-extracts:command', { action: 'preview', selection }),
    list: () => ipcRenderer.invoke('conversation-extracts:command', { action: 'list' }),
    save: (selection: unknown, kind: string) => ipcRenderer.invoke('conversation-extracts:command', { action: 'save', selection, kind }),
    consume: (id: string) => ipcRenderer.invoke('conversation-extracts:command', { action: 'consume', id }),
    resolve: (id: string, contextWindowTokens?: number) => ipcRenderer.invoke('conversation-extracts:command', { action: 'resolve', id, contextWindowTokens }),
    export: (selection: unknown) => ipcRenderer.invoke('conversation-extracts:command', { action: 'export', selection }),
    remove: (id: string) => ipcRenderer.invoke('conversation-extracts:command', { action: 'remove', id }),
    onChanged: (callback: () => void) => {
      const listener = () => callback(); ipcRenderer.on('conversation-extracts:changed', listener);
      return () => ipcRenderer.removeListener('conversation-extracts:changed', listener);
    },
  },
  onCalendarChanged: (callback: () => void) => { const listener = () => callback(); ipcRenderer.on('calendar:changed', listener); return () => ipcRenderer.removeListener('calendar:changed', listener); },
  onAutomationChanged: (callback: () => void) => { const listener = () => callback(); ipcRenderer.on('automation:changed', listener); return () => ipcRenderer.removeListener('automation:changed', listener); },
  onMcpRequestsChanged: (callback: () => void) => { const listener = () => callback(); ipcRenderer.on('mcp:requests-changed', listener); return () => ipcRenderer.removeListener('mcp:requests-changed', listener); },
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
  chromeConnectorStatus: () =>
    ipcRenderer.invoke('chrome-connector:status') as Promise<ChromeConnectorStatus>,
  setupChromeConnector: () =>
    ipcRenderer.invoke('chrome-connector:setup') as Promise<ChromeConnectorStatus>,
  openChromeConnectorInstaller: () =>
    ipcRenderer.invoke('chrome-connector:open-installer') as Promise<{
      opened: boolean;
      method: 'store' | 'unpacked';
      target: string;
    }>,
  revealChromeConnectorExtension: () =>
    ipcRenderer.invoke('chrome-connector:reveal-extension') as Promise<string>,
  onChromeConnectorStatus: (callback: (status: ChromeConnectorStatus) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: ChromeConnectorStatus) => callback(status);
    ipcRenderer.on('chrome-connector:status', listener);
    return () => ipcRenderer.removeListener('chrome-connector:status', listener);
  },
  readGlobalInstructions: () => ipcRenderer.invoke('instructions:read-global') as Promise<import('./globalInstructions').GlobalInstructionsSnapshot>,
  usageStatistics: () => ipcRenderer.invoke('usage:statistics') as Promise<import('./usageLedger').UsageStatistics>,
  readAgentInstructions: (projectDir?: string, workspaceDir?: string) =>
    ipcRenderer.invoke('instructions:read-applicable', projectDir, workspaceDir) as Promise<AgentInstructionDocument[]>,
  saveGlobalInstructions: (content: string, revision: string) =>
    ipcRenderer.invoke('instructions:save-global', content, revision) as Promise<import('./globalInstructions').GlobalInstructionsSnapshot>,
  minimize: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
  closeToTray: () => ipcRenderer.invoke('window:close-to-tray'),
  isMaximized: () => ipcRenderer.invoke('window:is-maximized') as Promise<boolean>,
  windowMenuContext: () => ipcRenderer.invoke('window:menu-context') as Promise<{ editTargetId: number }>,
  executeWindowMenuAction: (action: import('./windowMenu').WindowMenuAction, editTargetId?: number) =>
    ipcRenderer.invoke('window:menu-action', action, editTargetId) as Promise<void>,
  onWindowMenuKeyDown: (callback: (gesture: { key: string; code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, gesture: Parameters<typeof callback>[0]) => callback(gesture);
    ipcRenderer.on('window:menu-keydown', listener);
    return () => ipcRenderer.removeListener('window:menu-keydown', listener);
  },
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
  windowScrollDiagnosticConfig: () => ipcRenderer.invoke('debug:window-scroll-config'),
  onWindowScrollDiagnosticEvent: (callback: (event: Record<string, unknown>) => void) => {
    const listener = (_event: unknown, value: Record<string, unknown>) => callback(value);
    ipcRenderer.on('debug:window-scroll-event', listener);
    return () => ipcRenderer.removeListener('debug:window-scroll-event', listener);
  },
  showErrorDialog: (error: { title: string; message: string }) =>
    ipcRenderer.invoke('app:show-error', error) as Promise<void>,
  restoreEditorFocus: (state: { documentFocused: boolean; passive?: boolean }) =>
    ipcRenderer.invoke('window:restore-editor-focus', state) as Promise<boolean>,
  wallpaperAccent: () =>
    ipcRenderer.invoke('appearance:wallpaper-accent') as Promise<{
      r: number;
      g: number;
      b: number;
      hex: string;
      source: 'wallpaper' | 'fallback';
    }>,
  setWindowTheme: (theme: 'bright' | 'dark' | 'cyberpunk', options?: import('./windowAppearance').WindowAppearanceOptions) =>
    ipcRenderer.invoke('appearance:set-window-theme', theme, options) as Promise<import('./windowAppearance').WindowAppearanceState | undefined>,
  publishVisualTheme: (context: import('./visualThemeContextSchema').VisualThemeContext) =>
    ipcRenderer.invoke('appearance:publish-visual-theme', context) as Promise<void>,
  onWindowAppearanceChanged: (callback: (state: import('./windowAppearance').WindowAppearanceState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: import('./windowAppearance').WindowAppearanceState) => callback(state);
    ipcRenderer.on('appearance:window-changed', listener);
    return () => ipcRenderer.removeListener('appearance:window-changed', listener);
  },
  productHostCommand: (command: unknown) =>
    ipcRenderer.invoke('cardbush-product-host:command', command) as Promise<unknown>,
  setProxy: (proxy: {
    mode: 'none' | 'system' | 'manual';
    httpProxy: string;
    httpsProxy: string;
    noProxy: string;
  }) => ipcRenderer.invoke('network:set-proxy', proxy) as Promise<void>,
  preparePluginUiNetwork: () => ipcRenderer.invoke('plugins:prepare-ui-network') as Promise<void>,
  filesystemLocations: () =>
    ipcRenderer.invoke('filesystem:locations') as Promise<Array<{
      id: string;
      name: string;
      path: string;
    }>>,
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
      mtimeMs?: number;
    }>>,
  inspectLocalReference: (targetPath: string) =>
    ipcRenderer.invoke('files:inspect-local-reference', targetPath) as Promise<{
      path: string;
      name: string;
      kind: 'file' | 'folder' | 'application';
      icon?: string;
    } | null>,
  listSkills: () => ipcRenderer.invoke('skills:list') as Promise<unknown[]>,
  onCapabilityCatalogChanged: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('capabilities:changed', listener);
    return () => ipcRenderer.removeListener('capabilities:changed', listener);
  },
  readSkill: (skillName: string) =>
    ipcRenderer.invoke('skills:read', skillName) as Promise<unknown>,
  installLocalPlugin: (kind: 'directory' | 'zip' = 'directory') => ipcRenderer.invoke('plugins:install-local', kind) as Promise<{
    id: string;
    manifestPath: string;
  } | null>,
  pluginCommands: () => ipcRenderer.invoke('plugins:commands'),
  uninstallPlugin: (pluginId: string) => ipcRenderer.invoke('plugins:uninstall', pluginId),
  pluginMarketSources: () => ipcRenderer.invoke('plugins:market-sources'),
  addPluginMarket: (source: string) => ipcRenderer.invoke('plugins:market-add', source),
  addLocalPluginMarket: () => ipcRenderer.invoke('plugins:market-add-local'),
  removePluginMarket: (id: string) => ipcRenderer.invoke('plugins:market-remove', id),
  pluginMarketCatalog: (id: string, refresh = false) => ipcRenderer.invoke('plugins:market-catalog', id, refresh),
  pluginMarketPresentation: (id: string, name: string) => ipcRenderer.invoke('plugins:market-presentation', id, name),
  previewMarketPlugin: (sourceId: string, name: string) => ipcRenderer.invoke('plugins:market-preview', sourceId, name),
  installMarketPlugin: (token: string) => ipcRenderer.invoke('plugins:market-install', token),
  pickProjectDirectory: () =>
    ipcRenderer.invoke('dialog:pick-project-directory') as Promise<string | null>,
  sshConnections: {
    list: () => ipcRenderer.invoke('ssh:connections', 'list'),
    save: (input: import('@cardbush/bush-protocol', { with: { 'resolution-mode': 'import' } }).SshConnectionInput) => ipcRenderer.invoke('ssh:connections', 'save', input),
    remove: (id: string) => ipcRenderer.invoke('ssh:connections', 'remove', id),
    test: (id: string) => ipcRenderer.invoke('ssh:connections', 'test', id),
    directory: (uri: string) => ipcRenderer.invoke('ssh:connections', 'directory', uri),
    disconnect: (id: string) => ipcRenderer.invoke('ssh:connections', 'disconnect', id),
    pickKey: () => ipcRenderer.invoke('ssh:connections', 'pick-key'),
  },
  pickFont: () => ipcRenderer.invoke('dialog:pick-font') as Promise<string | null>,
  pickAppearanceStyle: () =>
    ipcRenderer.invoke('dialog:pick-appearance-style') as Promise<string | null>,
  listProjectEntries: (rootPath: string) =>
    ipcRenderer.invoke('project:list-root', rootPath) as Promise<
      Array<{ name: string; path: string; kind: 'file' | 'folder' }>
    >,
  readWorkspaceDirectory: (input: { rootPath: string; directoryPath?: string; offset?: number }) =>
    ipcRenderer.invoke('files:read-workspace-directory', input) as Promise<import('./workspaceFiles').WorkspaceDirectoryPage>,
  validateProjectRoots: (rootPaths: string[]) =>
    ipcRenderer.invoke('project:validate-roots', rootPaths) as Promise<
      Array<{ rootPath: string; resolvedPath: string; exists: boolean }>
    >,
  renameProjectDirectory: (input: { rootPath: string; name: string }) =>
    ipcRenderer.invoke('project:rename-directory', input) as Promise<{
      previousPath: string;
      nextPath: string;
      changed: boolean;
    }>,
  searchProjectFiles: (rootPath: string, query: string) =>
    ipcRenderer.invoke('project:search-files', rootPath, query) as Promise<
      Array<{ name: string; path: string; relativePath: string; kind: 'file' | 'folder' }>
    >,
  saveTeamWorkflow: (input: { projectDir?: string; workflowId: string; yaml: string }) =>
    ipcRenderer.invoke('team-workflow:save', input) as Promise<{
      path: string;
      scope: 'project' | 'global';
    }>,
  runtimePluginRenderers: () => ipcRenderer.invoke('plugins:runtime-renderers'),
  runtimePluginFile: (input: { pluginId: string; action: 'import' | 'export' | 'reveal'; text?: string; name?: string; yaml?: string }) => ipcRenderer.invoke('plugins:extension-file', input),
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
  restoreFileChanges: (
    rootPath: string,
    files: Array<{ path: string; diff?: string; lines?: string[] }>,
  ) =>
    ipcRenderer.invoke('project:restore-file-changes', rootPath, files) as Promise<{
      restoredFiles: number;
      output: string;
    }>,
  terminalCreate: (
    cwd?: string,
    runtime?: TerminalRuntime,
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
    runtime?: TerminalRuntime,
  ) =>
    ipcRenderer.invoke('terminal:run', command, cwd, runtime) as Promise<{
      command: string;
      cwd: string;
      exitCode: number | null;
      stdout: string;
      stderr: string;
      outputTruncated?: boolean;
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
  startImageGallery: (root: string, recursive: boolean) => ipcRenderer.invoke('image:gallery-start', root, recursive),
  nextImageGallery: (id: string) => ipcRenderer.invoke('image:gallery-next', id),
  closeImageGallery: (id: string) => ipcRenderer.invoke('image:gallery-close', id) as Promise<void>,
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
  showFileContextMenu: (targetPath: string, options?: import('./fileContextMenu').FileContextMenuOptions) =>
    ipcRenderer.invoke('shell:file-context-menu', targetPath, options) as Promise<string>,
  openUiPreview: (target: string) =>
    ipcRenderer.invoke('shell:open-ui-preview', target) as Promise<void>,
  readBrowserConfiguration: () => ipcRenderer.invoke('browser:settings-read') as Promise<BrowserConfiguration>,
  updateBrowserConfiguration: (input: { startPage: string; expectedRevision: number }) =>
    ipcRenderer.invoke('browser:settings-update', input) as Promise<BrowserConfiguration>,
  onInspectorOpenLink: (callback: (detail: { guestWebContentsId: number; target: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, detail: { guestWebContentsId: number; target: string }) => callback(detail);
    ipcRenderer.on('inspector:open-link', listener);
    return () => ipcRenderer.removeListener('inspector:open-link', listener);
  },
  readTextPreview: (targetPath: string) =>
    ipcRenderer.invoke('shell:read-text-preview', targetPath).then(
      (result: Awaited<ReturnType<typeof readTextPreviewResult>>) => {
        if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
        return result.value;
      },
    ),
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
