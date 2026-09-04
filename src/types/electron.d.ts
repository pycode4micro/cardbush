export {};

import type {
  CardlingDesktopAction,
  CardlingDesktopState,
  ManagedModelConfig,
  ReasoningLevel,
  RuntimeStartupStatus,
  ThemeMode,
} from '../types';

interface ChromeConnectorStatus {
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
}

declare global {
  interface Window {
    __cardbushScrollDebug?: Array<Record<string, unknown>>;
    __cardbushUiPerformance?: Array<Record<string, unknown>>;
    cardbushDesktop?: {
      runtime: {
        command: (message: unknown) => Promise<unknown>;
        startStream: (message: unknown) => Promise<void>;
        stopStream: (message: unknown) => Promise<void>;
        cancelOperation: (message: unknown) => Promise<void>;
        onStreamFrame: (callback: (message: unknown) => void) => () => void;
      };
      rendererReady: () => Promise<void>;
      ensureTaskWorkspace: (sessionId: string) => Promise<string>;
      runtimeStartupStatus: () => Promise<RuntimeStartupStatus>;
      retryRuntimeStartup: () => Promise<RuntimeStartupStatus>;
      chromeConnectorStatus: () => Promise<ChromeConnectorStatus>;
      setupChromeConnector: () => Promise<ChromeConnectorStatus>;
      openChromeConnectorInstaller: () => Promise<{
        opened: boolean;
        method: 'store' | 'unpacked';
        target: string;
      }>;
      revealChromeConnectorExtension: () => Promise<string>;
      onChromeConnectorStatus: (
        callback: (status: ChromeConnectorStatus) => void,
      ) => () => void;
      onRuntimeStartupStatus: (
        callback: (status: RuntimeStartupStatus) => void,
      ) => () => void;
      minimize: () => Promise<void>;
      toggleMaximize: () => Promise<void>;
      closeToTray: () => Promise<void>;
      isMaximized: () => Promise<boolean>;
      openShadowWindow: (payload: {
        sessionId: string;
        sourceTurnId: string;
        title: string;
        language: 'zh' | 'en';
        theme: ThemeMode;
        accentColor: string;
        themeVariables?: Record<string, string>;
        modelConfig: ManagedModelConfig;
        reasoningLevel?: ReasoningLevel;
        projectDir: string;
        initialMode: 'readonly' | 'fork';
      }) => Promise<{ windowId: string; reused: boolean }>;
      shadowWindowContext: () => Promise<{
        windowId: string;
        sessionId: string;
        sourceTurnId: string;
        title: string;
        language: 'zh' | 'en';
        theme: ThemeMode;
        accentColor: string;
        themeVariables?: Record<string, string>;
        modelConfig: ManagedModelConfig;
        reasoningLevel?: ReasoningLevel;
        projectDir: string;
        initialMode: 'readonly' | 'fork';
      }>;
      minimizeShadowWindow: () => Promise<void>;
      toggleMaximizeShadowWindow: () => Promise<void>;
      isShadowWindowMaximized: () => Promise<boolean>;
      closeShadowWindow: () => Promise<void>;
      onShadowCloseRequest: (callback: () => void) => () => void;
      notifySessionAttention: (payload: {
        sessionId: string;
        title: string;
        body: string;
        kind: 'completed' | 'waiting' | 'error';
      }) => Promise<{ shown: boolean }>;
      setSessionAttentionCount: (count: number) => Promise<void>;
      consumeSessionAttentionOpen: () => Promise<{
        sessionId: string;
        queuedAt: number;
      } | null>;
      onOpenSessionAttention: (
        callback: () => void,
      ) => () => void;
      writeDebugLog: (scope: string, payload: unknown) => Promise<string>;
      wallpaperAccent: () => Promise<{
        r: number;
        g: number;
        b: number;
        hex: string;
        source: 'wallpaper' | 'fallback';
      }>;
      setWindowTheme: (theme: 'parchment' | 'bright' | 'dark' | 'cyberpunk') => Promise<void>;
      productHostCommand: (command: unknown) => Promise<unknown>;
      listSkills: () => Promise<unknown[]>;
      readSkill: (skillName: string) => Promise<unknown>;
      installLocalPlugin: () => Promise<{ id: string; manifestPath: string } | null>;
      setProxy: (proxy: {
        mode: 'none' | 'system' | 'manual';
        httpProxy: string;
        httpsProxy: string;
        noProxy: string;
      }) => Promise<void>;
      filesystemLocations: () => Promise<Array<{
        id: string;
        name: string;
        path: string;
      }>>;
      listProviderModels: (
        baseUrl: string,
        apiKey: string,
      ) => Promise<{
        endpoint: string;
        models: string[];
        rawCount: number;
      }>;
      pickAttachments: () => Promise<string[]>;
      getPathForFile: (file: File) => string;
      inspectAttachments: (paths: string[]) => Promise<Array<{
        path: string;
        name: string;
        kind: 'file' | 'folder';
        size?: number;
      }>>;
      inspectLocalReference: (targetPath: string) => Promise<{
        path: string;
        name: string;
        kind: 'file' | 'folder' | 'application';
        icon?: string;
      } | null>;
      pickProjectDirectory: () => Promise<string | null>;
      pickFont: () => Promise<string | null>;
      pickAppearanceStyle: () => Promise<string | null>;
      listProjectEntries: (
        rootPath: string,
      ) => Promise<Array<{ name: string; path: string; kind: 'file' | 'folder' }>>;
      validateProjectRoots: (
        rootPaths: string[],
      ) => Promise<Array<{
        rootPath: string;
        resolvedPath: string;
        exists: boolean;
      }>>;
      renameProjectDirectory: (input: {
        rootPath: string;
        name: string;
      }) => Promise<{
        previousPath: string;
        nextPath: string;
        changed: boolean;
      }>;
      searchProjectFiles: (
        rootPath: string,
        query: string,
      ) => Promise<
        Array<{
          name: string;
          path: string;
          relativePath: string;
          kind: 'file' | 'folder';
        }>
      >;
      saveTeamWorkflow: (input: {
        projectDir?: string;
        workflowId: string;
        yaml: string;
      }) => Promise<{
        path: string;
        scope: 'project' | 'global';
      }>;
      gitInfo: (
        rootPath: string,
      ) => Promise<{
        branch: string;
        root: string;
        changedFiles: Array<{ path: string; status: string }>;
        missing?: boolean;
        error?: string;
      }>;
      gitBranches: (rootPath: string) => Promise<string[]>;
      gitCheckout: (
        rootPath: string,
        branch: string,
      ) => Promise<{
        branch: string;
        output: string;
      }>;
      gitCreateBranch: (
        rootPath: string,
        branch: string,
      ) => Promise<{
        branch: string;
        output: string;
      }>;
      gitCommit: (
        rootPath: string,
        message: string,
      ) => Promise<{
        output: string;
      }>;
      gitPush: (
        rootPath: string,
      ) => Promise<{
        output: string;
      }>;
      revertFileChanges: (
        rootPath: string,
        files: Array<{ path: string; diff?: string; lines?: string[] }>,
      ) => Promise<{
        revertedFiles: number;
        output: string;
      }>;
      terminalCreate: (
        cwd?: string,
        runtime?: 'powershell' | 'wsl' | 'git_bash' | 'bash',
      ) => Promise<{
        id: string;
        cwd: string;
        shell: string;
      }>;
      terminalWrite: (id: string, data: string) => void;
      terminalResize: (id: string, cols: number, rows: number) => void;
      terminalClose: (id: string) => Promise<void>;
      onTerminalData: (
        callback: (payload: { id: string; data: string }) => void,
      ) => () => void;
      onTerminalExit: (
        callback: (payload: { id: string; exitCode: number | null }) => void,
      ) => () => void;
      terminalRun: (
        command: string,
        cwd?: string,
        runtime?: 'powershell' | 'wsl' | 'git_bash' | 'bash',
      ) => Promise<{
        command: string;
        cwd: string;
        exitCode: number | null;
        stdout: string;
        stderr: string;
      }>;
      saveImageDataUrl: (
        dataUrl: string,
        name?: string,
        options?: { copyToClipboard?: boolean },
      ) => Promise<{
        path: string;
        name: string;
        width: number;
        height: number;
        copiedToClipboard?: boolean;
      }>;
      readImageDataUrl: (targetPath: string) => Promise<string>;
      setCardlingState: (payload: CardlingDesktopState) => Promise<void>;
      onCardlingState: (
        callback: (payload: CardlingDesktopState) => void,
      ) => () => void;
      setCardlingExpanded: (expanded: boolean) => Promise<void>;
      startCardlingDrag: (cursorX: number, cursorY: number) => Promise<void>;
      endCardlingDrag: () => Promise<void>;
      moveCardlingBy: (deltaX: number, deltaY: number) => Promise<void>;
      resetCardlingPosition: () => Promise<void>;
      cardlingAction: (action: CardlingDesktopAction) => Promise<void>;
      onCardlingAction: (
        callback: (action: CardlingDesktopAction) => void,
      ) => () => void;
      onCardlingCollapse: (callback: () => void) => () => void;
      openPath: (targetPath: string) => Promise<string>;
      openFileInCardbush: (targetPath: string) => Promise<string>;
      showFileContextMenu: (targetPath: string) => Promise<string>;
      openUiPreview: (target: string) => Promise<void>;
      readTextPreview: (targetPath: string) => Promise<{
        path: string;
        content: string;
        size: number;
        modifiedAt: number;
        truncated: boolean;
      }>;
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
      }) => Promise<void>;
      onOpenInspectorRequest: (
        callback: (payload: { target: string; title?: string }) => void,
      ) => () => void;
      openExternal: (targetUrl: string) => Promise<void>;
    };
  }
}
