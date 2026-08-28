export {};

import type {
  CardlingDesktopAction,
  CardlingDesktopState,
} from '../types';

declare global {
  interface Window {
    __cardbushScrollDebug?: Array<Record<string, unknown>>;
    cardbushDesktop?: {
      rendererReady: () => Promise<void>;
      minimize: () => Promise<void>;
      toggleMaximize: () => Promise<void>;
      closeToTray: () => Promise<void>;
      isMaximized: () => Promise<boolean>;
      notifySessionAttention: (payload: {
        sessionId: string;
        title: string;
        body: string;
        kind: 'completed' | 'waiting' | 'error';
      }) => Promise<{ shown: boolean }>;
      setSessionAttentionCount: (count: number) => Promise<void>;
      onOpenSessionAttention: (
        callback: (payload: { sessionId: string }) => void,
      ) => () => void;
      writeDebugLog: (scope: string, payload: unknown) => Promise<string>;
      wallpaperAccent: () => Promise<{
        r: number;
        g: number;
        b: number;
        hex: string;
        source: 'wallpaper' | 'fallback';
      }>;
      wallpaperPath: () => Promise<string>;
      wallpaperDataUrl: () => Promise<string>;
      setWindowTheme: (theme: 'parchment' | 'bright' | 'dark') => Promise<void>;
      bushHeaders: (targetUrl: string, json?: boolean) => Promise<Record<string, string>>;
      cardbushAppRequest: (request: {
        path: string;
        method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
        body?: unknown;
      }) => Promise<unknown>;
      setProxy: (proxy: {
        mode: 'none' | 'system' | 'manual';
        httpProxy: string;
        httpsProxy: string;
        noProxy: string;
      }) => Promise<void>;
      osLoginSettings: () => Promise<{
        enabled: boolean;
        startInOsMode: boolean;
        supported: boolean;
      }>;
      setOsLoginSettings: (value: {
        enabled: boolean;
        startInOsMode: boolean;
      }) => Promise<{
        enabled: boolean;
        startInOsMode: boolean;
        supported: boolean;
      }>;
      osStartupContext: () => Promise<{
        launchedInOsMode: boolean;
        supported: boolean;
      }>;
      setOsShellMode: (enabled: boolean) => Promise<{
        enabled: boolean;
      }>;
      osFilesystemLocations: () => Promise<Array<{
        id: string;
        name: string;
        path: string;
      }>>;
      osListDirectory: (targetPath?: string) => Promise<{
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
      }>;
      osCreateDirectory: (parentPath: string, name: string) => Promise<string>;
      osRenamePath: (sourcePath: string, name: string) => Promise<string>;
      osTrashPath: (targetPath: string) => Promise<void>;
      osListApplications: (forceRefresh?: boolean) => Promise<Array<{
        id: string;
        name: string;
        path: string;
        source: 'start_menu';
        icon: string;
      }>>;
      osRunningApplications: () => Promise<Array<{
        id: string;
        name: string;
        path: string;
        source: 'start_menu';
        icon: string;
      }>>;
      osListWindows: () => Promise<Array<{
        id: string;
        processId: number;
        handle: number;
        title: string;
        processName: string;
        minimized: boolean;
        maximized: boolean;
        icon: string;
      }>>;
      osWindowAction: (
        windowId: string,
        action: 'focus' | 'minimize' | 'maximize' | 'restore' | 'close',
      ) => Promise<{
        ok: boolean;
        windowId: string;
        action: string;
      }>;
      osLaunchApplication: (appId: string) => Promise<{
        status: 'focused' | 'launched' | 'launched_and_focused';
        applicationId: string;
      }>;
      osSearchAppCatalog: (query: string) => Promise<Array<{
        name: string;
        id: string;
        version: string;
        source: string;
      }>>;
      osInstallCatalogApplication: (packageId: string) => Promise<{
        installed: boolean;
        output: string;
      }>;
      listProviderModels: (
        baseUrl: string,
        apiKey: string,
      ) => Promise<{
        endpoint: string;
        models: string[];
        rawCount: number;
      }>;
      pickAttachments: () => Promise<string[]>;
      inspectAttachments: (paths: string[]) => Promise<Array<{
        path: string;
        name: string;
        size: number;
      }>>;
      pickProjectDirectory: () => Promise<string | null>;
      pickFont: () => Promise<string | null>;
      pickBackgroundImage: () => Promise<string | null>;
      cacheBackgroundImage: (path: string) => Promise<string>;
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
      onOpenInspectorRequest: (
        callback: (payload: { target: string; title?: string }) => void,
      ) => () => void;
      openExternal: (targetUrl: string) => Promise<void>;
    };
  }
}
