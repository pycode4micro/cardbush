export {};

import type {
  CardlingDesktopAction,
  CardlingDesktopState,
} from '../types';

declare global {
  interface Window {
    cardbushDesktop?: {
      rendererReady: () => Promise<void>;
      minimize: () => Promise<void>;
      toggleMaximize: () => Promise<void>;
      closeToTray: () => Promise<void>;
      isMaximized: () => Promise<boolean>;
      wallpaperAccent: () => Promise<{
        r: number;
        g: number;
        b: number;
        hex: string;
        source: 'wallpaper' | 'fallback';
      }>;
      bushHeaders: (targetUrl: string, json?: boolean) => Promise<Record<string, string>>;
      setProxy: (proxy: {
        mode: 'system' | 'manual';
        httpProxy: string;
        httpsProxy: string;
        noProxy: string;
      }) => Promise<void>;
      pickAttachments: () => Promise<string[]>;
      pickProjectDirectory: () => Promise<string | null>;
      pickFont: () => Promise<string | null>;
      listProjectEntries: (
        rootPath: string,
      ) => Promise<Array<{ name: string; path: string; kind: 'file' | 'folder' }>>;
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
      terminalCreate: (cwd?: string) => Promise<{
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
      ) => Promise<{
        command: string;
        cwd: string;
        exitCode: number | null;
        stdout: string;
        stderr: string;
      }>;
      captureScreenshot: (options?: { hideWindow?: boolean }) => Promise<{
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
      }>;
      saveScreenshotDataUrl: (
        dataUrl: string,
        name?: string,
      ) => Promise<{
        path: string;
        name: string;
        width: number;
        height: number;
      }>;
      onScreenshotShortcut: (callback: () => void) => () => void;
      setCardlingState: (payload: CardlingDesktopState) => Promise<void>;
      onCardlingState: (
        callback: (payload: CardlingDesktopState) => void,
      ) => () => void;
      setCardlingExpanded: (expanded: boolean) => Promise<void>;
      moveCardlingBy: (deltaX: number, deltaY: number) => Promise<void>;
      resetCardlingPosition: () => Promise<void>;
      cardlingAction: (action: CardlingDesktopAction) => Promise<void>;
      onCardlingAction: (
        callback: (action: CardlingDesktopAction) => void,
      ) => () => void;
      onCardlingCollapse: (callback: () => void) => () => void;
      openPath: (targetPath: string) => Promise<string>;
      openExternal: (targetUrl: string) => Promise<void>;
    };
  }
}
