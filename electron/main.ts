import {
  app,
  BrowserWindow,
  clipboard,
  Menu,
  net,
  Notification,
  protocol,
  Tray,
  dialog,
  ipcMain,
  nativeImage,
  screen,
  session,
  shell,
  webContents as electronWebContents,
  type NativeImage,
  type MenuItemConstructorOptions,
  type OpenDialogOptions,
} from 'electron';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  ReasoningEffort,
  RuntimeIpcOutboundMessage,
} from '@cardbush/bush-protocol' with { 'resolution-mode': 'import' };

import { inspectProjectRoots } from './projectRoots';
import { renameProjectDirectory } from './projectDirectories';
import { isOfficePreviewPath, renderOfficePreview } from './officePreview';
import { localFileSystemPathFromProtocolUrl } from './localFileProtocol';
import {
  listProductSkills,
  migrateLegacyProductSkills,
  readProductSkill,
  type ProductSkillRoot,
} from './productSkills';
import {
  installProductPlugin,
  loadEnabledProductPluginSkillRootEntries,
  type PluginRoot,
} from './productPlugins';
import {
  SessionAttentionOpenQueue,
  decodeSessionAttentionActivation,
  encodeSessionAttentionActivation,
} from './sessionAttentionRouting';
import {
  ChromeConnectorBroker,
  type ChromeConnectorStatus,
} from './chromeConnectorBroker';
import {
  chromeConnectorRegistrationStatus,
  registerChromeConnectorNativeHost,
} from './chromeConnectorRegistration';

const devServerUrl = process.env.CARDBUSH_ELECTRON_DEV_SERVER_URL?.trim();
const localFileProtocol = 'cardbush-file';
const cardbushProductionAppUserModelId = 'com.cardbush.desktop';
const cardbushDevelopmentRuntime =
  process.env.CARDBUSH_DEVELOPMENT_RUNTIME?.trim() === '1';
const cardbushRuntimeIsPackaged = app.isPackaged && !cardbushDevelopmentRuntime;
const windowCompositionDebugEnabled =
  process.env.CARDBUSH_WINDOW_COMPOSITION_DEBUG?.trim() === '1';
const cardbushDevelopmentRuntimeIdentity =
  path
    .basename(process.execPath)
    .match(/^cardbush-dev-([a-f0-9]+)\.exe$/i)?.[1]
    ?.toLowerCase() ?? 'default';
const cardbushAppUserModelId = cardbushRuntimeIsPackaged
  ? cardbushProductionAppUserModelId
  : `${cardbushProductionAppUserModelId}.development.${cardbushDevelopmentRuntimeIdentity}`;
const cardbushDisplayName = 'cardbush';
const desktopStartupStartedAt = Date.now();
const runtimeStartupStatusChannel = 'app:runtime-startup-status';
const runtimeServicesStartupTimeoutMs = 15_000;
const packagedSmokeResultPath = process.env.CARDBUSH_PACKAGED_SMOKE_RESULT?.trim() ?? '';
const packagedSmokeMode = packagedSmokeResultPath.length > 0;
const bushRuntimeIpcProtocol = 'bush.runtime_ipc.v1' as const;
const cancelRuntimeToolCommand = 'runtime.cancel_tool' as const;
// BrowserWindow#setIcon is most reliable on Windows when it receives a
// high-resolution PNG. Keep the multi-resolution ICO for Shell metadata and
// shortcuts, where Windows explicitly requires an .ico file.
const logoAssetNames = ['cardbush-logo.png', 'cardbush-logo-backup.png', 'cardbush.ico'];
const cardlingExpandedSize = { width: 380, height: 468 };
const cardlingCollapsedHitSize = { width: 104, height: 104 };
const ignoredProjectSearchDirs = new Set([
  '.git',
  '.hg',
  '.svn',
  '.dart_tool',
  '.gradle',
  '.idea',
  '.next',
  '.nuxt',
  '.parcel-cache',
  '.svelte-kit',
  '.turbo',
  '.venv',
  '.vscode',
  '__pycache__',
  'build',
  'coverage',
  'dist',
  'dist-electron',
  'node_modules',
  'out',
  'target',
  'venv',
]);
const projectFileSearchMaxDepth = 3;
const projectFileSearchMaxVisited = 1800;
const projectFileSearchMaxResults = 60;
const localImagePreviewMaxBytes = 32 * 1024 * 1024;
const logScopePattern = /^[a-z0-9_-]{1,48}$/i;
protocol.registerSchemesAsPrivileged([
  {
    scheme: localFileProtocol,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

let mainWindow: BrowserWindow | null = null;
type RuntimeHostController = {
  start: () => Promise<unknown>;
  stop: () => void;
  command: (message: unknown) => Promise<unknown>;
  startStream: (message: unknown) => Promise<void>;
  stopStream: (message: unknown) => Promise<void>;
  cancelOperation: (message: unknown) => Promise<void>;
  onStreamFrame: (listener: (message: RuntimeIpcOutboundMessage) => void) => () => void;
};

let runtimeHostController: RuntimeHostController | null = null;
let unregisterRuntimeHostIpc: (() => void) | null = null;
let unregisterDesktopControlMonitor: (() => void) | null = null;
type DesktopControlTurn = { sessionId: string; turnId: string; toolCallId: string };
let chromeConnectorBroker: ChromeConnectorBroker | null = null;
let unregisterChromeConnectorStatus: (() => void) | null = null;
let cachedChromeConnectorRegistrationStatus:
  ReturnType<typeof chromeConnectorRegistrationStatus> | null = null;
let productHostController: {
  execute: (command: unknown) => Promise<unknown>;
  executeTool: (request: { toolName: string; input: unknown }) => Promise<unknown>;
  shutdown: () => Promise<void>;
} | null = null;
let cardlingWindow: BrowserWindow | null = null;
type ShadowWindowMode = 'readonly' | 'fork';
type ShadowWindowPayload = {
  windowId: string;
  sessionId: string;
  sourceTurnId: string;
  title: string;
  language: 'zh' | 'en';
  theme: AppThemeMode;
  accentColor: string;
  themeVariables?: Record<string, string>;
  modelConfig: {
    id: string;
    provider: string;
    apiKey: string;
    hasApiKey?: boolean;
    apiKeyMasked?: string;
    modelName: string;
    baseUrl: string;
    maxContextTokens?: number;
    maxCompletionTokens?: number;
  };
  reasoningLevel?: ReasoningEffort;
  projectDir: string;
  initialMode: ShadowWindowMode;
};
type ShadowWindowState = {
  window: BrowserWindow;
  key: string;
  payload: ShadowWindowPayload;
  allowClose: boolean;
  closeFallbackTimer: ReturnType<typeof setTimeout> | null;
};
const shadowWindows = new Map<number, ShadowWindowState>();
const shadowWindowIdsByKey = new Map<string, number>();
let tray: Tray | null = null;
let isQuitting = false;
let hostShutdownComplete = false;
let hostShutdownPromise: Promise<void> | null = null;
let quitFallbackTimer: ReturnType<typeof setTimeout> | null = null;
let startupRevealFallback: ReturnType<typeof setTimeout> | null = null;
let legacyProductSkillMigration: Promise<void> | null = null;
const legacyProductSkillNamesOwnedByCardbush = [
  'browser-assistant',
  'interior-cad-design',
  'interior-design-cn',
  'pptx',
  'scheduled-delivery',
  'skill-manager',
  'transport-delivery',
  'windows-control',
  'xlsx',
];
type RuntimeStartupStatus = {
  phase: 'initializing' | 'ready' | 'error';
  attempt: number;
  startedAt: string;
  completedAt?: string;
  elapsedMs?: number;
  error?: string;
};
let runtimeStartupStatus: RuntimeStartupStatus = {
  phase: 'initializing',
  attempt: 0,
  startedAt: new Date(desktopStartupStartedAt).toISOString(),
};
let runtimeServicesInitialization: Promise<void> | null = null;
let packagedSmokeRendererReadyResolve: (() => void) | null = null;
const packagedSmokeRendererReady = new Promise<void>((resolve) => {
  packagedSmokeRendererReadyResolve = resolve;
});
let cardlingExpanded = false;
let cardlingApplyingBounds = false;
if (process.platform === 'win32') {
  app.setName(cardbushDisplayName);
  app.setAppUserModelId(cardbushAppUserModelId);
}
let cardlingApplyingBoundsTimer: ReturnType<typeof setTimeout> | null = null;
let cardlingDragState: {
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
  interval: ReturnType<typeof setInterval>;
  timeout: ReturnType<typeof setTimeout>;
} | null = null;
let lastCardlingState: CardlingDesktopState | null = null;
let sessionAttentionCount = 0;
const sessionAttentionOpenQueue = new SessionAttentionOpenQueue();
const activeSessionAttentionNotifications = new Set<Notification>();
const terminalSessions = new Map<
  string,
  {
    process: ChildProcessWithoutNullStreams;
    ownerId: number;
    cwd: string;
  }
>();

type TerminalRuntime = 'powershell' | 'wsl' | 'git_bash' | 'bash';

type CardlingDesktopState = {
  enabled: boolean;
  language: 'zh' | 'en';
  theme: 'parchment' | 'bright' | 'dark' | 'cyberpunk';
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
  miniChat?: {
    title?: string;
    lastUser?: string;
    lastAssistant?: string;
  };
};

type AppThemeMode = CardlingDesktopState['theme'];

const mainWindowThemeBackgrounds: Record<AppThemeMode, string> = {
  // Keep native window colors opaque and in six-digit RGB form. Although
  // Electron documents ARGB hex support, the Windows runtime used by the dev
  // launcher silently kept the HWND background at its default #FFFFFF when an
  // eight-digit value was supplied.
  dark: '#1a1a1a',
  bright: '#f5f3ef',
  parchment: '#e1d4ba',
  cyberpunk: '#050607',
};

let lastMainWindowTheme: AppThemeMode = 'dark';
let windowCompositionTraceSequence = 0;

type CardlingDesktopAction =
  | 'settings'
  | 'changes'
  | 'revertChanges'
  | 'openMain'
  | { type?: string; text?: string };

type ProjectFileSearchResult = {
  name: string;
  path: string;
  relativePath: string;
  kind: 'file' | 'folder';
};

type UiPreviewTarget = {
  url: string;
  externalTarget: string;
  localPath?: string;
};

function appLogsDir() {
  return path.join(cardbushRuntimeIsPackaged ? app.getPath('userData') : process.cwd(), 'logs');
}

function appendDebugLog(scope: string, payload: unknown) {
  const safeScope = logScopePattern.test(scope) ? scope : 'renderer';
  const logsDir = appLogsDir();
  fs.mkdirSync(logsDir, { recursive: true });
  const filePath = path.join(logsDir, `${safeScope}.log`);
  const entry = {
    at: new Date().toISOString(),
    payload,
  };
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
  return filePath;
}

function capturedFrameTelemetry(image: NativeImage) {
  if (image.isEmpty()) {
    return { empty: true };
  }
  const originalSize = image.getSize();
  const sampleWidth = Math.min(192, Math.max(1, originalSize.width));
  const sampleHeight = Math.max(
    1,
    Math.round((originalSize.height / Math.max(1, originalSize.width)) * sampleWidth),
  );
  const sample = image.resize({
    width: sampleWidth,
    height: sampleHeight,
    quality: 'good',
  });
  const sampleSize = sample.getSize();
  const bitmap = sample.toBitmap({ scaleFactor: 1 });
  const pixelCount = Math.min(
    sampleSize.width * sampleSize.height,
    Math.floor(bitmap.length / 4),
  );
  if (pixelCount <= 0) {
    return { empty: true, originalSize, sampleSize };
  }

  let redTotal = 0;
  let greenTotal = 0;
  let blueTotal = 0;
  let whitePixels = 0;
  let darkPixels = 0;
  let transparentPixels = 0;
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    const offset = pixelIndex * 4;
    const blue = bitmap[offset] ?? 0;
    const green = bitmap[offset + 1] ?? 0;
    const red = bitmap[offset + 2] ?? 0;
    const alpha = bitmap[offset + 3] ?? 255;
    redTotal += red;
    greenTotal += green;
    blueTotal += blue;
    if (red >= 242 && green >= 242 && blue >= 242 && alpha >= 240) {
      whitePixels += 1;
    }
    if (red <= 40 && green <= 40 && blue <= 40 && alpha >= 240) {
      darkPixels += 1;
    }
    if (alpha <= 16) {
      transparentPixels += 1;
    }
  }

  const ratio = (count: number) => Number((count / pixelCount).toFixed(4));
  return {
    empty: false,
    originalSize,
    sampleSize,
    averageRgb: {
      red: Math.round(redTotal / pixelCount),
      green: Math.round(greenTotal / pixelCount),
      blue: Math.round(blueTotal / pixelCount),
    },
    whitePixelRatio: ratio(whitePixels),
    darkPixelRatio: ratio(darkPixels),
    transparentPixelRatio: ratio(transparentPixels),
  };
}

function traceMainWindowComposition(
  target: BrowserWindow,
  event: string,
  delays: number[] = [0, 48, 160],
) {
  if (!windowCompositionDebugEnabled || target.isDestroyed()) {
    return;
  }
  const traceId = ++windowCompositionTraceSequence;
  const startedAt = Date.now();
  const expectedBackground = backgroundForMainWindowTheme(lastMainWindowTheme);
  const nativeState = () => {
    if (target.isDestroyed()) {
      return { destroyed: true };
    }
    return {
      destroyed: false,
      visible: target.isVisible(),
      focused: target.isFocused(),
      minimized: target.isMinimized(),
      maximized: target.isMaximized(),
      fullScreen: target.isFullScreen(),
      bounds: target.getBounds(),
      contentBounds: target.getContentBounds(),
      nativeBackground: target.getBackgroundColor(),
      expectedBackground,
      theme: lastMainWindowTheme,
    };
  };

  appendDebugLog('window-composition', {
    stage: 'native-event',
    traceId,
    event,
    native: nativeState(),
  });

  for (const delay of delays) {
    setTimeout(() => {
      if (target.isDestroyed()) {
        appendDebugLog('window-composition', {
          stage: 'composition-snapshot',
          traceId,
          event,
          delay,
          elapsedMs: Date.now() - startedAt,
          native: { destroyed: true },
        });
        return;
      }
      const rendererStatePromise = target.webContents
        .executeJavaScript(`(() => {
          const computed = (element) => element == null ? null : getComputedStyle(element);
          const html = computed(document.documentElement);
          const body = computed(document.body);
          const root = computed(document.getElementById('root'));
          return {
            visibilityState: document.visibilityState,
            readyState: document.readyState,
            hidden: document.hidden,
            htmlBackgroundColor: html?.backgroundColor ?? null,
            htmlBackgroundImage: html?.backgroundImage ?? null,
            bodyBackgroundColor: body?.backgroundColor ?? null,
            bodyBackgroundImage: body?.backgroundImage ?? null,
            rootBackgroundColor: root?.backgroundColor ?? null,
            rootBackgroundImage: root?.backgroundImage ?? null,
            viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
          };
        })()`)
        .catch((error: unknown) => ({
          error: error instanceof Error ? error.message : String(error),
        }));
      const capturedFramePromise = target.webContents
        .capturePage()
        .then(capturedFrameTelemetry)
        .catch((error: unknown) => ({
          error: error instanceof Error ? error.message : String(error),
        }));

      void Promise.all([rendererStatePromise, capturedFramePromise]).then(
        ([renderer, capturedFrame]) => {
          appendDebugLog('window-composition', {
            stage: 'composition-snapshot',
            traceId,
            event,
            delay,
            elapsedMs: Date.now() - startedAt,
            native: nativeState(),
            renderer,
            capturedFrame,
          });
        },
      );
    }, delay);
  }
}

function createWindow(options: { reveal?: boolean } = {}) {
  if (mainWindow != null && !mainWindow.isDestroyed()) {
    return mainWindow;
  }
  if (startupRevealFallback != null) {
    clearTimeout(startupRevealFallback);
    startupRevealFallback = null;
  }
  const loadedWindowIcon = loadCardbushIconWithSource(256);
  const windowIcon = loadedWindowIcon.image;
  const window = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 960,
    minHeight: 620,
    frame: false,
    title: 'cardbush',
    icon: windowIcon,
    backgroundColor: mainWindowThemeBackgrounds.dark,
    backgroundMaterial: 'none',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      backgroundThrottling: false,
    },
  });
  applyCardbushWindowIcon(window, windowIcon, 'create-window', loadedWindowIcon.sourcePath);
  mainWindow = window;
  window.setMenu(null);
  applyMainWindowVisualMaterial(window, lastMainWindowTheme);

  installMainWindowNavigationGuard(window);
  installMainRendererResilience(window);
  window.webContents.once('did-finish-load', () => {
    applyCardbushWindowIcon(window, windowIcon, 'did-finish-load', loadedWindowIcon.sourcePath);
  });

  const refreshWindowBackdrop = () => {
    applyCardbushWindowIcon(window, windowIcon);
    applyMainWindowVisualMaterial(window, lastMainWindowTheme);
  };
  window.on('minimize', refreshWindowBackdrop);
  window.on('minimize', () => traceMainWindowComposition(window, 'minimize'));
  window.on('restore', refreshWindowBackdrop);
  window.on('restore', () => traceMainWindowComposition(window, 'restore'));
  window.on('show', refreshWindowBackdrop);
  window.on('show', () => traceMainWindowComposition(window, 'show', [0, 80]));
  window.on('hide', () => traceMainWindowComposition(window, 'hide', [0, 80]));
  window.on('blur', () => traceMainWindowComposition(window, 'blur', [0, 80]));
  window.on('maximize', () => traceMainWindowComposition(window, 'maximize'));
  window.on('unmaximize', () => traceMainWindowComposition(window, 'unmaximize'));
  window.on('focus', () => {
    refreshWindowBackdrop();
    traceMainWindowComposition(window, 'focus');
    window.flashFrame(false);
  });
  applySessionAttentionBadge();

  if (options.reveal !== false) {
    startupRevealFallback = setTimeout(() => {
      if (!window.isDestroyed() && !window.isVisible()) {
        applyMainWindowVisualMaterial(window, lastMainWindowTheme);
        window.show();
      }
    }, 5000);
  }

  window.once('closed', () => {
    if (startupRevealFallback != null) {
      clearTimeout(startupRevealFallback);
      startupRevealFallback = null;
    }
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  window.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      if (!window.isDestroyed()) {
        window.hide();
      }
    }
  });

  loadRenderer(window, 'main');
  return window;
}

function shadowWindowKey(sessionId: string, sourceTurnId: string) {
  return `${sessionId}\u0000${sourceTurnId}`;
}

function sanitizeShadowWindowPayload(value: unknown): Omit<ShadowWindowPayload, 'windowId'> {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const model = input.modelConfig && typeof input.modelConfig === 'object'
    ? input.modelConfig as Record<string, unknown>
    : {};
  const sessionId = String(input.sessionId ?? '').trim();
  if (!sessionId) throw new Error('Shadow requires an existing conversation.');
  const modelId = String(model.id ?? '').trim();
  if (!modelId) throw new Error('Shadow requires a configured model.');
  const optionalPositive = (candidate: unknown) => {
    const number = Number(candidate);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
  };
  const theme = input.theme === 'bright' || input.theme === 'parchment' ||
      input.theme === 'cyberpunk'
    ? input.theme
    : 'dark';
  const requestedReasoningLevel = String(input.reasoningLevel ?? '').trim().toLowerCase();
  const reasoningLevel: ReasoningEffort = requestedReasoningLevel === 'none' ||
      requestedReasoningLevel === 'low' || requestedReasoningLevel === 'medium' ||
      requestedReasoningLevel === 'high' || requestedReasoningLevel === 'xhigh' ||
      requestedReasoningLevel === 'max'
    ? requestedReasoningLevel
    : 'high';
  const themeVariableInput = input.themeVariables && typeof input.themeVariables === 'object'
    ? input.themeVariables as Record<string, unknown>
    : {};
  const allowedThemeVariables = new Set([
    '--bg', '--surface', '--surface-strong', '--surface-raised', '--border',
    '--accent', '--accent-soft', '--text', '--text-mid', '--text-soft',
    '--user-bubble', '--terminal-bg', '--danger',
  ]);
  const themeVariables = Object.fromEntries(
    Object.entries(themeVariableInput).filter(([key, rawValue]) => {
      const themeValue = typeof rawValue === 'string' ? rawValue.trim() : '';
      return allowedThemeVariables.has(key) && themeValue.length > 0 &&
        themeValue.length <= 96 && !/[;{}]|url\s*\(|var\s*\(|expression/i.test(themeValue);
    }).map(([key, rawValue]) => [key, String(rawValue).trim()]),
  );
  return {
    sessionId,
    sourceTurnId: String(input.sourceTurnId ?? '').trim(),
    title: String(input.title ?? 'Shadow').trim().slice(0, 180) || 'Shadow',
    language: input.language === 'en' ? 'en' : 'zh',
    theme,
    accentColor: String(input.accentColor ?? '').trim().slice(0, 32),
    ...(Object.keys(themeVariables).length > 0 ? { themeVariables } : {}),
    modelConfig: {
      id: modelId,
      provider: String(model.provider ?? '').trim(),
      // The Shadow renderer resolves the opaque model id through Product Host;
      // it never needs a provider secret in its window context.
      apiKey: '',
      ...(typeof model.hasApiKey === 'boolean' ? { hasApiKey: model.hasApiKey } : {}),
      ...(typeof model.apiKeyMasked === 'string' ? { apiKeyMasked: model.apiKeyMasked } : {}),
      modelName: String(model.modelName ?? '').trim(),
      baseUrl: String(model.baseUrl ?? '').trim(),
      ...(optionalPositive(model.maxContextTokens)
        ? { maxContextTokens: optionalPositive(model.maxContextTokens) }
        : {}),
      ...(optionalPositive(model.maxCompletionTokens)
        ? { maxCompletionTokens: optionalPositive(model.maxCompletionTokens) }
        : {}),
    },
    reasoningLevel,
    projectDir: String(input.projectDir ?? '').trim(),
    initialMode: input.initialMode === 'fork' ? 'fork' : 'readonly',
  };
}

function createShadowWindow(value: unknown) {
  const payload = sanitizeShadowWindowPayload(value);
  const key = shadowWindowKey(payload.sessionId, payload.sourceTurnId);
  const existingId = shadowWindowIdsByKey.get(key);
  const existing = existingId == null ? undefined : shadowWindows.get(existingId);
  if (existing && !existing.window.isDestroyed()) {
    if (existing.window.isMinimized()) existing.window.restore();
    existing.window.show();
    existing.window.focus();
    return { windowId: existing.payload.windowId, reused: true };
  }
  if (existingId != null) {
    shadowWindows.delete(existingId);
    shadowWindowIdsByKey.delete(key);
  }

  const windowId = randomUUID();
  const backgroundColor = mainWindowThemeBackgrounds[payload.theme];
  const loadedWindowIcon = loadCardbushIconWithSource(128);
  const shadowWindow = new BrowserWindow({
    width: 640,
    height: 720,
    minWidth: 480,
    minHeight: 520,
    parent: mainWindow ?? undefined,
    modal: false,
    frame: false,
    title: `Shadow · ${payload.title}`,
    icon: loadedWindowIcon.image,
    backgroundColor,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  // webContents is no longer readable after BrowserWindow emits `closed`.
  // Capture the stable numeric identity while both objects are alive.
  const shadowWebContentsId = shadowWindow.webContents.id;
  const state: ShadowWindowState = {
    window: shadowWindow,
    key,
    payload: { ...payload, windowId },
    allowClose: false,
    closeFallbackTimer: null,
  };
  shadowWindows.set(shadowWebContentsId, state);
  shadowWindowIdsByKey.set(key, shadowWebContentsId);
  applyCardbushWindowIcon(shadowWindow, loadedWindowIcon.image, 'shadow-window', loadedWindowIcon.sourcePath);
  installMainWindowNavigationGuard(shadowWindow);
  shadowWindow.once('ready-to-show', () => {
    if (!shadowWindow.isDestroyed()) shadowWindow.show();
  });
  shadowWindow.on('close', (event) => {
    if (isQuitting || state.allowClose || shadowWindow.webContents.isDestroyed()) return;
    event.preventDefault();
    shadowWindow.webContents.send('shadow:close-request');
    if (state.closeFallbackTimer == null) {
      state.closeFallbackTimer = setTimeout(() => {
        state.closeFallbackTimer = null;
        if (shadowWindow.isDestroyed()) return;
        state.allowClose = true;
        shadowWindow.close();
      }, 2_000);
    }
  });
  shadowWindow.on('closed', () => {
    if (state.closeFallbackTimer != null) clearTimeout(state.closeFallbackTimer);
    state.closeFallbackTimer = null;
    shadowWindows.delete(shadowWebContentsId);
    if (shadowWindowIdsByKey.get(key) === shadowWebContentsId) {
      shadowWindowIdsByKey.delete(key);
    }
  });
  loadRenderer(shadowWindow, 'shadow');
  return { windowId, reused: false };
}

function applyMainWindowVisualMaterial(target: BrowserWindow, theme: AppThemeMode) {
  if (target.isDestroyed()) {
    return;
  }
  lastMainWindowTheme = theme;
  const background = backgroundForMainWindowTheme(theme);
  if (process.platform === 'win32') {
    try {
      // Electron resets the native HWND background to white when the material
      // changes. Apply the material first so the themed backing color is the
      // final native-window operation.
      target.setBackgroundMaterial('none');
    } catch {
      // Older Windows builds ignore this; the opaque theme color still applies.
    }
  }
  target.setBackgroundColor(background);
  // BrowserWindow owns a separate native content View whose default backing
  // color is white. During Windows minimize/restore transitions Chromium can
  // briefly expose this View between the HWND and the rendered web page, so it
  // must follow the app theme as well.
  target.contentView.setBackgroundColor(background);
  if (windowCompositionDebugEnabled) {
    const actualBackground = target.getBackgroundColor();
    appendDebugLog('window-composition', {
      stage: 'background-applied',
      theme,
      requestedBackground: background,
      actualBackground,
      matches:
        actualBackground.toLowerCase() === background.toLowerCase(),
    });
  }
}

function backgroundForMainWindowTheme(theme: AppThemeMode) {
  return mainWindowThemeBackgrounds[theme] ?? mainWindowThemeBackgrounds.dark;
}

function installMainWindowNavigationGuard(target: BrowserWindow) {
  target.webContents.setWindowOpenHandler(({ url }) => {
    if (sendUiPreviewToInspector(target, url)) {
      return { action: 'deny' };
    }
    void openUiPreview(url);
    return { action: 'deny' };
  });
  target.webContents.on('will-navigate', (event, targetUrl) => {
    if (isAllowedAppNavigation(targetUrl)) {
      return;
    }
    if (sendUiPreviewToInspector(target, targetUrl)) {
      event.preventDefault();
      return;
    }
    const parsed = safeUrl(targetUrl);
    if (parsed != null && isWebProtocol(parsed)) {
      event.preventDefault();
      void openUiPreview(targetUrl);
      return;
    }
    event.preventDefault();
    void openTargetExternally(targetUrl);
  });
}

function installMainRendererResilience(target: BrowserWindow) {
  let lastRecoveryAt = 0;
  let recoveryAttempts = 0;

  target.webContents.on('before-input-event', (event, input) => {
    const key = input.key.toLowerCase();
    const reloadShortcut = key === 'f5' || ((input.control || input.meta) && key === 'r');
    if (!reloadShortcut) return;
    event.preventDefault();
    appendDebugLog('renderer-lifecycle', {
      stage: 'keyboard-reload-blocked',
      key: input.key,
      control: input.control,
      shift: input.shift,
      meta: input.meta,
    });
  });

  target.webContents.on('render-process-gone', (_event, details) => {
    appendDebugLog('renderer-lifecycle', {
      stage: 'render-process-gone',
      reason: details.reason,
      exitCode: details.exitCode,
    });
    if (isQuitting || target.isDestroyed() || details.reason === 'clean-exit') return;

    const now = Date.now();
    if (now - lastRecoveryAt > 30_000) recoveryAttempts = 0;
    lastRecoveryAt = now;
    recoveryAttempts += 1;
    if (recoveryAttempts > 2) {
      appendDebugLog('renderer-lifecycle', {
        stage: 'automatic-reload-suppressed',
        reason: 'repeated_renderer_failure',
        recoveryAttempts,
      });
      return;
    }

    setTimeout(() => {
      if (isQuitting || target.isDestroyed() || target.webContents.isDestroyed()) return;
      applyMainWindowVisualMaterial(target, lastMainWindowTheme);
      appendDebugLog('renderer-lifecycle', {
        stage: 'automatic-reload',
        recoveryAttempts,
      });
      target.webContents.reload();
    }, 250);
  });

  target.on('unresponsive', () => {
    appendDebugLog('renderer-lifecycle', { stage: 'unresponsive' });
  });
  target.on('responsive', () => {
    appendDebugLog('renderer-lifecycle', { stage: 'responsive' });
  });
  target.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      appendDebugLog('renderer-lifecycle', {
        stage: 'main-frame-load-failed',
        errorCode,
        errorDescription,
        validatedURL,
      });
    },
  );
}

function sendUiPreviewToInspector(target: BrowserWindow, value: string) {
  const previewTarget = resolveUiPreviewTarget(value);
  if (!previewTarget || target.isDestroyed() || target.webContents.isDestroyed()) {
    return false;
  }
  const inspectorTarget = previewTarget.localPath || previewTarget.url;
  const parsed = safeUrl(previewTarget.url);
  target.webContents.send('shell:open-inspector', {
    target: inspectorTarget,
    title: previewTarget.localPath
      ? path.basename(previewTarget.localPath)
      : parsed?.hostname || inspectorTarget,
  });
  return true;
}

async function openUiPreview(targetUrl: string) {
  const previewTarget = resolveUiPreviewTarget(targetUrl);
  if (previewTarget == null) {
    await openTargetExternally(targetUrl);
    return;
  }
  if (mainWindow && sendUiPreviewToInspector(mainWindow, targetUrl)) {
    showMainWindow();
    return;
  }
  await openTargetExternally(previewTarget.externalTarget, previewTarget);
}

function resolveUiPreviewTarget(value: string): UiPreviewTarget | null {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) {
    return null;
  }
  const parsed = safeUrl(trimmed);
  if (
    parsed != null &&
    parsed.protocol === `${localFileProtocol}:` &&
    ['office-preview', 'text-preview'].includes(parsed.hostname.toLowerCase())
  ) {
    const localPath = normalizeShellPath(parsed.searchParams.get('path') ?? '');
    if (localPath && fs.existsSync(localPath) && fs.statSync(localPath).isFile()) {
      return {
        url: parsed.toString(),
        externalTarget: localPath,
        localPath,
      };
    }
    return null;
  }
  if (parsed != null && parsed.protocol === `${localFileProtocol}:`) {
    const localPath = localPathFromProtocolUrl(parsed.toString());
    if (
      localPath &&
      fs.existsSync(localPath) &&
      fs.statSync(localPath).isFile()
    ) {
      return {
        url: isOfficePreviewPath(localPath)
          ? officePreviewProtocolUrl(localPath)
          : pathToFileURL(localPath).toString(),
        externalTarget: localPath,
        localPath,
      };
    }
    return null;
  }
  if (parsed != null && isWebProtocol(parsed)) {
    return {
      url: parsed.toString(),
      externalTarget: parsed.toString(),
    };
  }
  const localhostUrl = localhostPreviewUrl(trimmed);
  if (localhostUrl != null) {
    return {
      url: localhostUrl.toString(),
      externalTarget: localhostUrl.toString(),
    };
  }
  const localPath = previewLocalFilePath(trimmed);
  if (!localPath) {
    return null;
  }
  return {
    url: isOfficePreviewPath(localPath)
      ? officePreviewProtocolUrl(localPath)
      : pathToFileURL(localPath).toString(),
    externalTarget: localPath,
    localPath,
  };
}

function officePreviewProtocolUrl(filePath: string) {
  return `${localFileProtocol}://office-preview/?path=${encodeURIComponent(filePath)}`;
}

function localhostPreviewUrl(value: string) {
  if (!/^(?:localhost|0\.0\.0\.0|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/?#].*)?$/i.test(value)) {
    return null;
  }
  return safeUrl(`http://${value}`);
}

function previewHtmlPath(value: string) {
  const normalized = normalizeShellPath(value);
  const candidates = path.isAbsolute(normalized)
    ? [normalized]
    : [path.resolve(process.cwd(), normalized)];
  for (const candidate of candidates) {
    const resolved = resolvePreviewHtmlPath(candidate);
    if (resolved) {
      return resolved;
    }
  }
  return '';
}

function previewLocalFilePath(value: string) {
  const normalized = normalizeShellPath(value);
  const candidates = path.isAbsolute(normalized)
    ? [normalized]
    : [path.resolve(process.cwd(), normalized)];
  for (const candidate of candidates) {
    try {
      const stats = fs.statSync(candidate);
      if (stats.isDirectory()) {
        const htmlPath = resolvePreviewHtmlPath(candidate);
        if (htmlPath) {
          return htmlPath;
        }
        continue;
      }
      if (
        stats.isFile()
      ) {
        return candidate;
      }
    } catch {
      // Ignore paths that disappeared between rendering and opening.
    }
  }
  return '';
}

function resolvePreviewHtmlPath(candidate: string) {
  try {
    const stats = fs.statSync(candidate);
    if (stats.isDirectory()) {
      for (const indexName of ['index.html', 'index.htm']) {
        const indexPath = path.join(candidate, indexName);
        if (fs.existsSync(indexPath) && fs.statSync(indexPath).isFile()) {
          return indexPath;
        }
      }
      return '';
    }
    return stats.isFile() && isPreviewHtmlFile(candidate) ? candidate : '';
  } catch {
    return '';
  }
}

function isPreviewHtmlFile(value: string) {
  return ['.html', '.htm', '.xhtml'].includes(path.extname(value).toLowerCase());
}

async function openTargetExternally(value: string, previewTarget?: UiPreviewTarget) {
  const localPath = previewTarget?.localPath ?? previewHtmlPath(value);
  if (localPath) {
    const result = await shell.openPath(localPath);
    if (!result) {
      return;
    }
  }
  const parsed = safeUrl(value);
  if (parsed != null && !/^[a-z]:$/i.test(parsed.protocol)) {
    await shell.openExternal(parsed.toString());
    return;
  }
  const normalized = normalizeShellPath(value);
  if (normalized) {
    const result = await shell.openPath(normalized);
    if (!result) {
      return;
    }
  }
  await shell.openExternal(value);
}

function openFileWithChooser(targetPath: string) {
  if (process.platform !== 'win32') {
    void shell.openPath(targetPath);
    return;
  }
  const child = spawn(
    'rundll32.exe',
    ['shell32.dll,OpenAs_RunDLL', targetPath],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  child.unref();
}

function createCardlingWindow() {
  if (cardlingWindow != null && !cardlingWindow.isDestroyed()) {
    return cardlingWindow;
  }
  const bounds = cardlingBoundsForSize(cardlingExpandedSize);
  cardlingWindow = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    show: false,
    title: 'Kabu',
    icon: loadCardbushIcon(64),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  cardlingWindow.setAlwaysOnTop(true, 'screen-saver');
  cardlingWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  applyCardlingShape();
  cardlingWindow.on('moved', () => {
    if (!cardlingApplyingBounds) {
      saveCardlingAnchor();
    }
  });
  cardlingWindow.on('blur', () => {
    if (!cardlingExpanded || cardlingWindow == null || cardlingWindow.isDestroyed()) {
      return;
    }
    cardlingWindow.webContents.send('cardling:collapse');
  });
  cardlingWindow.on('closed', () => {
    stopCardlingDrag(false);
    if (cardlingApplyingBoundsTimer != null) {
      clearTimeout(cardlingApplyingBoundsTimer);
      cardlingApplyingBoundsTimer = null;
    }
    cardlingApplyingBounds = false;
    cardlingWindow = null;
  });
  cardlingWindow.webContents.on('did-finish-load', () => {
    sendCardlingState();
  });
  loadRenderer(cardlingWindow, 'cardling');
  return cardlingWindow;
}

function loadRenderer(target: BrowserWindow, mode: 'main' | 'cardling' | 'shadow') {
  if (devServerUrl) {
    const url = new URL(devServerUrl);
    if (mode !== 'main') {
      url.searchParams.set('window', mode);
    }
    target.loadURL(url.toString());
    return;
  }
  const indexPath = path.join(__dirname, '../dist/index.html');
  if (mode !== 'main') {
    target.loadFile(indexPath, { query: { window: mode } });
    return;
  }
  target.loadFile(indexPath);
}

function sendCardlingState() {
  if (
    cardlingWindow == null ||
    cardlingWindow.isDestroyed() ||
    cardlingWindow.webContents.isDestroyed() ||
    lastCardlingState == null
  ) {
    return;
  }
  cardlingWindow.webContents.send('cardling:state', lastCardlingState);
}

function sanitizeCardlingState(payload: CardlingDesktopState): CardlingDesktopState {
  return {
    enabled: payload.enabled !== false,
    language: payload.language === 'en' ? 'en' : 'zh',
    theme:
      payload.theme === 'bright' ||
      payload.theme === 'parchment' ||
      payload.theme === 'dark' ||
      payload.theme === 'cyberpunk'
        ? payload.theme
        : 'dark',
    settings: {
      size:
        payload.settings?.size === 'compact' || payload.settings?.size === 'large'
          ? payload.settings.size
          : 'normal',
      opacity: clampNumber(payload.settings?.opacity, 0.55, 1, 0.95),
      motion:
        payload.settings?.motion === 'reduced' || payload.settings?.motion === 'off'
          ? payload.settings.motion
          : 'full',
    },
    status: normalizeCardlingStatus(payload.status),
    sending: Boolean(payload.sending),
    queuedMessageCount: Math.max(0, Math.round(Number(payload.queuedMessageCount) || 0)),
    pendingInteraction: Boolean(payload.pendingInteraction),
    activeChangeCount: Math.max(0, Math.round(Number(payload.activeChangeCount) || 0)),
    activeChangeFileCount: Math.max(0, Math.round(Number(payload.activeChangeFileCount) || 0)),
    error: typeof payload.error === 'string' && payload.error.trim() ? payload.error : null,
    miniChat: {
      title: clippedCardlingText(payload.miniChat?.title, 80),
      lastUser: clippedCardlingText(payload.miniChat?.lastUser, 160),
      lastAssistant: clippedCardlingText(payload.miniChat?.lastAssistant, 360),
    },
  };
}

function clippedCardlingText(value: unknown, maxLength: number) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function normalizeCardlingStatus(value: string): CardlingDesktopState['status'] {
  const allowed = new Set<CardlingDesktopState['status']>([
    'idle',
    'thinking',
    'tool',
    'waiting',
    'queued',
    'complete',
    'error',
  ]);
  return allowed.has(value as CardlingDesktopState['status'])
    ? (value as CardlingDesktopState['status'])
    : 'idle';
}

function clampNumber(value: number, min: number, max: number, fallback: number) {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

function setCardlingWindowBounds(bounds: Electron.Rectangle, persistAnchor = false) {
  if (cardlingWindow == null || cardlingWindow.isDestroyed()) {
    return;
  }
  const next = safeCardlingBounds(bounds);
  if (next == null) {
    return;
  }
  if (cardlingApplyingBoundsTimer != null) {
    clearTimeout(cardlingApplyingBoundsTimer);
    cardlingApplyingBoundsTimer = null;
  }
  cardlingApplyingBounds = true;
  cardlingWindow.setBounds(next, false);
  applyCardlingShape();
  if (persistAnchor) {
    saveCardlingAnchor(next);
  }
  cardlingApplyingBoundsTimer = setTimeout(() => {
    cardlingApplyingBounds = false;
    cardlingApplyingBoundsTimer = null;
  }, 120);
}

function resizeCardlingWindow(expanded: boolean) {
  if (cardlingWindow == null || cardlingWindow.isDestroyed()) {
    return;
  }
  const current = cardlingWindow.getBounds();
  if (current.width !== cardlingExpandedSize.width || current.height !== cardlingExpandedSize.height) {
    const next = ensureBoundsInDisplay({
      width: cardlingExpandedSize.width,
      height: cardlingExpandedSize.height,
      x: current.x + current.width - cardlingExpandedSize.width,
      y: current.y + current.height - cardlingExpandedSize.height,
    });
    setCardlingWindowBounds(next);
  }
  applyCardlingShape(expanded);
}

function applyCardlingShape(expanded = cardlingExpanded) {
  if (cardlingWindow == null || cardlingWindow.isDestroyed()) {
    return;
  }
  const bounds = cardlingWindow.getBounds();
  try {
    if (expanded) {
      cardlingWindow.setShape([{ x: 0, y: 0, width: bounds.width, height: bounds.height }]);
      return;
    }
    cardlingWindow.setShape([
      {
        x: Math.max(0, bounds.width - cardlingCollapsedHitSize.width),
        y: Math.max(0, bounds.height - cardlingCollapsedHitSize.height),
        width: Math.min(cardlingCollapsedHitSize.width, bounds.width),
        height: Math.min(cardlingCollapsedHitSize.height, bounds.height),
      },
    ]);
  } catch {
    // setShape is best-effort; if unavailable the transparent window still works.
  }
}

function startCardlingDrag(cursorX?: number, cursorY?: number) {
  if (cardlingWindow == null || cardlingWindow.isDestroyed()) {
    return;
  }
  stopCardlingDrag(false);
  const bounds = cardlingWindow.getBounds();
  const cursor =
    Number.isFinite(cursorX) && Number.isFinite(cursorY)
      ? { x: Math.round(Number(cursorX)), y: Math.round(Number(cursorY)) }
      : screen.getCursorScreenPoint();
  if (cardlingApplyingBoundsTimer != null) {
    clearTimeout(cardlingApplyingBoundsTimer);
    cardlingApplyingBoundsTimer = null;
  }
  cardlingApplyingBounds = true;
  cardlingDragState = {
    offsetX: cursor.x - bounds.x,
    offsetY: cursor.y - bounds.y,
    width: bounds.width,
    height: bounds.height,
    interval: setInterval(updateCardlingDragPosition, 16),
    timeout: setTimeout(() => stopCardlingDrag(true), 30000),
  };
  updateCardlingDragPosition();
}

function updateCardlingDragPosition() {
  if (
    cardlingDragState == null ||
    cardlingWindow == null ||
    cardlingWindow.isDestroyed()
  ) {
    stopCardlingDrag(false);
    return;
  }
  const cursor = screen.getCursorScreenPoint();
  const next = ensureBoundsInDisplay({
    width: cardlingDragState.width,
    height: cardlingDragState.height,
    x: cursor.x - cardlingDragState.offsetX,
    y: cursor.y - cardlingDragState.offsetY,
  });
  const current = cardlingWindow.getBounds();
  if (current.x === next.x && current.y === next.y) {
    return;
  }
  cardlingWindow.setBounds(next, false);
}

function stopCardlingDrag(persistAnchor = true) {
  if (cardlingDragState != null) {
    clearInterval(cardlingDragState.interval);
    clearTimeout(cardlingDragState.timeout);
    cardlingDragState = null;
  }
  cardlingApplyingBounds = false;
  if (persistAnchor) {
    saveCardlingAnchor();
  }
}

function cardlingBoundsForSize(size: { width: number; height: number }) {
  const anchor = readCardlingAnchor();
  if (anchor) {
    return ensureBoundsInDisplay({
      width: size.width,
      height: size.height,
      x: anchor.right - size.width,
      y: anchor.bottom - size.height,
    });
  }
  const workArea = screen.getPrimaryDisplay().workArea;
  return ensureBoundsInDisplay({
    width: size.width,
    height: size.height,
    x: workArea.x + workArea.width - size.width - 24,
    y: workArea.y + workArea.height - size.height - 64,
  });
}

function ensureBoundsInDisplay(bounds: Electron.Rectangle) {
  const width = Math.max(1, Math.round(Number(bounds.width) || 1));
  const height = Math.max(1, Math.round(Number(bounds.height) || 1));
  const fallbackPoint = screen.getCursorScreenPoint();
  const x = Number.isFinite(bounds.x) ? Math.round(bounds.x) : fallbackPoint.x;
  const y = Number.isFinite(bounds.y) ? Math.round(bounds.y) : fallbackPoint.y;
  const normalized = { width, height, x, y };
  const display =
    screen.getDisplayMatching(normalized) ||
    screen.getDisplayNearestPoint({ x, y }) ||
    screen.getPrimaryDisplay();
  const area = display.workArea;
  return {
    width,
    height,
    x: Math.max(area.x, Math.min(area.x + area.width - width, x)),
    y: Math.max(area.y, Math.min(area.y + area.height - height, y)),
  };
}

function safeCardlingBounds(bounds: Electron.Rectangle) {
  const next = ensureBoundsInDisplay(bounds);
  if (
    !Number.isFinite(next.x) ||
    !Number.isFinite(next.y) ||
    !Number.isFinite(next.width) ||
    !Number.isFinite(next.height)
  ) {
    return null;
  }
  return next;
}

function cardlingStatePath() {
  return path.join(app.getPath('userData'), 'cardling-window.json');
}

function readCardlingAnchor() {
  try {
    const raw = fs.readFileSync(cardlingStatePath(), 'utf8');
    const decoded = JSON.parse(raw) as { right?: unknown; bottom?: unknown };
    const right = Number(decoded.right);
    const bottom = Number(decoded.bottom);
    if (Number.isFinite(right) && Number.isFinite(bottom)) {
      return { right, bottom };
    }
  } catch {
    return null;
  }
  return null;
}

function saveCardlingAnchor(bounds = cardlingWindow?.getBounds()) {
  if (!bounds) {
    return;
  }
  try {
    fs.mkdirSync(path.dirname(cardlingStatePath()), { recursive: true });
    fs.writeFileSync(
      cardlingStatePath(),
      JSON.stringify({
        right: bounds.x + bounds.width,
        bottom: bounds.y + bounds.height,
      }),
    );
  } catch {
    // Position persistence is best-effort; failure should not affect the app.
  }
}

function createTray() {
  const icon = loadCardbushTrayIcon(32);
  tray = new Tray(icon);
  tray.setToolTip('cardbush');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '打开 cardbush',
        click: () => showMainWindow(),
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => requestAppQuit(),
      },
    ]),
  );
  tray.on('double-click', () => showMainWindow());
}

function requestAppQuit() {
  if (isQuitting && quitFallbackTimer != null) {
    return;
  }
  isQuitting = true;
  if (startupRevealFallback != null) {
    clearTimeout(startupRevealFallback);
    startupRevealFallback = null;
  }
  if (tray != null) {
    tray.destroy();
    tray = null;
  }
  stopCardlingDrag(false);
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.close();
    }
  }
  quitFallbackTimer = setTimeout(() => {
    app.exit(0);
  }, 1200);
  app.quit();
}

function loadCardbushIconWithSource(size: number) {
  const candidates: string[] = [];
  for (const fileName of logoAssetNames) {
    for (const filePath of cardbushIconAssetPaths(fileName)) {
      candidates.push(filePath);
      const image = nativeImage.createFromPath(filePath);
      if (!image.isEmpty()) {
        const cropped = cropTransparentIconPadding(image);
        return {
          image: cropped.resize({ width: size, height: size, quality: 'best' }),
          sourcePath: filePath,
          candidates,
        };
      }
    }
  }
  return {
    image: nativeImage.createFromDataURL(
      'data:image/svg+xml;utf8,' +
        encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="8" fill="#637B61"/><path d="M10 21c6 0 10-4 12-11-7 2-11 6-12 11Z" fill="#F1E6CF"/></svg>',
        ),
    ),
    sourcePath: 'generated-fallback',
    candidates,
  };
}

function loadCardbushIcon(size: number) {
  return loadCardbushIconWithSource(size).image;
}

function loadCardbushTrayIcon(size: number) {
  return loadCardbushIconWithSource(size).image;
}

function cropTransparentIconPadding(image: NativeImage) {
  const { width, height } = image.getSize();
  if (width <= 0 || height <= 0) {
    return image;
  }
  const bitmap = image.toBitmap({ scaleFactor: 1 });
  if (bitmap.length < width * height * 4) {
    return image;
  }

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = bitmap[(y * width + x) * 4 + 3] ?? 0;
      if (alpha <= 8) {
        continue;
      }
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < minX || maxY < minY) {
    return image;
  }

  const contentWidth = maxX - minX + 1;
  const contentHeight = maxY - minY + 1;
  const safePadding = Math.ceil(Math.max(contentWidth, contentHeight) * 0.06);
  const side = Math.min(
    width,
    height,
    Math.max(contentWidth, contentHeight) + safePadding * 2,
  );
  const centerX = (minX + maxX + 1) / 2;
  const centerY = (minY + maxY + 1) / 2;
  const x = Math.max(0, Math.min(width - side, Math.round(centerX - side / 2)));
  const y = Math.max(0, Math.min(height - side, Math.round(centerY - side / 2)));
  if (x === 0 && y === 0 && side === width && side === height) {
    return image;
  }
  return image.crop({ x, y, width: side, height: side });
}

function cardbushIconAssetPaths(fileName: string) {
  return Array.from(new Set([
    path.join(__dirname, '../assets', fileName),
    path.join(app.getAppPath(), 'assets', fileName),
    path.join(process.resourcesPath, 'assets', fileName),
    path.join(app.getAppPath(), 'public', fileName),
  ]));
}

function applyCardbushWindowIcon(
  window: BrowserWindow,
  icon = loadCardbushIcon(256),
  debugStage = '',
  sourcePath = '',
) {
  if (process.platform !== 'win32') {
    return;
  }
  const iconPath = cardbushIconAssetPaths('cardbush.ico').find((candidate) =>
    fs.existsSync(candidate),
  );
  try {
    window.setIcon(icon);
    window.setAppDetails({
      appId: cardbushAppUserModelId,
      ...(iconPath ? { appIconPath: iconPath, appIconIndex: 0 } : {}),
      relaunchCommand: windowsRelaunchCommand(),
      relaunchDisplayName: cardbushDisplayName,
    });
    if (debugStage) {
      appendDebugLog('taskbar', {
        stage: debugStage,
        success: true,
        appId: cardbushAppUserModelId,
        appName: app.getName(),
        packaged: cardbushRuntimeIsPackaged,
        electronPackagedDetection: app.isPackaged,
        developmentRuntime: cardbushDevelopmentRuntime,
        execPath: process.execPath,
        appPath: app.getAppPath(),
        sourcePath,
        sourceExists: sourcePath !== 'generated-fallback' && fs.existsSync(sourcePath),
        iconPath: iconPath ?? '',
        iconPathExists: Boolean(iconPath),
        iconSize: icon.getSize(),
        relaunchCommand: windowsRelaunchCommand(),
      });
    }
  } catch (error) {
    if (debugStage) {
      appendDebugLog('taskbar', {
        stage: debugStage,
        success: false,
        sourcePath,
        iconPath: iconPath ?? '',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function ensureWindowsTaskbarShortcut() {
  if (process.platform !== 'win32') {
    return false;
  }
  const iconPath = cardbushIconAssetPaths('cardbush.ico').find((candidate) =>
    fs.existsSync(candidate),
  );
  if (!iconPath) {
    appendDebugLog('taskbar', {
      stage: 'shortcut',
      success: false,
      reason: 'icon-not-found',
      candidates: cardbushIconAssetPaths('cardbush.ico'),
    });
    return false;
  }
  try {
    const programsDir = path.join(
      app.getPath('appData'),
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
    );
    fs.mkdirSync(programsDir, { recursive: true });
    const shortcutPath = path.join(
      programsDir,
      cardbushRuntimeIsPackaged ? 'CardBush.lnk' : 'CardBush Development.lnk',
    );
    const operation = fs.existsSync(shortcutPath) ? 'replace' : 'create';
    const success = shell.writeShortcutLink(shortcutPath, operation, {
      target: process.execPath,
      ...(cardbushRuntimeIsPackaged
        ? {}
        : { args: quoteWindowsCommandArgument(app.getAppPath()) }),
      cwd: app.getAppPath(),
      description: 'CardBush desktop',
      icon: iconPath,
      iconIndex: 0,
      appUserModelId: cardbushAppUserModelId,
    });
    let details: Electron.ShortcutDetails | null = null;
    if (success) {
      try {
        details = shell.readShortcutLink(shortcutPath);
      } catch {
        details = null;
      }
    }
    appendDebugLog('taskbar', {
      stage: 'shortcut',
      success,
      operation,
      shortcutPath,
      shortcutExists: fs.existsSync(shortcutPath),
      expectedTarget: process.execPath,
      expectedIcon: iconPath,
      actualTarget: details?.target ?? '',
      actualIcon: details?.icon ?? '',
      actualAppUserModelId: details?.appUserModelId ?? '',
    });
    return success;
  } catch (error) {
    appendDebugLog('taskbar', {
      stage: 'shortcut',
      success: false,
      reason: 'exception',
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

function windowsRelaunchCommand() {
  const executable = quoteWindowsCommandArgument(process.execPath);
  return cardbushRuntimeIsPackaged
    ? executable
    : `${executable} ${quoteWindowsCommandArgument(app.getAppPath())}`;
}

function quoteWindowsCommandArgument(value: string) {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function loadSessionAttentionOverlayIcon() {
  return nativeImage.createFromDataURL(
    'data:image/svg+xml;utf8,' +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="#d88933" stroke="#fff" stroke-width="3"/><path d="M9.5 16.5 14 21l8.5-10" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      ),
  );
}

function applySessionAttentionBadge() {
  const count = Math.max(0, Math.round(sessionAttentionCount));
  if (process.platform === 'win32' && mainWindow != null && !mainWindow.isDestroyed()) {
    mainWindow.setOverlayIcon(
      count > 0 ? loadSessionAttentionOverlayIcon() : null,
      count > 0 ? `${count} 个会话待处理` : '',
    );
  }
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setBadge(count > 0 ? String(count) : '');
  } else if (process.platform !== 'win32') {
    app.setBadgeCount(count);
  }
  if (tray != null && !tray.isDestroyed()) {
    tray.setToolTip(count > 0 ? `cardbush · ${count} 个会话待处理` : 'cardbush');
  }
}

function sanitizeSessionAttentionPayload(value: unknown) {
  const payload = value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
  const kind = String(payload.kind ?? '').trim().toLowerCase();
  return {
    sessionId: String(payload.sessionId ?? '').trim(),
    title: String(payload.title ?? '').trim().slice(0, 120) || 'CardBush',
    body: String(payload.body ?? '').trim().slice(0, 500) || '任务已完成，点击查看结果。',
    kind: kind === 'waiting' || kind === 'error' ? kind : 'completed',
  } as const;
}

function showSessionAttentionNotification(value: unknown) {
  const payload = sanitizeSessionAttentionPayload(value);
  if (!payload.sessionId) {
    return { shown: false };
  }
  const shouldShow = mainWindow == null || mainWindow.isDestroyed() ||
    !mainWindow.isVisible() || !mainWindow.isFocused();
  if (!shouldShow || !Notification.isSupported()) {
    return { shown: false };
  }
  const activationArguments = encodeSessionAttentionActivation(payload.sessionId);
  const notification = new Notification({
    id: `cardbush-attention-${randomUUID()}`,
    title: payload.title,
    body: payload.body,
    icon: loadCardbushIcon(64),
    silent: false,
    ...(process.platform === 'win32'
      ? { toastXml: sessionAttentionToastXml(payload.title, payload.body, activationArguments) }
      : {}),
  });
  const release = () => activeSessionAttentionNotifications.delete(notification);
  notification.on('click', () => activateSessionAttention(payload.sessionId));
  notification.on('close', release);
  notification.on('failed', release);
  activeSessionAttentionNotifications.add(notification);
  notification.show();
  mainWindow?.flashFrame(true);
  return { shown: true };
}

function sessionAttentionToastXml(title: string, body: string, launch: string) {
  return `<toast activationType="foreground" launch="${escapeXmlAttribute(launch)}"><visual><binding template="ToastGeneric"><text>${escapeXmlText(title)}</text><text>${escapeXmlText(body)}</text></binding></visual></toast>`;
}

function escapeXmlAttribute(value: string) {
  return escapeXmlText(value).replace(/'/g, '&apos;').replace(/"/g, '&quot;');
}

function escapeXmlText(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function activateSessionAttention(sessionId: string) {
  if (sessionAttentionOpenQueue.enqueue(sessionId)) {
    publishSessionAttentionOpenAvailable();
  }
  showMainWindow();
  publishSessionAttentionOpenAvailable();
}

function publishSessionAttentionOpenAvailable() {
  if (
    sessionAttentionOpenQueue.size === 0 ||
    mainWindow == null ||
    mainWindow.isDestroyed() ||
    mainWindow.webContents.isLoadingMainFrame()
  ) return;
  mainWindow.webContents.send('attention:open-session');
}

function showMainWindow() {
  if (mainWindow == null || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  applyMainWindowVisualMaterial(mainWindow, lastMainWindowTheme);
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
  mainWindow.moveTop();
}

ipcMain.handle('window:minimize', () => {
  mainWindow?.minimize();
});

ipcMain.handle('window:toggle-maximize', () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow?.maximize();
  }
});

ipcMain.handle('window:close-to-tray', () => {
  mainWindow?.hide();
});

ipcMain.handle('window:is-maximized', () => mainWindow?.isMaximized() ?? false);

ipcMain.handle('shadow:open-window', (event, payload: unknown) => {
  if (mainWindow == null || event.sender.id !== mainWindow.webContents.id) {
    throw new Error('Only the main CardBush window can open Shadow.');
  }
  return createShadowWindow(payload);
});

ipcMain.handle('shadow:window-context', (event) => {
  const state = shadowWindows.get(event.sender.id);
  if (!state) throw new Error('Shadow window context is unavailable.');
  return structuredClone(state.payload);
});

ipcMain.handle('shadow:window-minimize', (event) => {
  shadowWindows.get(event.sender.id)?.window.minimize();
});

ipcMain.handle('shadow:window-toggle-maximize', (event) => {
  const target = shadowWindows.get(event.sender.id)?.window;
  if (!target || target.isDestroyed()) return;
  if (target.isMaximized()) target.unmaximize();
  else target.maximize();
});

ipcMain.handle('shadow:window-is-maximized', (event) =>
  shadowWindows.get(event.sender.id)?.window.isMaximized() ?? false,
);

ipcMain.handle('shadow:window-close', (event) => {
  const state = shadowWindows.get(event.sender.id);
  if (!state || state.window.isDestroyed()) return;
  if (state.closeFallbackTimer != null) clearTimeout(state.closeFallbackTimer);
  state.closeFallbackTimer = null;
  state.allowClose = true;
  state.window.close();
});

ipcMain.handle('attention:notify-session', (event, payload: unknown) => {
  if (mainWindow == null || event.sender.id !== mainWindow.webContents.id) {
    return { shown: false };
  }
  return showSessionAttentionNotification(payload);
});

ipcMain.handle('attention:set-count', (event, count: number) => {
  if (mainWindow == null || event.sender.id !== mainWindow.webContents.id) {
    return;
  }
  sessionAttentionCount = Math.max(0, Math.round(Number(count) || 0));
  applySessionAttentionBadge();
});

ipcMain.handle('attention:consume-open-session', (event) => {
  if (mainWindow == null || event.sender.id !== mainWindow.webContents.id) {
    return null;
  }
  return sessionAttentionOpenQueue.consume();
});

ipcMain.handle('debug:append-log', (event, scope: string, payload: unknown) => {
  if (mainWindow == null || event.sender.id !== mainWindow.webContents.id) {
    throw new Error('debug log is only available to the main window');
  }
  return appendDebugLog(scope, payload);
});

ipcMain.handle('app:runtime-startup-status', (event) => {
  assertMainWindowSender(event.sender.id);
  return { ...runtimeStartupStatus };
});

ipcMain.handle('app:retry-runtime', async (event) => {
  assertMainWindowSender(event.sender.id);
  if (runtimeStartupStatus.phase !== 'initializing') {
    await startRuntimeServices(true);
  }
  return { ...runtimeStartupStatus };
});

ipcMain.handle('app:renderer-ready', (event) => {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender);
  if (sourceWindow !== mainWindow || sourceWindow == null || sourceWindow.isDestroyed()) {
    return;
  }
  if (startupRevealFallback != null) {
    clearTimeout(startupRevealFallback);
    startupRevealFallback = null;
  }
  packagedSmokeRendererReadyResolve?.();
  packagedSmokeRendererReadyResolve = null;
  applyMainWindowVisualMaterial(sourceWindow, lastMainWindowTheme);
  const loadedIcon = loadCardbushIconWithSource(256);
  applyCardbushWindowIcon(
    sourceWindow,
    loadedIcon.image,
    'renderer-ready-before-show',
    loadedIcon.sourcePath,
  );
  appendDebugLog('startup', {
    stage: 'renderer-ready',
    elapsedMs: Date.now() - desktopStartupStartedAt,
    runtimePhase: runtimeStartupStatus.phase,
    packaged: cardbushRuntimeIsPackaged,
  });
  if (packagedSmokeMode) return;
  sourceWindow.show();
  publishSessionAttentionOpenAvailable();
  // Windows can briefly restore the executable icon while creating the
  // taskbar button. Reapply once after the HWND has become visible.
  setTimeout(() => {
    if (!sourceWindow.isDestroyed()) {
      applyCardbushWindowIcon(
        sourceWindow,
        loadedIcon.image,
        'renderer-ready-after-show',
        loadedIcon.sourcePath,
      );
    }
  }, 250);
});

ipcMain.handle('appearance:wallpaper-accent', () => {
  return readWallpaperAccent();
});

ipcMain.handle('appearance:set-window-theme', (event, theme: AppThemeMode) => {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender);
  if (sourceWindow !== mainWindow || sourceWindow == null || sourceWindow.isDestroyed()) {
    return;
  }
  const normalizedTheme: AppThemeMode =
    theme === 'bright' || theme === 'parchment' || theme === 'dark' ||
      theme === 'cyberpunk'
      ? theme
      : 'dark';
  applyMainWindowVisualMaterial(sourceWindow, normalizedTheme);
  traceMainWindowComposition(sourceWindow, 'theme-change', [0, 80]);
});

ipcMain.handle('filesystem:locations', (event) => {
  assertMainWindowSender(event.sender.id);
  return filesystemLocations();
});

ipcMain.handle('chrome-connector:status', (event) => {
  assertMainWindowSender(event.sender.id);
  return currentChromeConnectorStatus();
});

ipcMain.handle('chrome-connector:setup', (event) => {
  assertMainWindowSender(event.sender.id);
  registerChromeConnectorNativeHost({
    userDataPath: app.getPath('userData'),
    nativeHostPath: chromeConnectorNativeHostPath(),
  });
  cachedChromeConnectorRegistrationStatus = null;
  return currentChromeConnectorStatus();
});

ipcMain.handle('chrome-connector:open-installer', async (event) => {
  assertMainWindowSender(event.sender.id);
  const status = currentChromeConnectorStatus();
  if (status.storeUrl) {
    await shell.openExternal(status.storeUrl);
    return { opened: true, method: 'store', target: status.storeUrl };
  }
  const manifestPath = path.join(status.extensionDirectory, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error('The bundled CardBush Browser Connector extension is missing.');
  }
  clipboard.writeText(status.extensionDirectory);
  shell.showItemInFolder(manifestPath);
  return { opened: true, method: 'unpacked', target: status.extensionDirectory };
});

ipcMain.handle('chrome-connector:reveal-extension', (event) => {
  assertMainWindowSender(event.sender.id);
  const status = currentChromeConnectorStatus();
  const manifestPath = path.join(status.extensionDirectory, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error('The bundled CardBush Browser Connector extension is missing.');
  }
  clipboard.writeText(status.extensionDirectory);
  shell.showItemInFolder(manifestPath);
  return status.extensionDirectory;
});

ipcMain.handle('cardbush-product-host:command', async (event, command: unknown) => {
  assertRuntimeRendererSender(event.sender.id);
  if (shadowWindows.has(event.sender.id)) {
    const kind = command && typeof command === 'object'
      ? String((command as Record<string, unknown>).kind ?? '')
      : '';
    if (kind !== 'model.resolve') {
      throw new Error('Shadow can only resolve its preselected model binding.');
    }
  }
  const controller = await ensureRuntimeServicesReady();
  return controller.execute(command);
});

async function ensureRuntimeServicesReady(): Promise<NonNullable<typeof productHostController>> {
  if (runtimeStartupStatus.phase !== 'ready' || !productHostController) {
    await (runtimeServicesInitialization ?? startRuntimeServices());
  }
  if (runtimeStartupStatus.phase !== 'ready' || !productHostController) {
    const error = new Error(
      runtimeStartupStatus.error || 'CardBush Runtime failed to initialize.',
    ) as Error & { code?: string };
    error.code = runtimeStartupStatus.phase === 'error'
      ? 'runtime_initialization_failed'
      : 'product_host_unavailable';
    throw error;
  }
  return productHostController;
}

ipcMain.handle(
  'network:set-proxy',
  async (
    _,
    proxy: {
      mode: 'none' | 'system' | 'manual';
      httpProxy: string;
      httpsProxy: string;
      noProxy: string;
    },
  ) => {
    await applyProxySettings(proxy);
  },
);

ipcMain.handle('models:list', async (_, baseUrl: string, apiKey: string) => {
  const endpoint = modelListEndpoint(baseUrl);
  const token = String(apiKey ?? '').trim();
  if (!token) {
    throw new Error('Missing API key');
  }
  const response = await net.fetch(endpoint, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `GET /models failed (${response.status} ${response.statusText || 'HTTP error'}): ${text.slice(0, 240)}`,
    );
  }
  const payload = parseJsonRecord(text);
  const models = modelIdsFromPayload(payload);
  return {
    endpoint,
    models,
    rawCount: Array.isArray(payload.data) ? payload.data.length : models.length,
  };
});

ipcMain.handle('dialog:pick-attachments', async () => {
  const options: OpenDialogOptions = {
    title: 'Select attachments',
    properties: ['openFile', 'multiSelections'],
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle('files:inspect-attachments', async (_, targetPaths: string[]) => {
  const uniquePaths = [...new Set(
    (Array.isArray(targetPaths) ? targetPaths : [])
      .map((targetPath) => normalizeShellPath(String(targetPath ?? '')))
      .filter(Boolean),
  )].slice(0, 32);
  const inspected = await Promise.all(uniquePaths.map(async (targetPath) => {
    const stats = await fs.promises.stat(targetPath).catch(() => null);
    if (!stats || (!stats.isFile() && !stats.isDirectory())) {
      return null;
    }
    return {
      path: targetPath,
      name: path.basename(targetPath),
      kind: stats.isDirectory() ? 'folder' as const : 'file' as const,
      ...(stats.isFile() ? { size: stats.size } : {}),
    };
  }));
  return inspected.filter((item) => item != null);
});

ipcMain.handle('workspace:ensure-task-directory', async (event, sessionId: string) => {
  assertMainWindowSender(event.sender.id);
  const normalizedSessionId = String(sessionId ?? '').trim();
  if (!normalizedSessionId) {
    throw new Error('Session ID is required for a task workspace.');
  }
  const stableId = createHash('sha256').update(normalizedSessionId).digest('hex').slice(0, 24);
  const workspace = path.join(app.getPath('userData'), 'task-workspaces', stableId);
  await fs.promises.mkdir(workspace, { recursive: true });
  return workspace;
});

ipcMain.handle('files:inspect-local-reference', async (event, targetPath: string) => {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender);
  if (sourceWindow !== mainWindow && !shadowWindows.has(event.sender.id)) {
    return null;
  }
  const normalizedPath = normalizeShellPath(targetPath);
  if (!normalizedPath) {
    return null;
  }
  const stats = await fs.promises.stat(normalizedPath).catch(() => null);
  if (!stats || (!stats.isFile() && !stats.isDirectory())) {
    return null;
  }
  const name = path.basename(normalizedPath);
  if (stats.isDirectory()) {
    return { path: normalizedPath, name, kind: 'folder' as const };
  }
  if (process.platform !== 'win32' || path.extname(normalizedPath).toLowerCase() !== '.lnk') {
    return { path: normalizedPath, name, kind: 'file' as const };
  }

  let kind: 'folder' | 'application' = 'application';
  try {
    const shortcut = shell.readShortcutLink(normalizedPath);
    const shortcutTarget = expandWindowsEnv(shortcut.target?.trim() ?? '');
    if (shortcutTarget) {
      const targetStats = await fs.promises.stat(shortcutTarget).catch(() => null);
      if (targetStats?.isDirectory()) {
        kind = 'folder';
      }
    }
  } catch {
    // Windows can still resolve and launch some Shell-managed shortcuts even
    // when their target metadata is unavailable. Keep them launchable.
  }
  if (kind === 'folder') {
    return { path: normalizedPath, name, kind };
  }
  const iconImage = await app
    .getFileIcon(normalizedPath, { size: 'large' })
    .catch(() => nativeImage.createEmpty());
  return {
    path: normalizedPath,
    name: path.basename(normalizedPath, path.extname(normalizedPath)),
    kind,
    ...(iconImage.isEmpty() ? {} : { icon: iconImage.toDataURL() }),
  };
});

ipcMain.handle('skills:list', async () => {
  await ensureLegacyProductSkillsMigrated();
  return listProductSkills(await activeProductSkillRoots());
});

ipcMain.handle('skills:read', async (_, skillName: string) => {
  await ensureLegacyProductSkillsMigrated();
  return readProductSkill(await activeProductSkillRoots(), String(skillName ?? ''));
});

ipcMain.handle('plugins:install-local', async () => {
  const options: OpenDialogOptions = {
    title: 'Install CardBush plugin',
    properties: ['openDirectory'],
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  const sourcePath = result.canceled ? '' : result.filePaths[0] ?? '';
  if (!sourcePath) return null;
  return installProductPlugin(sourcePath, path.join(app.getPath('userData'), 'plugins'));
});

ipcMain.handle('dialog:pick-project-directory', async () => {
  const options: OpenDialogOptions = {
    title: 'Open project',
    properties: ['openDirectory'],
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? null : result.filePaths[0] ?? null;
});

ipcMain.handle('dialog:pick-font', async () => {
  const options: OpenDialogOptions = {
    title: 'Import font',
    properties: ['openFile'],
    filters: [
      { name: 'Fonts', extensions: ['ttf', 'otf', 'woff', 'woff2'] },
      { name: 'All files', extensions: ['*'] },
    ],
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? null : result.filePaths[0] ?? null;
});

ipcMain.handle('dialog:pick-appearance-style', async () => {
  const options: OpenDialogOptions = {
    title: 'Import CardBush theme configuration',
    properties: ['openFile'],
    filters: [
      { name: 'CardBush theme configuration', extensions: ['json'] },
      { name: 'All files', extensions: ['*'] },
    ],
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? null : result.filePaths[0] ?? null;
});

ipcMain.handle('project:list-root', (_, rootPath: string) => {
  return listProjectRoot(rootPath);
});

ipcMain.handle('project:validate-roots', (_, rootPaths: string[]) => {
  return inspectProjectRoots(Array.isArray(rootPaths) ? rootPaths : []);
});

ipcMain.handle(
  'project:rename-directory',
  (event, input: { rootPath?: string; name?: string }) => {
    assertMainWindowSender(event.sender.id);
    return renameProjectDirectory(
      String(input?.rootPath ?? ''),
      String(input?.name ?? ''),
    );
  },
);

ipcMain.handle('project:search-files', (_, rootPath: string, query: string) => {
  return searchProjectFiles(rootPath, query);
});

ipcMain.handle(
  'team-workflow:save',
  (_, input: { projectDir?: string; workflowId?: string; yaml?: string }) => {
    const workflowId = String(input?.workflowId ?? '').trim().toLowerCase();
    const yaml = String(input?.yaml ?? '');
    if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(workflowId)) {
      throw new Error('Workflow id must contain only letters, numbers, hyphens, or underscores.');
    }
    if (!yaml.trim() || yaml.length > 2_000_000) {
      throw new Error('Workflow YAML is empty or too large.');
    }
    const requestedProjectDir = String(input?.projectDir ?? '').trim();
    const projectDir = requestedProjectDir ? path.resolve(requestedProjectDir) : '';
    if (projectDir && (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory())) {
      throw new Error('Project directory does not exist.');
    }
    const workflowDir = projectDir
      ? path.join(projectDir, '.bush', 'workflows')
      : path.join(app.getPath('userData'), 'workflows');
    fs.mkdirSync(workflowDir, { recursive: true });
    const filePath = path.join(workflowDir, `${workflowId}.yaml`);
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporaryPath, yaml, 'utf8');
    if (fs.existsSync(filePath)) fs.rmSync(filePath);
    fs.renameSync(temporaryPath, filePath);
    return { path: filePath, scope: projectDir ? 'project' : 'global' };
  },
);

ipcMain.handle('project:git-info', (_, rootPath: string) => {
  return readGitInfo(rootPath);
});

ipcMain.handle('project:git-branches', (_, rootPath: string) => {
  return readGitBranches(rootPath);
});

ipcMain.handle('project:git-checkout', (_, rootPath: string, branch: string) => {
  return checkoutGitBranch(rootPath, branch);
});

ipcMain.handle('project:git-create-branch', (_, rootPath: string, branch: string) => {
  return createGitBranch(rootPath, branch);
});

ipcMain.handle('project:git-commit', (_, rootPath: string, message: string) => {
  return commitGitChanges(rootPath, message);
});

ipcMain.handle('project:git-push', (_, rootPath: string) => {
  return pushGitBranch(rootPath);
});

ipcMain.handle(
  'project:revert-file-changes',
  (
    _,
    rootPath: string,
    files: Array<{ path: string; diff?: string; lines?: string[] }>,
  ) => {
    return revertFileChanges(rootPath, files);
  },
);

ipcMain.handle('terminal:create', (event, cwd?: string, runtime?: TerminalRuntime) => {
  return createTerminalSession(event.sender.id, cwd, runtime);
});

ipcMain.on('terminal:write', (event, sessionId: string, data: string) => {
  const session = terminalSessions.get(sessionId);
  if (!session || session.ownerId !== event.sender.id || session.process.killed) {
    return;
  }
  session.process.stdin.write(process.platform === 'win32' ? data.replace(/\r/g, '\n') : data);
});

ipcMain.on('terminal:resize', (event, sessionId: string, _cols: number, _rows: number) => {
  const session = terminalSessions.get(sessionId);
  if (!session || session.ownerId !== event.sender.id) {
    return;
  }
});

ipcMain.handle('terminal:close', (event, sessionId: string) => {
  const session = terminalSessions.get(sessionId);
  if (!session || session.ownerId !== event.sender.id) {
    return;
  }
  session.process.kill();
  terminalSessions.delete(sessionId);
});

ipcMain.handle('terminal:run', (_, command: string, cwd?: string, runtime?: TerminalRuntime) => {
  return runTerminalCommand(command, cwd, runtime);
});

ipcMain.handle(
  'image:save-data-url',
  (_, dataUrl: string, name?: string, options?: { copyToClipboard?: boolean }) => {
    return saveImageDataUrl(dataUrl, name, options);
  },
);

ipcMain.handle('image:read-data-url', async (event, targetPath: string) => {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender);
  if (!sourceWindow || (sourceWindow !== mainWindow && !shadowWindows.has(event.sender.id))) {
    return '';
  }
  return readLocalImageDataUrl(targetPath);
});

ipcMain.handle('clipboard:show-inspector-context-menu', async (event, payload: {
  guestWebContentsId?: number;
  target?: string;
  x?: number;
  y?: number;
  mediaType?: string;
  srcURL?: string;
  linkURL?: string;
  selectionText?: string;
  isEditable?: boolean;
}) => {
  assertMainWindowSender(event.sender.id);
  const guest = electronWebContents.fromId(Number(payload?.guestWebContentsId));
  if (!guest || guest.isDestroyed() || guest.hostWebContents?.id !== event.sender.id) {
    return;
  }
  const target = String(payload?.target ?? '').trim();
  const localTarget = /^https?:\/\//i.test(target) ? '' : normalizeShellPath(target);
  const localStats = localTarget
    ? await fs.promises.stat(localTarget).catch(() => null)
    : null;
  const selectionText = String(payload?.selectionText ?? '');
  const srcURL = String(payload?.srcURL ?? '').trim();
  const linkURL = String(payload?.linkURL ?? '').trim();
  const x = Number.isFinite(payload?.x) ? Number(payload.x) : 0;
  const y = Number.isFinite(payload?.y) ? Number(payload.y) : 0;
  const template: MenuItemConstructorOptions[] = [];

  if (selectionText) {
    template.push({ label: '复制', click: () => guest.copy() });
  } else if (payload?.isEditable) {
    template.push(
      { label: '剪切', click: () => guest.cut() },
      { label: '复制', click: () => guest.copy() },
      { label: '粘贴', click: () => guest.paste() },
    );
  }
  if (payload?.mediaType === 'image') {
    if (template.length > 0) template.push({ type: 'separator' });
    template.push({
      label: '复制图片',
      click: () => guest.copyImageAt(x, y),
    });
    if (srcURL) {
      template.push({ label: '复制图片地址', click: () => clipboard.writeText(srcURL) });
    }
  }
  if (linkURL) {
    if (template.length > 0) template.push({ type: 'separator' });
    template.push({ label: '复制链接地址', click: () => clipboard.writeText(linkURL) });
  }
  if (localStats?.isFile()) {
    if (template.length > 0) template.push({ type: 'separator' });
    template.push(
      {
        label: '复制文件',
        click: () => void copyLocalFileToClipboard(localTarget),
      },
      { label: '复制文件路径', click: () => clipboard.writeText(localTarget) },
    );
  }
  if (template.length === 0) {
    return;
  }
  Menu.buildFromTemplate(template).popup({ window: mainWindow ?? undefined });
});

ipcMain.handle('cardling:update-state', (event, payload: CardlingDesktopState) => {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender);
  if (sourceWindow !== mainWindow) {
    return;
  }
  lastCardlingState = sanitizeCardlingState(payload);
  if (!lastCardlingState.enabled) {
    cardlingWindow?.hide();
    return;
  }
  const window = createCardlingWindow();
  sendCardlingState();
  if (!window.isVisible()) {
    window.showInactive();
  }
});

ipcMain.handle('cardling:set-expanded', (event, expanded: boolean) => {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender);
  if (sourceWindow !== cardlingWindow || cardlingWindow == null) {
    return;
  }
  cardlingExpanded = expanded;
  if (expanded) {
    resizeCardlingWindow(true);
    cardlingWindow.setFocusable(true);
    cardlingWindow.focus();
    return;
  }
  cardlingWindow.setFocusable(false);
  resizeCardlingWindow(false);
});

ipcMain.handle('cardling:move-by', (event, deltaX: number, deltaY: number) => {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender);
  if (sourceWindow !== cardlingWindow || cardlingWindow == null) {
    return;
  }
  const bounds = cardlingWindow.getBounds();
  const next = ensureBoundsInDisplay({
    ...bounds,
    x: bounds.x + Math.round(Number(deltaX) || 0),
    y: bounds.y + Math.round(Number(deltaY) || 0),
  });
  setCardlingWindowBounds(next, true);
});

ipcMain.handle('cardling:drag-start', (event, cursorX?: number, cursorY?: number) => {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender);
  if (sourceWindow !== cardlingWindow) {
    return;
  }
  startCardlingDrag(cursorX, cursorY);
});

ipcMain.handle('cardling:drag-end', (event) => {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender);
  if (sourceWindow !== cardlingWindow) {
    return;
  }
  stopCardlingDrag(true);
});

ipcMain.handle('cardling:reset-position', (event) => {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender);
  if (sourceWindow !== mainWindow) {
    return;
  }
  try {
    fs.rmSync(cardlingStatePath(), { force: true });
  } catch {
    // Best-effort cleanup.
  }
  if (cardlingWindow != null && !cardlingWindow.isDestroyed()) {
    const bounds = cardlingBoundsForSize(cardlingExpandedSize);
    setCardlingWindowBounds(bounds, true);
  }
});

ipcMain.handle('cardling:action', (event, action: CardlingDesktopAction) => {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender);
  if (sourceWindow !== cardlingWindow || mainWindow == null || mainWindow.isDestroyed()) {
    return;
  }
  if (typeof action === 'object' && action?.type === 'miniChatSend') {
    mainWindow.webContents.send('cardling:action', {
      type: 'miniChatSend',
      text: typeof action.text === 'string' ? action.text : '',
    });
    return;
  }
  if (action === 'openMain') {
    showMainWindow();
    return;
  }
  showMainWindow();
  mainWindow.webContents.send('cardling:action', action);
});

ipcMain.handle('shell:open-path', (event, targetPath: string) => {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender);
  if (sourceWindow !== mainWindow && !shadowWindows.has(event.sender.id)) {
    return 'Open path is only available from the main CardBush window.';
  }
  const normalizedPath = normalizeShellPath(targetPath);
  if (!normalizedPath) {
    return 'Invalid path.';
  }
  return shell.openPath(normalizedPath);
});

ipcMain.handle('shell:open-file-in-cardbush', async (event, targetPath: string) => {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender);
  if (!sourceWindow || sourceWindow !== mainWindow) {
    return 'File preview is only available from the main CardBush window.';
  }
  const normalizedPath = normalizeShellPath(targetPath);
  if (!normalizedPath || !fs.existsSync(normalizedPath)) {
    return 'File does not exist.';
  }
  await openUiPreview(normalizedPath);
  return '';
});

ipcMain.handle('shell:file-context-menu', (event, targetPath: string) => {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender);
  if (!sourceWindow || sourceWindow !== mainWindow) {
    return 'File menu is only available from the main CardBush window.';
  }
  const normalizedPath = normalizeShellPath(targetPath);
  if (!normalizedPath) {
    return 'Invalid path.';
  }
  const fileExists = fs.existsSync(normalizedPath);
  const menu = Menu.buildFromTemplate([
    ...(!fileExists
      ? [{ label: '文件不存在（无法打开）', enabled: false } as const, { type: 'separator' } as const]
      : []),
    {
      label: '在 CardBush 中打开',
      enabled: fileExists,
      click: () => void openUiPreview(normalizedPath),
    },
    {
      label: '打开方式...',
      enabled: fileExists,
      click: () => openFileWithChooser(normalizedPath),
    },
    { type: 'separator' },
    {
      label: '跳转到文件位置',
      enabled: fileExists,
      click: () => shell.showItemInFolder(normalizedPath),
    },
    {
      label: '复制路径',
      click: () => clipboard.writeText(normalizedPath),
    },
  ]);
  menu.popup({ window: sourceWindow });
  return '';
});

ipcMain.handle('shell:open-external', (event, targetUrl: string) => {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender);
  if (sourceWindow !== mainWindow) {
    return;
  }
  return openTargetExternally(targetUrl);
});

ipcMain.handle('shell:open-ui-preview', (event, target: string) => {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender);
  if (sourceWindow !== mainWindow) {
    return;
  }
  return openUiPreview(target);
});

ipcMain.handle('shell:read-text-preview', async (event, targetPath: string) => {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender);
  if (!sourceWindow || sourceWindow !== mainWindow) {
    throw new Error('Text preview is only available from the main CardBush window.');
  }
  const normalizedPath = normalizeShellPath(targetPath);
  if (!normalizedPath) {
    throw new Error('Invalid preview path.');
  }
  const stats = await fs.promises.stat(normalizedPath);
  if (!stats.isFile()) {
    throw new Error('Preview target is not a file.');
  }
  const maxPreviewBytes = 2 * 1024 * 1024;
  const byteCount = Math.min(stats.size, maxPreviewBytes);
  const bytes = await readFilePrefix(normalizedPath, byteCount);
  const zeroBytes = bytes.reduce((count, value) => count + (value === 0 ? 1 : 0), 0);
  if (bytes.length > 0 && zeroBytes / bytes.length > 0.01) {
    throw new Error('Preview target is not a text file.');
  }
  return {
    path: normalizedPath,
    content: bytes.toString('utf8'),
    size: stats.size,
    modifiedAt: stats.mtimeMs,
    truncated: stats.size > maxPreviewBytes,
  };
});

async function runPackagedApplicationSmoke(): Promise<void> {
  const startedAt = Date.now();
  const report: Record<string, unknown> = {
    protocol: 'cardbush.packaged_smoke.v1',
    packaged: cardbushRuntimeIsPackaged,
    platform: process.platform,
    arch: process.arch,
    startedAt: new Date(startedAt).toISOString(),
  };
  let succeeded = false;
  try {
    if (!path.isAbsolute(packagedSmokeResultPath)) {
      throw new Error('CARDBUSH_PACKAGED_SMOKE_RESULT must be an absolute path.');
    }
    const window = createWindow({ reveal: false });
    await Promise.all([
      withPackagedSmokeTimeout(
        packagedSmokeRendererReady,
        15_000,
        'Packaged renderer did not become ready.',
      ),
      startRuntimeServices(),
    ]);
    const controller = runtimeHostController;
    if (!controller || runtimeStartupStatus.phase !== 'ready') {
      throw new Error(runtimeStartupStatus.error || 'Packaged Runtime did not become ready.');
    }
    const capabilityResponse = await withPackagedSmokeTimeout(
      controller.command({
        protocol: bushRuntimeIpcProtocol,
        type: 'command',
        operationId: `packaged-smoke-${randomUUID()}`,
        command: { kind: 'runtime.get_capabilities', payload: {} },
      }),
      10_000,
      'Packaged Runtime capability query timed out.',
    ) as Record<string, unknown>;
    const runtimeCapabilitiesReady = capabilityResponse.type === 'command_response' &&
      capabilityResponse.ok === true &&
      typeof capabilityResponse.result === 'object' &&
      capabilityResponse.result !== null;
    const productSnapshot = await withPackagedSmokeTimeout(
      productHostController?.execute({
        protocol: 'cardbush.product_host_ipc.v1',
        kind: 'apps.get',
      }) ?? Promise.reject(new Error('Product Host is unavailable.')),
      10_000,
      'Packaged Product Host query timed out.',
    );
    const bundledRipgrep = resolveBundledRipgrepPath();
    const assets = {
      runtimeWorker: fs.existsSync(path.join(__dirname, 'runtimeHostWorker.mjs')),
      productHostController: fs.existsSync(path.join(__dirname, 'productHostController.mjs')),
      appsMcp: fs.existsSync(path.join(
        app.getAppPath(),
        'packages',
        'cardbush-apps-mcp',
        'dist',
        'index.js',
      )),
      chromeConnectorMcp: fs.existsSync(path.join(
        app.getAppPath(),
        'packages',
        'cardbush-chrome-mcp',
        'dist',
        'index.js',
      )),
      chromeConnectorExtension: fs.existsSync(path.join(
        process.resourcesPath,
        'chrome-extension',
        'manifest.json',
      )),
      chromeNativeHost: fs.existsSync(path.join(
        process.resourcesPath,
        'chrome-native-host',
        'CardBushBrowserHost.exe',
      )),
      chromeMcp: fs.existsSync(path.join(
        app.getAppPath(),
        'assets',
        'plugins',
        'chrome',
        'runtime',
        'chrome-devtools-mcp',
        'build',
        'src',
        'bin',
        'chrome-devtools-mcp.js',
      )),
      runtimeSearch: process.platform !== 'win32' || Boolean(
        bundledRipgrep && fs.existsSync(bundledRipgrep),
      ),
    };
    succeeded = cardbushRuntimeIsPackaged &&
      runtimeCapabilitiesReady &&
      Object.values(assets).every(Boolean);
    Object.assign(report, {
      rendererReady: !window.webContents.isLoadingMainFrame(),
      rendererUrl: window.webContents.getURL(),
      runtimeStatus: { ...runtimeStartupStatus },
      runtimeCapabilitiesReady,
      productHostReady: productSnapshot != null,
      assets,
    });
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  }

  let shutdownClean = false;
  try {
    await withPackagedSmokeTimeout(
      productHostController?.shutdown() ?? Promise.resolve(),
      8_000,
      'Packaged Runtime shutdown timed out.',
    );
    runtimeHostController?.stop();
    shutdownClean = true;
  } catch (error) {
    report.shutdownError = error instanceof Error ? error.message : String(error);
  }
  report.shutdownClean = shutdownClean;
  report.elapsedMs = Date.now() - startedAt;
  report.success = succeeded && shutdownClean;
  try {
    fs.mkdirSync(path.dirname(packagedSmokeResultPath), { recursive: true });
    fs.writeFileSync(
      packagedSmokeResultPath,
      `${JSON.stringify(report, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
  } catch (error) {
    console.error('[packaged-smoke] failed to write result', error);
  }
  isQuitting = true;
  app.exit(report.success === true ? 0 : 1);
}

function withPackagedSmokeTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

app.whenReady().then(async () => {
  // CardBush owns its complete frameless application chrome. Removing
  // Electron's hidden default menu also removes browser-style reload
  // accelerators that can otherwise blank the integrated renderer mid-Turn.
  Menu.setApplicationMenu(null);
  if (process.platform === 'win32') {
    app.setAppUserModelId(cardbushAppUserModelId);
    Notification.handleActivation((details) => {
      const sessionId = decodeSessionAttentionActivation(details.arguments);
      if (sessionId) {
        activateSessionAttention(sessionId);
      } else {
        showMainWindow();
      }
    });
  }
  registerLocalFileProtocol();
  try {
    await startChromeConnectorBroker();
  } catch (error) {
    console.error('[chrome-connector] bridge failed to start', error);
  }
  if (packagedSmokeMode) {
    await runPackagedApplicationSmoke();
    return;
  }
  createWindow();
  createTray();
  appendDebugLog('startup', {
    stage: 'window-created',
    elapsedMs: Date.now() - desktopStartupStartedAt,
    packaged: cardbushRuntimeIsPackaged,
  });
  void applyProxySettings({
    mode: 'none',
    httpProxy: '',
    httpsProxy: '',
    noProxy: '',
  }).catch(() => undefined);
  void ensureLegacyProductSkillsMigrated();
  void startRuntimeServices();
  setImmediate(() => {
    const shortcutUpdated = ensureWindowsTaskbarShortcut();
    if (process.platform !== 'win32') return;
    const startupIcon = loadCardbushIconWithSource(256);
    appendDebugLog('taskbar', {
      stage: 'app-ready',
      appId: cardbushAppUserModelId,
      appName: app.getName(),
      packaged: cardbushRuntimeIsPackaged,
      electronPackagedDetection: app.isPackaged,
      developmentRuntime: cardbushDevelopmentRuntime,
      execPath: process.execPath,
      appPath: app.getAppPath(),
      sourcePath: startupIcon.sourcePath,
      sourceExists:
        startupIcon.sourcePath !== 'generated-fallback' && fs.existsSync(startupIcon.sourcePath),
      iconSize: startupIcon.image.getSize(),
      shortcutUpdated,
      nativeBackground: backgroundForMainWindowTheme(lastMainWindowTheme),
      contentViewBackgroundSynchronized: true,
    });
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      showMainWindow();
    }
  });
});

function publishRuntimeStartupStatus(next: RuntimeStartupStatus) {
  runtimeStartupStatus = next;
  appendDebugLog('startup', {
    stage: `runtime-${next.phase}`,
    ...next,
    processElapsedMs: Date.now() - desktopStartupStartedAt,
  });
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(runtimeStartupStatusChannel, { ...next });
  }
}

function isComputerUseRuntimeTool(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase();
  return normalized === 'computer_use' || /(?:__|[./:])computer_use$/.test(normalized);
}

async function cancelDesktopControlTool(
  turn: DesktopControlTurn,
  source: 'escape' | 'permission_race',
): Promise<void> {
  const controller = runtimeHostController;
  if (!controller) {
    appendDebugLog('desktop-control', {
      stage: 'tool-cancel-skipped',
      source,
      reason: 'runtime_host_unavailable',
      ...turn,
    });
    return;
  }
  const operationId = `desktop-control-cancel-${randomUUID()}`;
  const response = await controller.command({
    protocol: bushRuntimeIpcProtocol,
    type: 'command',
    operationId,
    command: {
      kind: cancelRuntimeToolCommand,
      payload: turn,
    },
  });
  const responseRecord = response && typeof response === 'object'
    ? response as Record<string, unknown>
    : {};
  appendDebugLog('desktop-control', {
    stage: responseRecord.ok === false ? 'tool-cancel-rejected' : 'tool-cancel-sent',
    source,
    operationId,
    ...turn,
    response,
  });
}

function runtimeTurnKey(sessionId: string, turnId: string): string {
  return JSON.stringify([sessionId, turnId]);
}

function runtimeToolKey(control: DesktopControlTurn): string {
  return JSON.stringify([control.sessionId, control.turnId, control.toolCallId]);
}

function registerDesktopControlMonitor(controller: RuntimeHostController): void {
  unregisterDesktopControlMonitor?.();
  const subscriptionTurns = new Map<string, { sessionId: string; turnId: string }>();
  const activeControls = new Map<string, DesktopControlTurn>();
  const activeChromeTools = new Set<string>();
  const activeChromeTurns = new Set<string>();
  const pendingPermissions = new Map<string, Set<string>>();
  const cancelRequested = new Set<string>();
  const cancelControl = (control: DesktopControlTurn, source: 'permission_race') => {
    const key = runtimeToolKey(control);
    if (cancelRequested.has(key)) return;
    cancelRequested.add(key);
    void cancelDesktopControlTool(control, source).catch((error: unknown) => {
      appendDebugLog('desktop-control', {
        stage: 'tool-cancel-failed',
        source,
        ...control,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
  const clearTurn = (sessionId: string, turnId: string) => {
    const key = runtimeTurnKey(sessionId, turnId);
    pendingPermissions.delete(key);
    activeChromeTurns.delete(key);
    for (const [toolKey, control] of activeControls) {
      if (control.sessionId !== sessionId || control.turnId !== turnId) continue;
      activeControls.delete(toolKey);
      cancelRequested.delete(toolKey);
    }
  };
  unregisterDesktopControlMonitor = controller.onStreamFrame((message) => {
    if (message.type !== 'stream_frame') return;
    if (message.frame.kind === 'event') {
      const { event } = message.frame;
      const turn = { sessionId: event.sessionId, turnId: event.turnId };
      const turnKey = runtimeTurnKey(event.sessionId, event.turnId);
      subscriptionTurns.set(message.subscriptionId, turn);
      if (
        event.kind === 'tool_running' &&
        isComputerUseRuntimeTool(event.payload.toolName)
      ) {
        const control = { ...turn, toolCallId: event.payload.toolCallId };
        activeControls.set(runtimeToolKey(control), control);
        if ((pendingPermissions.get(turnKey)?.size ?? 0) > 0) {
          cancelControl(control, 'permission_race');
        }
      } else if (
        event.kind === 'tool_running' &&
        isChromeRuntimeTool(event.payload.toolName)
      ) {
        activeChromeTurns.add(turnKey);
        activeChromeTools.add(JSON.stringify([
          event.sessionId,
          event.turnId,
          event.payload.toolCallId,
        ]));
      } else if (
        (event.kind === 'tool_returned' ||
          event.kind === 'tool_failed' ||
          event.kind === 'tool_cancelled') &&
        isComputerUseRuntimeTool(event.payload.toolName)
      ) {
        const controlIdentity = { ...turn, toolCallId: event.payload.toolCallId };
        const toolKey = runtimeToolKey(controlIdentity);
        activeControls.delete(toolKey);
        cancelRequested.delete(toolKey);
      } else if (
        (event.kind === 'tool_returned' ||
          event.kind === 'tool_failed' ||
          event.kind === 'tool_cancelled') &&
        isChromeRuntimeTool(event.payload.toolName)
      ) {
        activeChromeTools.delete(JSON.stringify([
          event.sessionId,
          event.turnId,
          event.payload.toolCallId,
        ]));
      } else if (event.kind === 'permission_requested') {
        const permissions = pendingPermissions.get(turnKey) ?? new Set<string>();
        permissions.add(event.payload.permissionId);
        pendingPermissions.set(turnKey, permissions);
        for (const control of activeControls.values()) {
          if (control.sessionId === event.sessionId && control.turnId === event.turnId) {
            cancelControl(control, 'permission_race');
          }
        }
      } else if (
        event.kind === 'permission_answered' ||
        event.kind === 'permission_rejected' ||
        event.kind === 'permission_cancelled' ||
        event.kind === 'permission_expired'
      ) {
        const permissions = pendingPermissions.get(turnKey);
        permissions?.delete(event.payload.permissionId);
        if (permissions?.size === 0) pendingPermissions.delete(turnKey);
      } else if (event.kind === 'turn_terminal') {
        for (const key of [...activeChromeTools]) {
          const [sessionId, turnId] = JSON.parse(key) as string[];
          if (sessionId === event.sessionId && turnId === event.turnId) activeChromeTools.delete(key);
        }
        clearTurn(event.sessionId, event.turnId);
        if (activeChromeTools.size === 0 && activeChromeTurns.size === 0) {
          chromeConnectorBroker?.suspendAll('turn_terminal');
        }
      }
      return;
    }
    const turn = subscriptionTurns.get(message.subscriptionId);
    subscriptionTurns.delete(message.subscriptionId);
    if (turn) {
      clearTurn(turn.sessionId, turn.turnId);
      if (activeChromeTools.size === 0 && activeChromeTurns.size === 0) {
        chromeConnectorBroker?.suspendAll('stream_closed');
      }
    }
  });
}

function disposeDesktopControlMonitor(): void {
  unregisterDesktopControlMonitor?.();
  unregisterDesktopControlMonitor = null;
}

async function startRuntimeServices(force = false): Promise<void> {
  if (runtimeServicesInitialization) return runtimeServicesInitialization;
  if (force) {
    disposeDesktopControlMonitor();
    unregisterRuntimeHostIpc?.();
    unregisterRuntimeHostIpc = null;
    runtimeHostController?.stop();
    runtimeHostController = null;
    productHostController = null;
  }
  const attempt = runtimeStartupStatus.attempt + 1;
  const startedAtMs = Date.now();
  publishRuntimeStartupStatus({
    phase: 'initializing',
    attempt,
    startedAt: new Date(startedAtMs).toISOString(),
  });
  runtimeServicesInitialization = initializeRuntimeHost()
    .then(() => {
      publishRuntimeStartupStatus({
        phase: 'ready',
        attempt,
        startedAt: new Date(startedAtMs).toISOString(),
        completedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAtMs,
      });
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[bush-runtime] IPC initialization failed', error);
      publishRuntimeStartupStatus({
        phase: 'error',
        attempt,
        startedAt: new Date(startedAtMs).toISOString(),
        completedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAtMs,
        error: message,
      });
    })
    .finally(() => {
      runtimeServicesInitialization = null;
    });
  return runtimeServicesInitialization;
}

async function initializeRuntimeHost() {
  try {
    await withRuntimeStartupTimeout(
      initializeRuntimeHostWithinDeadline(),
      runtimeServicesStartupTimeoutMs,
    );
  } catch (error) {
    disposeDesktopControlMonitor();
    unregisterRuntimeHostIpc?.();
    unregisterRuntimeHostIpc = null;
    runtimeHostController?.stop();
    runtimeHostController = null;
    productHostController = null;
    throw error;
  }
}

async function initializeRuntimeHostWithinDeadline() {
  const bundledRipgrep = resolveBundledRipgrepPath();
  const controllerModuleUrl = pathToFileURL(
      path.join(__dirname, 'runtimeHostController.mjs'),
    ).href;
    const controllerModule = await import(controllerModuleUrl);
    const controller = new controllerModule.RuntimeUtilityProcessController({
      modulePath: path.join(__dirname, 'runtimeHostWorker.mjs'),
      startupTimeoutMs: 12_000,
      env: {
        ...process.env,
        CARDBUSH_RUNTIME_STATE_ROOT: path.join(
          app.getPath('userData'),
          'runtime-state',
        ),
        CARDBUSH_SUBAGENT_CONFIG_PATH: path.join(
          app.getPath('userData'),
          'product-host',
          'config',
          'subagents.json',
        ),
        CARDBUSH_RUNTIME_SKILL_ROOTS: JSON.stringify(productSkillRoots()),
        CARDBUSH_RUNTIME_PLUGIN_ROOTS: JSON.stringify(productPluginRoots()),
        ...(bundledRipgrep ? { CARDBUSH_RG_PATH: bundledRipgrep } : {}),
        CARDBUSH_APPS_MCP_ENTRY: path.join(
          app.getAppPath(),
          'packages',
          'cardbush-apps-mcp',
          'dist',
          'index.js',
        ),
        CARDBUSH_CHROME_CONNECTOR_MCP_ENTRY: path.join(
          app.getAppPath(),
          'packages',
          'cardbush-chrome-mcp',
          'dist',
          'index.js',
        ),
        CARDBUSH_CHROME_CONNECTOR_CONFIG:
          chromeConnectorBroker?.configPath ?? path.join(
            app.getPath('userData'),
            'browser-connector',
            'bridge.json',
          ),
        CARDBUSH_CHROME_REMOTE_DEBUGGING_MCP_ENTRY: path.join(
          app.getAppPath(),
          'assets',
          'plugins',
          'chrome',
          'runtime',
          'chrome-devtools-mcp',
          'build',
          'src',
          'bin',
          'chrome-devtools-mcp.js',
        ),
        CARDBUSH_APPS_CONFIG_PATH: productAppsConfigPath(),
      },
      onStderr: (text: string) => console.error('[bush-runtime]', text.trimEnd()),
    }) as RuntimeHostController;
    runtimeHostController = controller;
    registerDesktopControlMonitor(controller);
    unregisterRuntimeHostIpc = controllerModule.registerRuntimeHostIpc(
      ipcMain,
      controller,
      (sender: Electron.WebContents) =>
        (mainWindow != null && sender.id === mainWindow.webContents.id) ||
        shadowWindows.has(sender.id),
    );
  await Promise.all([
    controller.start(),
    initializeProductHost(controller),
  ]);
  await productHostController?.execute({
    protocol: 'cardbush.product_host_ipc.v1',
    kind: 'apps.get',
  });
}

function withRuntimeStartupTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(
        `Runtime services did not become ready within ${timeoutMs}ms`,
      ) as Error & { code?: string };
      error.code = 'runtime_services_startup_timeout';
      reject(error);
    }, timeoutMs);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function initializeProductHost(controller: RuntimeHostController) {
  const moduleUrl = pathToFileURL(
    path.join(__dirname, 'productHostController.mjs'),
  ).href;
  const productModule = await import(moduleUrl);
  const runtimeStateRoot = path.join(app.getPath('userData'), 'runtime-state');
  const bundledSkillRoot = bundledProductSkillRoot();
  const userSkillRoot = path.join(app.getPath('userData'), 'skills');
  const bundledPluginRoot = path.join(app.getAppPath(), 'assets', 'plugins');
  const userPluginRoot = path.join(app.getPath('userData'), 'plugins');
  productHostController = new productModule.ElectronProductHostController({
    dataRoot: path.join(app.getPath('userData'), 'product-host'),
    runtimeStateRoot,
    bundledSkillRoot,
    userSkillRoot,
    bundledPluginRoot,
    userPluginRoot,
    legacyModelConfigPaths: legacyBushserverModelConfigPaths(),
    runtimeBridge: controller,
  }) as {
    execute: (command: unknown) => Promise<unknown>;
    executeTool: (request: { toolName: string; input: unknown }) => Promise<unknown>;
    shutdown: () => Promise<void>;
  };
}

function legacyBushserverModelConfigPaths(): string[] {
  const candidates = [
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'bushserver', 'config', 'model-configs.json')
      : '',
    process.env.APPDATA
      ? path.join(process.env.APPDATA, 'bushserver', 'config', 'model-configs.json')
      : '',
    path.join(os.homedir(), '.local', 'share', 'bushserver', 'config', 'model-configs.json'),
  ].filter(Boolean);
  return [...new Set(candidates)];
}

function legacyBushserverSkillRoots(): string[] {
  const candidates = [
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'bushserver', 'skills')
      : '',
    process.env.APPDATA
      ? path.join(process.env.APPDATA, 'bushserver', 'skills')
      : '',
    path.join(os.homedir(), '.local', 'share', 'bushserver', 'skills'),
  ].filter(Boolean);
  return [...new Set(candidates)];
}

function ensureLegacyProductSkillsMigrated(): Promise<void> {
  legacyProductSkillMigration ??= migrateLegacyProductSkills(
    legacyBushserverSkillRoots(),
    path.join(app.getPath('userData'), 'skills'),
    { excludedNames: legacyProductSkillNamesOwnedByCardbush },
  ).then((result) => {
    if (result.imported.length > 0) {
      console.info(
        `[product-host] imported ${result.imported.length} legacy Skill package(s)`,
      );
    }
    for (const failure of result.failed) {
      console.warn(
        `[product-host] legacy Skill ${failure.name} migration skipped: ${failure.message}`,
      );
    }
  }).catch((error) => {
    console.warn(
      '[product-host] legacy Skill migration skipped:',
      error instanceof Error ? error.message : String(error),
    );
  });
  return legacyProductSkillMigration;
}

function productSkillRoots(): string[] {
  const configuredRoots = process.env.CARDBUSH_PRODUCT_SKILL_ROOTS?.trim();
  const externalRoots = configuredRoots
    ? configuredRoots.split(path.delimiter).map((item) => item.trim()).filter(Boolean)
    : [];
  return [
    bundledProductSkillRoot(),
    path.join(app.getPath('userData'), 'skills'),
    ...externalRoots,
  ];
}

function bundledProductSkillRoot(): string {
  return cardbushRuntimeIsPackaged
    ? path.join(process.resourcesPath, 'skills')
    : path.join(app.getAppPath(), 'assets', 'skills');
}

function resolveBundledRipgrepPath(): string | undefined {
  if (process.platform !== 'win32' || process.arch !== 'x64') return undefined;
  const relativePath = path.join('runtime-tools', 'ripgrep', 'win32-x64', 'rg.exe');
  return cardbushRuntimeIsPackaged
    ? path.join(process.resourcesPath, relativePath)
    : path.join(app.getAppPath(), 'assets', relativePath);
}

function productPluginRoots(): PluginRoot[] {
  return [
    { path: path.join(app.getAppPath(), 'assets', 'plugins'), source: 'bundled' },
    { path: path.join(app.getPath('userData'), 'plugins'), source: 'user' },
  ];
}

function productAppsConfigPath(): string {
  return path.join(app.getPath('userData'), 'product-host', 'config', 'apps.json');
}

function isChromeRuntimeTool(toolName: string): boolean {
  return toolName.startsWith('mcp__chrome_devtools__');
}

async function startChromeConnectorBroker(): Promise<void> {
  if (chromeConnectorBroker) return;
  const broker = new ChromeConnectorBroker(app.getPath('userData'));
  chromeConnectorBroker = broker;
  unregisterChromeConnectorStatus = broker.onStatus((status) => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoadingMainFrame()) {
      mainWindow.webContents.send('chrome-connector:status', {
        ...currentChromeConnectorRegistrationStatus(),
        ...status,
      });
    }
  });
  try {
    await broker.start();
  } catch (error) {
    unregisterChromeConnectorStatus?.();
    unregisterChromeConnectorStatus = null;
    chromeConnectorBroker = null;
    throw error;
  }
}

function currentChromeConnectorRegistrationStatus() {
  if (cachedChromeConnectorRegistrationStatus) {
    return cachedChromeConnectorRegistrationStatus;
  }
  cachedChromeConnectorRegistrationStatus = chromeConnectorRegistrationStatus({
    userDataPath: app.getPath('userData'),
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    nativeHostPath: chromeConnectorNativeHostPath(),
    packaged: cardbushRuntimeIsPackaged,
  });
  return cachedChromeConnectorRegistrationStatus;
}

function chromeConnectorNativeHostPath(): string {
  return cardbushRuntimeIsPackaged
    ? path.join(process.resourcesPath, 'chrome-native-host', 'CardBushBrowserHost.exe')
    : path.join(app.getAppPath(), 'dist-native', 'chrome-connector', 'CardBushBrowserHost.exe');
}

function currentChromeConnectorStatus():
  ReturnType<typeof currentChromeConnectorRegistrationStatus> & ChromeConnectorStatus {
  const brokerStatus = chromeConnectorBroker?.status() ?? {
    protocol: 'cardbush.chrome_connector.v1' as const,
    bridgeRunning: false,
    extensionConnected: false,
    controlledTabCount: 0,
  };
  return {
    ...currentChromeConnectorRegistrationStatus(),
    ...brokerStatus,
  };
}

async function activeProductSkillRoots(): Promise<ProductSkillRoot[]> {
  const productRoots = productSkillRoots();
  const pluginRoots = await loadEnabledProductPluginSkillRootEntries(
    productPluginRoots(),
    productAppsConfigPath(),
  );
  return [
    {
      path: productRoots[0],
      source: 'bundled',
      sourceId: 'cardbush',
      sourceLabel: 'CardBush',
    },
    ...pluginRoots.map((root) => ({
      path: root.path,
      source: 'plugin' as const,
      sourceId: root.pluginId,
      sourceLabel: root.pluginName,
    })),
    {
      path: productRoots[1],
      source: 'user',
      sourceId: 'user',
      sourceLabel: 'User',
    },
    ...productRoots.slice(2).map((root, index) => ({
      path: root,
      source: 'external' as const,
      sourceId: `external-${index + 1}`,
      sourceLabel: path.basename(root),
    })),
  ];
}

function registerLocalFileProtocol() {
  if (protocol.isProtocolHandled(localFileProtocol)) {
    return;
  }
  protocol.handle(localFileProtocol, async (request) => {
    try {
      const parsed = new URL(request.url);
      const protocolHost = parsed.hostname.toLowerCase();
      if (protocolHost === 'office-source') {
        const officePath = normalizeShellPath(parsed.searchParams.get('path') ?? '');
        const stats = await fs.promises.stat(officePath);
        if (!stats.isFile() || !isHighFidelityOfficePreviewPath(officePath)) {
          return new Response('Not found', { status: 404 });
        }
        const bytes = request.method === 'HEAD'
          ? null
          : await fs.promises.readFile(officePath);
        return new Response(bytes ? new Uint8Array(bytes) : null, {
          headers: {
            'content-type': contentTypeForPath(officePath),
            'content-length': String(stats.size),
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
          },
        });
      }
      if (protocolHost === 'office-preview') {
        if (parsed.pathname.startsWith('/assets/')) {
          return await officePreviewRendererAssetResponse(parsed.pathname)
            ?? new Response('Not found', { status: 404 });
        }
        const officePath = normalizeShellPath(parsed.searchParams.get('path') ?? '');
        const stats = await fs.promises.stat(officePath);
        if (!stats.isFile() || !isOfficePreviewPath(officePath)) {
          return new Response('Not found', { status: 404 });
        }
        if (
          isHighFidelityOfficePreviewPath(officePath) &&
          parsed.searchParams.get('renderer') !== 'compat'
        ) {
          const rendererResponse = await officePreviewRendererEntryResponse(officePath);
          if (rendererResponse != null) {
            return rendererResponse;
          }
        }
        let previewHtml: string;
        try {
          previewHtml = await renderOfficePreview(officePath);
        } catch (error) {
          previewHtml = await renderTextFilePreview(
            officePath,
            error instanceof Error ? error.message : String(error),
          );
        }
        return new Response(previewHtml, {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
          },
        });
      }
      if (parsed.hostname.toLowerCase() === 'text-preview') {
        const textPath = normalizeShellPath(parsed.searchParams.get('path') ?? '');
        const stats = await fs.promises.stat(textPath);
        if (!stats.isFile()) {
          return new Response('Not found', { status: 404 });
        }
        return new Response(await renderTextFilePreview(textPath), {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
          },
        });
      }
      const targetPath = localPathFromProtocolUrl(request.url);
      const normalizedPath = normalizeShellPath(targetPath);
      const stats = await fs.promises.stat(normalizedPath);
      if (!stats.isFile()) {
        return new Response('Not found', { status: 404 });
      }
      const contentType = contentTypeForPath(normalizedPath);
      const responseType = contentType === 'application/octet-stream'
        ? contentTypeForBytes(await readFilePrefix(normalizedPath, 512))
        : contentType;
      const range = byteRangeFromHeader(request.headers.get('range'), stats.size);
      if (range) {
        const length = range.end - range.start + 1;
        const bytes = Buffer.allocUnsafe(length);
        const handle = await fs.promises.open(normalizedPath, 'r');
        try {
          await handle.read(bytes, 0, length, range.start);
        } finally {
          await handle.close();
        }
        return new Response(request.method === 'HEAD' ? null : new Uint8Array(bytes), {
          status: 206,
          headers: {
            'content-type': responseType,
            'content-length': String(length),
            'content-range': `bytes ${range.start}-${range.end}/${stats.size}`,
            'accept-ranges': 'bytes',
            'cache-control': 'public, max-age=31536000, immutable',
          },
        });
      }
      const bytes = request.method === 'HEAD'
        ? null
        : await fs.promises.readFile(normalizedPath);
      return new Response(bytes ? new Uint8Array(bytes) : null, {
        headers: {
          'content-type': responseType,
          'content-length': String(stats.size),
          'accept-ranges': 'bytes',
          'cache-control': 'public, max-age=31536000, immutable',
        },
      });
    } catch (error) {
      console.error(`[${localFileProtocol}] failed to load ${request.url}`, error);
      return new Response('Not found', { status: 404 });
    }
  });
}

function isHighFidelityOfficePreviewPath(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();
  return extension === '.xlsx' || extension === '.pptx' || extension === '.ppt';
}

async function officePreviewRendererEntryResponse(officePath: string) {
  if (devServerUrl) {
    const url = new URL('/office-preview.html', devServerUrl);
    url.searchParams.set('path', officePath);
    return Response.redirect(url.toString(), 302);
  }
  return officePreviewRendererAssetResponse('/office-preview.html', false);
}

async function officePreviewRendererAssetResponse(
  requestPath: string,
  immutable = true,
): Promise<Response | null> {
  const rendererRoot = path.resolve(__dirname, '../dist');
  const relativePath = decodeURIComponent(requestPath)
    .replace(/^[/\\]+/, '')
    .replaceAll('/', path.sep);
  if (!relativePath) {
    return null;
  }
  const assetPath = path.resolve(rendererRoot, relativePath);
  const relativeToRoot = path.relative(rendererRoot, assetPath);
  if (
    !relativeToRoot ||
    relativeToRoot.startsWith('..') ||
    path.isAbsolute(relativeToRoot)
  ) {
    return null;
  }
  let stats: fs.Stats;
  try {
    stats = await fs.promises.stat(assetPath);
  } catch {
    return null;
  }
  if (!stats.isFile()) {
    return null;
  }
  const bytes = await fs.promises.readFile(assetPath);
  return new Response(new Uint8Array(bytes), {
    headers: {
      'content-type': contentTypeForPath(assetPath),
      'content-length': String(stats.size),
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

app.on('before-quit', (event) => {
  isQuitting = true;
  if (hostShutdownComplete) {
    return;
  }
  event.preventDefault();
  if (hostShutdownPromise == null) {
    hostShutdownPromise = (productHostController?.shutdown() ?? Promise.resolve()).finally(() => {
      hostShutdownComplete = true;
      app.quit();
    });
  }
});

app.on('will-quit', () => {
  unregisterChromeConnectorStatus?.();
  unregisterChromeConnectorStatus = null;
  chromeConnectorBroker?.stop();
  chromeConnectorBroker = null;
  disposeDesktopControlMonitor();
  unregisterRuntimeHostIpc?.();
  unregisterRuntimeHostIpc = null;
  runtimeHostController?.stop();
  runtimeHostController = null;
  productHostController = null;
  if (quitFallbackTimer != null) {
    clearTimeout(quitFallbackTimer);
    quitFallbackTimer = null;
  }
  for (const session of terminalSessions.values()) {
    session.process.kill();
  }
  terminalSessions.clear();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

function safeUrl(value: string) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function modelListEndpoint(baseUrl: string) {
  const trimmed = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) {
    throw new Error('Missing base_url');
  }
  const parsed = safeUrl(trimmed);
  if (parsed == null || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
    throw new Error('base_url must be an http(s) URL');
  }
  const normalizedPath = parsed.pathname.replace(/\/+$/, '');
  parsed.pathname = normalizedPath.endsWith('/models')
    ? normalizedPath
    : `${normalizedPath || ''}/models`;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function parseJsonRecord(text: string) {
  try {
    const value = JSON.parse(text);
    return value != null && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function modelIdsFromPayload(payload: Record<string, unknown>) {
  const candidates = [
    payload.data,
    payload.models,
    payload.items,
  ];
  const ids = candidates.flatMap(modelIdsFromUnknown);
  return Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean))).sort(
    (left, right) => left.localeCompare(right),
  );
}

function modelIdsFromUnknown(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      if (typeof item === 'string') {
        return item;
      }
      if (item == null || typeof item !== 'object' || Array.isArray(item)) {
        return '';
      }
      const record = item as Record<string, unknown>;
      return String(record.id ?? record.name ?? record.model ?? '').trim();
    })
    .filter(Boolean);
}

function normalizeShellPath(value: string) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) {
    return '';
  }
  if (/^file:/i.test(trimmed)) {
    try {
      const fileUrl = new URL(trimmed);
      const decodedPath = decodeURIComponent(fileUrl.pathname);
      if (fileUrl.hostname) {
        return `\\\\${fileUrl.hostname}${decodedPath.replace(/\//g, '\\')}`;
      }
      return decodedPath.replace(/^\/([a-zA-Z]:)/, '$1').replace(/\//g, '\\');
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function localPathFromProtocolUrl(value: string) {
  return localFileSystemPathFromProtocolUrl(value);
}

function imageMimeTypeForPath(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.png') {
    return 'image/png';
  }
  if (extension === '.jpg' || extension === '.jpeg') {
    return 'image/jpeg';
  }
  if (extension === '.webp') {
    return 'image/webp';
  }
  if (extension === '.gif') {
    return 'image/gif';
  }
  if (extension === '.bmp') {
    return 'image/bmp';
  }
  if (extension === '.ico') {
    return 'image/x-icon';
  }
  return '';
}

function audioMimeTypeForPath(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.mp3') {
    return 'audio/mpeg';
  }
  if (extension === '.m4a') {
    return 'audio/mp4';
  }
  if (extension === '.aac') {
    return 'audio/aac';
  }
  if (extension === '.wav') {
    return 'audio/wav';
  }
  if (extension === '.ogg' || extension === '.oga' || extension === '.opus') {
    return 'audio/ogg';
  }
  if (extension === '.flac') {
    return 'audio/flac';
  }
  return '';
}

function videoMimeTypeForPath(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.mp4' || extension === '.m4v') return 'video/mp4';
  if (extension === '.webm') return 'video/webm';
  if (extension === '.ogv') return 'video/ogg';
  if (extension === '.mov') return 'video/quicktime';
  return '';
}

function contentTypeForPath(filePath: string) {
  const imageMimeType = imageMimeTypeForPath(filePath);
  if (imageMimeType) {
    return imageMimeType;
  }
  const videoMimeType = videoMimeTypeForPath(filePath);
  if (videoMimeType) {
    return videoMimeType;
  }
  const audioMimeType = audioMimeTypeForPath(filePath);
  if (audioMimeType) {
    return audioMimeType;
  }
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.html' || extension === '.htm') {
    return 'text/html; charset=utf-8';
  }
  if (extension === '.js' || extension === '.mjs') {
    return 'text/javascript; charset=utf-8';
  }
  if (extension === '.css') {
    return 'text/css; charset=utf-8';
  }
  if (extension === '.json' || extension === '.map') {
    return 'application/json; charset=utf-8';
  }
  if (extension === '.wasm') {
    return 'application/wasm';
  }
  if (extension === '.xlsx') {
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }
  if (extension === '.pptx') {
    return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  }
  if (extension === '.ppt') {
    return 'application/vnd.ms-powerpoint';
  }
  if (extension === '.ttf') {
    return 'font/ttf';
  }
  if (extension === '.otf') {
    return 'font/otf';
  }
  if (extension === '.woff') {
    return 'font/woff';
  }
  if (extension === '.woff2') {
    return 'font/woff2';
  }
  if (extension === '.svg') {
    return 'image/svg+xml';
  }
  return 'application/octet-stream';
}

async function readFilePrefix(filePath: string, length: number) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const bytes = Buffer.alloc(length);
    const result = await handle.read(bytes, 0, length, 0);
    return bytes.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }
}

function byteRangeFromHeader(value: string | null, size: number) {
  if (!value || !Number.isFinite(size) || size <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return null;
  let start = match[1] ? Number.parseInt(match[1], 10) : Number.NaN;
  let end = match[2] ? Number.parseInt(match[2], 10) : Number.NaN;
  if (!Number.isFinite(start)) {
    const suffixLength = Math.min(size, end);
    start = size - suffixLength;
    end = size - 1;
  } else {
    end = Number.isFinite(end) ? Math.min(end, size - 1) : size - 1;
  }
  if (start < 0 || start >= size || end < start) return null;
  return { start, end };
}

async function renderTextFilePreview(filePath: string, previewError = '') {
  const maxPreviewBytes = 2 * 1024 * 1024;
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const stats = await handle.stat();
    const byteCount = Math.min(stats.size, maxPreviewBytes);
    const bytes = Buffer.alloc(byteCount);
    await handle.read(bytes, 0, byteCount, 0);
    const zeroBytes = bytes.reduce((count, value) => count + (value === 0 ? 1 : 0), 0);
    const likelyBinary = bytes.length > 0 && zeroBytes / bytes.length > 0.01;
    const text = likelyBinary
      ? Array.from(bytes.subarray(0, Math.min(bytes.length, 4096)))
          .map((value, index) => `${index % 16 === 0 ? `\n${index.toString(16).padStart(8, '0')}  ` : ''}${value.toString(16).padStart(2, '0')} `)
          .join('')
          .trim()
      : bytes.toString('utf8');
    const notice = previewError
      ? `专用预览加载失败，已切换为文本兜底：${previewError}`
      : likelyBinary
        ? '检测到二进制内容，以下显示前 4 KiB 十六进制数据。'
        : stats.size > maxPreviewBytes
          ? '文件较大，仅显示前 2 MiB。'
          : '文本兜底预览';
    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="color-scheme" content="dark light">
<title>${escapePreviewHtml(path.basename(filePath))}</title>
<style>
:root { color-scheme: dark; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; background:#1c1b19; color:#dedbd4; }
body { margin:0; min-height:100vh; background:#1c1b19; }
header { position:sticky; top:0; padding:10px 14px; background:#2b2b2b; border-bottom:1px solid rgba(255,255,255,.08); z-index:1; }
header strong { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font:600 12px system-ui,sans-serif; }
header small { display:block; margin-top:4px; color:#99958d; font:11px system-ui,sans-serif; }
pre { margin:0; padding:14px; overflow:auto; color:#d7d3cb; font-size:12px; line-height:1.55; white-space:pre-wrap; overflow-wrap:anywhere; tab-size:2; }
</style></head><body><header><strong>${escapePreviewHtml(filePath)}</strong><small>${escapePreviewHtml(notice)}</small></header><pre>${escapePreviewHtml(text)}</pre></body></html>`;
  } finally {
    await handle.close();
  }
}

function escapePreviewHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function contentTypeForBytes(bytes: Uint8Array) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return 'application/octet-stream';
}

function isWebProtocol(value: URL) {
  return value.protocol === 'http:' || value.protocol === 'https:';
}

function isAllowedAppNavigation(targetUrl: string) {
  if (targetUrl === 'about:blank') {
    return true;
  }
  const parsed = safeUrl(targetUrl);
  if (parsed == null) {
    return false;
  }
  if (parsed.protocol === 'file:') {
    try {
      return path.resolve(fileURLToPath(parsed)) === path.resolve(__dirname, '../dist/index.html');
    } catch {
      return false;
    }
  }
  if (devServerUrl) {
    const devUrl = safeUrl(devServerUrl);
    return (
      devUrl != null &&
      parsed.protocol === devUrl.protocol &&
      parsed.host === devUrl.host
    );
  }
  return false;
}

async function applyProxySettings(proxy: {
  mode: 'none' | 'system' | 'manual';
  httpProxy: string;
  httpsProxy: string;
  noProxy: string;
}) {
  if (proxy.mode === 'system') {
    await session.defaultSession.setProxy({ mode: 'system' });
    return;
  }
  if (proxy.mode === 'none') {
    await session.defaultSession.setProxy({ mode: 'direct' });
    return;
  }
  const rules = [
    proxy.httpProxy.trim() ? `http=${normalizeProxyRule(proxy.httpProxy)}` : '',
    proxy.httpsProxy.trim() ? `https=${normalizeProxyRule(proxy.httpsProxy)}` : '',
  ].filter(Boolean);
  await session.defaultSession.setProxy({
    mode: rules.length > 0 ? 'fixed_servers' : 'direct',
    proxyRules: rules.join(';'),
    proxyBypassRules: proxy.noProxy.trim(),
  });
}

function normalizeProxyRule(value: string) {
  const trimmed = value.trim();
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `http://${trimmed}`;
}

function isLoopback(host: string) {
  const normalized = host.toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

type WallpaperAccentResult = {
  r: number;
  g: number;
  b: number;
  hex: string;
  source: 'wallpaper' | 'fallback';
};

let wallpaperAccentCache: {
  signature: string;
  value: WallpaperAccentResult;
} | null = null;

function readWallpaperAccent(): WallpaperAccentResult {
  const fallback = normalizeAccent({ r: 99, g: 123, b: 97 });
  try {
    const wallpaperPath = currentWallpaperPath();
    if (!wallpaperPath) {
      return { ...fallback, source: 'fallback' };
    }
    const stats = fs.statSync(wallpaperPath);
    const signature = `${wallpaperPath}\u0000${stats.size}\u0000${stats.mtimeMs}`;
    if (wallpaperAccentCache?.signature === signature) {
      return wallpaperAccentCache.value;
    }
    const color = dominantColorFromImage(wallpaperPath);
    if (!color) {
      return { ...fallback, source: 'fallback' };
    }
    const value: WallpaperAccentResult = {
      ...normalizeAccent(color),
      source: 'wallpaper',
    };
    wallpaperAccentCache = { signature, value };
    return value;
  } catch {
    return { ...fallback, source: 'fallback' };
  }
}

function currentWallpaperPath() {
  const transcodedWallpaper = path.join(
    os.homedir(),
    'AppData',
    'Roaming',
    'Microsoft',
    'Windows',
    'Themes',
    'TranscodedWallpaper',
  );
  const candidates = [
    transcodedWallpaper,
    ...cachedWallpaperPaths(),
    readRegistryValue(
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Wallpapers',
      'BackgroundHistoryPath0',
    ),
    readRegistryValue('HKCU\\Control Panel\\Desktop', 'WallPaper'),
  ]
    .map((candidate) => expandWindowsEnv(candidate.trim()))
    .filter(Boolean)
    .filter((candidate, index, all) => all.indexOf(candidate) === index);
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ?? '';
}

function assertMainWindowSender(senderId: number) {
  if (mainWindow == null || mainWindow.isDestroyed() || mainWindow.webContents.id !== senderId) {
    throw new Error('Desktop integration is only available to the main CardBush window.');
  }
}

function assertRuntimeRendererSender(senderId: number) {
  if (
    (mainWindow != null && !mainWindow.isDestroyed() && mainWindow.webContents.id === senderId) ||
    shadowWindows.has(senderId)
  ) {
    return;
  }
  throw new Error('Runtime integration is unavailable to this window.');
}

function filesystemLocations() {
  const candidates = [
    ['home', 'Home', app.getPath('home')],
    ['desktop', 'Desktop', app.getPath('desktop')],
    ['documents', 'Documents', app.getPath('documents')],
    ['downloads', 'Downloads', app.getPath('downloads')],
    ['pictures', 'Pictures', app.getPath('pictures')],
    ['music', 'Music', app.getPath('music')],
  ] as const;
  return candidates
    .filter(([, , targetPath]) => Boolean(targetPath) && fs.existsSync(targetPath))
    .map(([id, name, targetPath]) => ({ id, name, path: targetPath }));
}




function readRegistryValue(key: string, name: string) {
  if (process.platform !== 'win32') {
    return '';
  }
  try {
    const output = execFileSync('reg', ['query', key, '/v', name], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const line = output.split(/\r?\n/).find((value) => value.includes(name));
    const match = line?.match(/\s+REG_\w+\s+(.+)$/);
    return match?.[1]?.trim() ?? '';
  } catch {
    return '';
  }
}

function cachedWallpaperPaths() {
  if (process.platform !== 'win32') {
    return [];
  }
  const cacheDir = path.join(
    os.homedir(),
    'AppData',
    'Roaming',
    'Microsoft',
    'Windows',
    'Themes',
    'CachedFiles',
  );
  try {
    return fs.readdirSync(cacheDir)
      .filter((name) => /\.(bmp|gif|jpe?g|png|webp)$/i.test(name))
      .map((name) => path.join(cacheDir, name))
      .sort((left, right) => {
        try {
          return fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs;
        } catch {
          return 0;
        }
      });
  } catch {
    return [];
  }
}

function expandWindowsEnv(value: string) {
  return value.replace(/%([^%]+)%/g, (_, name: string) => process.env[name] ?? '');
}

type ColorBucket = {
  r: number;
  g: number;
  b: number;
  count: number;
  saturationTotal: number;
  lumaTotal: number;
  score: number;
};

function dominantColorFromImage(filePath: string) {
  let image = nativeImage.createFromPath(filePath);
  if (image.isEmpty()) {
    image = nativeImage.createFromBuffer(fs.readFileSync(filePath));
  }
  if (image.isEmpty()) {
    return null;
  }
  const sample = image.resize({ width: 96, quality: 'good' });
  const { width, height } = sample.getSize();
  const bitmap = sample.toBitmap();
  const buckets = new Map<string, ColorBucket>();
  const bytesPerPixel = Math.max(4, Math.floor(bitmap.length / Math.max(1, width * height)));
  const bgra = process.platform === 'win32' || process.platform === 'linux';
  let sampled = 0;

  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const index = (y * width + x) * bytesPerPixel;
      const first = bitmap[index] ?? 0;
      const second = bitmap[index + 1] ?? 0;
      const third = bitmap[index + 2] ?? 0;
      const alpha = bitmap[index + 3] ?? 255;
      if (alpha < 128) {
        continue;
      }
      const r = bgra ? third : first;
      const g = second;
      const b = bgra ? first : third;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const chroma = max - min;
      const saturation = max === 0 ? 0 : chroma / max;
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (luma < 14 || luma > 246) {
        continue;
      }
      sampled += 1;
      const hue = hueFromRgb(r, g, b);
      const hueBand = saturation < 0.12 ? 'neutral' : Math.round(hue / 18) % 20;
      const lightBand = Math.max(0, Math.min(5, Math.floor(luma / 43)));
      const saturationBand = Math.max(0, Math.min(4, Math.floor(saturation * 5)));
      const key = `${hueBand}:${lightBand}:${saturationBand}`;
      const bucket = buckets.get(key) ?? {
        r: 0,
        g: 0,
        b: 0,
        count: 0,
        saturationTotal: 0,
        lumaTotal: 0,
        score: 0,
      };
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
      bucket.count += 1;
      bucket.saturationTotal += saturation;
      bucket.lumaTotal += luma;
      buckets.set(key, bucket);
    }
  }

  const values = [...buckets.values()];
  const minCount = Math.max(3, sampled * 0.018);
  const candidates = values.filter((bucket) => bucket.count >= minCount);
  for (const bucket of candidates) {
    const saturation = bucket.saturationTotal / bucket.count;
    const luma = bucket.lumaTotal / bucket.count;
    const lumaPenalty = luma < 32 || luma > 224 ? 0.72 : 1;
    bucket.score = bucket.count * (0.82 + Math.min(saturation, 0.85) * 0.36) * lumaPenalty;
  }
  const best = (candidates.length ? candidates : values).sort(
    (left, right) => right.score - left.score || right.count - left.count,
  )[0];
  if (!best || best.count === 0) {
    return null;
  }
  return {
    r: Math.round(best.r / best.count),
    g: Math.round(best.g / best.count),
    b: Math.round(best.b / best.count),
  };
}

function hueFromRgb(r: number, g: number, b: number) {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const chroma = max - min;
  if (chroma === 0) {
    return 0;
  }
  let hue = 0;
  if (max === red) {
    hue = ((green - blue) / chroma) % 6;
  } else if (max === green) {
    hue = (blue - red) / chroma + 2;
  } else {
    hue = (red - green) / chroma + 4;
  }
  return (hue * 60 + 360) % 360;
}

function normalizeAccent(color: { r: number; g: number; b: number }) {
  let { r, g, b } = color;
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (luma < 58) {
    const amount = 0.28;
    r = Math.round(r + (255 - r) * amount);
    g = Math.round(g + (255 - g) * amount);
    b = Math.round(b + (255 - b) * amount);
  } else if (luma > 198) {
    const amount = 0.22;
    r = Math.round(r * (1 - amount));
    g = Math.round(g * (1 - amount));
    b = Math.round(b * (1 - amount));
  }
  return {
    r,
    g,
    b,
    hex: rgbToHex(r, g, b),
  };
}

function rgbToHex(r: number, g: number, b: number) {
  return `#${[r, g, b]
    .map((value) => Math.max(0, Math.min(255, value)).toString(16).padStart(2, '0'))
    .join('')}`;
}

function listProjectRoot(rootPath: string) {
  const root = path.resolve(rootPath);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return [];
  }
  const entries = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => {
      if (!entry.name || entry.name.startsWith('.')) {
        return false;
      }
      if (entry.isDirectory() && ignoredProjectSearchDirs.has(entry.name)) {
        return false;
      }
      return entry.isDirectory() || entry.isFile();
    })
    .sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) {
        return left.isDirectory() ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    })
    .slice(0, 12)
    .map((entry) => ({
      name: entry.name,
      path: path.join(root, entry.name),
      kind: entry.isDirectory() ? 'folder' : 'file',
    }));
  return entries;
}

function searchProjectFiles(rootPath: string, query: string): ProjectFileSearchResult[] {
  const root = resolveSafeProjectSearchRoot(rootPath);
  if (!root) {
    return [];
  }
  const normalizedQuery = normalizeProjectSearchText(query);
  const ranked: Array<ProjectFileSearchResult & { score: [number, number, number, string] }> = [];
  let visited = 0;

  const walk = (directory: string, depth: number) => {
    if (depth > projectFileSearchMaxDepth || visited >= projectFileSearchMaxVisited) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) {
        return left.isDirectory() ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });
    for (const entry of entries) {
      if (visited >= projectFileSearchMaxVisited) {
        return;
      }
      if (!entry.name || shouldIgnoreProjectSearchEntry(entry)) {
        continue;
      }
      const fullPath = path.join(directory, entry.name);
      const kind = entry.isDirectory() ? 'folder' : entry.isFile() ? 'file' : null;
      if (!kind) {
        continue;
      }
      visited += 1;
      const relativePath = normalizeRelativeProjectPath(path.relative(root, fullPath));
      const score = scoreProjectSearchEntry(
        relativePath,
        entry.name,
        normalizedQuery,
        depth,
        kind,
      );
      if (score) {
        ranked.push({
          name: entry.name,
          path: fullPath,
          relativePath,
          kind,
          score,
        });
      }
      if (entry.isDirectory() && depth < projectFileSearchMaxDepth) {
        walk(fullPath, depth + 1);
      }
    }
  };

  walk(root, 1);
  return ranked
    .sort((left, right) =>
      left.score[0] - right.score[0] ||
      left.score[1] - right.score[1] ||
      left.score[2] - right.score[2] ||
      left.score[3].localeCompare(right.score[3]),
    )
    .slice(0, projectFileSearchMaxResults)
    .map(({ score: _score, ...item }) => item);
}

function resolveSafeProjectSearchRoot(rootPath: string) {
  const raw = String(rootPath ?? '').trim();
  if (!raw) {
    return null;
  }
  const root = path.resolve(raw);
  try {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      return null;
    }
  } catch {
    return null;
  }
  if (isUnsafeProjectSearchRoot(root)) {
    return null;
  }
  return root;
}

function isUnsafeProjectSearchRoot(root: string) {
  const normalized = path.resolve(root);
  const parsed = path.parse(normalized);
  if (normalized === path.resolve(parsed.root)) {
    return true;
  }
  const home = path.resolve(os.homedir());
  if (sameResolvedPath(normalized, home)) {
    return true;
  }
  return false;
}

function sameResolvedPath(left: string, right: string) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function shouldIgnoreProjectSearchEntry(entry: fs.Dirent) {
  return entry.isDirectory() && ignoredProjectSearchDirs.has(entry.name);
}

function normalizeRelativeProjectPath(value: string) {
  return value.replaceAll(path.sep, '/').replaceAll('\\', '/');
}

function normalizeProjectSearchText(value: string) {
  return normalizeRelativeProjectPath(String(value ?? '').trim()).toLowerCase();
}

function scoreProjectSearchEntry(
  relativePath: string,
  name: string,
  query: string,
  depth: number,
  kind: 'file' | 'folder',
): [number, number, number, string] | null {
  const normalizedPath = normalizeProjectSearchText(relativePath);
  const normalizedName = normalizeProjectSearchText(name);
  const kindPenalty = kind === 'folder' ? 1 : 0;
  if (!query) {
    return [depth * 10 + kindPenalty, normalizedPath.length, 0, normalizedPath];
  }
  if (normalizedPath === query) {
    return [0 + kindPenalty, 0, depth, normalizedPath];
  }
  if (normalizedName === query) {
    return [1 + kindPenalty, 0, depth, normalizedPath];
  }
  if (normalizedPath.startsWith(query)) {
    return [2 + kindPenalty, 0, depth, normalizedPath];
  }
  if (normalizedName.startsWith(query)) {
    return [3 + kindPenalty, 0, depth, normalizedPath];
  }
  const pathIndex = normalizedPath.indexOf(query);
  if (pathIndex >= 0) {
    return [10 + kindPenalty, pathIndex, depth, normalizedPath];
  }
  return null;
}

function readGitInfo(rootPath: string) {
  const root = path.resolve(rootPath);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return {
      branch: '',
      root,
      changedFiles: [],
      missing: true,
      error: `Project directory does not exist: ${root}`,
    };
  }
  try {
    const branch = runGit(root, ['branch', '--show-current']).trim();
    const statusRaw = runGit(root, ['status', '--short']);
    const changedFiles = statusRaw
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map((line) => ({
        status: line.slice(0, 2).trim() || '?',
        path: line.slice(3).trim(),
      }));
    return { branch, root, changedFiles };
  } catch (caught) {
    return {
      branch: '',
      root,
      changedFiles: [],
      error: commandErrorMessage(caught),
    };
  }
}

function readGitBranches(rootPath: string) {
  const root = requireGitRoot(rootPath);
  const local = readLocalGitBranches(root);
  const remote = readRemoteGitBranches(root).filter((branch) => {
    const localName = localNameFromRemoteBranch(branch);
    return !local.includes(branch) && !local.includes(localName);
  });
  return [...new Set([...local, ...remote])].sort((left, right) =>
    left.localeCompare(right),
  );
}

function checkoutGitBranch(rootPath: string, branch: string) {
  const root = requireGitRoot(rootPath);
  const target = normalizeGitName(branch, 'branch');
  const local = readLocalGitBranches(root);
  const remote = readRemoteGitBranches(root);
  const output = checkoutGitBranchTarget(root, target, local, remote);
  const info = readGitInfo(root);
  return {
    branch: info.branch,
    output: output.trim() || `Switched to ${target}`,
  };
}

function readLocalGitBranches(root: string) {
  return runGit(root, ['branch', '--format=%(refname:short)'])
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^\*\s*/, ''))
    .filter(Boolean);
}

function readRemoteGitBranches(root: string) {
  return runGit(root, ['branch', '-r', '--format=%(refname:short)'])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.includes('->') && !line.endsWith('/HEAD'));
}

function checkoutGitBranchTarget(root: string, target: string, local: string[], remote: string[]) {
  if (local.includes(target)) {
    return runGit(root, ['switch', target]);
  }

  if (remote.includes(target)) {
    const localName = localNameFromRemoteBranch(target);
    if (localName && local.includes(localName)) {
      return runGit(root, ['switch', localName]);
    }
    return runGit(root, ['switch', '--track', target]);
  }

  const remoteMatches = remote.filter((branch) => localNameFromRemoteBranch(branch) === target);
  if (remoteMatches.length === 1) {
    return runGit(root, ['switch', '--track', remoteMatches[0]]);
  }

  return runGit(root, ['switch', target]);
}

function localNameFromRemoteBranch(branch: string) {
  const separatorIndex = branch.indexOf('/');
  return separatorIndex >= 0 ? branch.slice(separatorIndex + 1) : branch;
}

function createGitBranch(rootPath: string, branch: string) {
  const root = requireGitRoot(rootPath);
  const target = normalizeGitName(branch, 'branch');
  const output = runGit(root, ['switch', '-c', target]);
  const info = readGitInfo(root);
  return {
    branch: info.branch,
    output: output.trim() || `Created and switched to ${target}`,
  };
}

function commitGitChanges(rootPath: string, message: string) {
  const root = requireGitRoot(rootPath);
  const normalizedMessage = message.trim();
  if (!normalizedMessage) {
    throw new Error('Commit message is empty.');
  }
  runGit(root, ['add', '-A']);
  const output = runGit(root, ['commit', '-m', normalizedMessage]);
  return { output: output.trim() };
}

function pushGitBranch(rootPath: string) {
  const root = requireGitRoot(rootPath);
  const branch = runGit(root, ['branch', '--show-current']).trim();
  if (!branch) {
    throw new Error('Cannot push while HEAD is detached.');
  }
  const upstream = runGitMaybe(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const output = upstream.trim()
    ? runGit(root, ['push'])
    : runGit(root, ['push', '-u', 'origin', branch]);
  return { output: output.trim() || `Pushed ${branch}` };
}

function revertFileChanges(
  rootPath: string,
  files: Array<{ path: string; diff?: string; lines?: string[] }>,
) {
  const root = requireProjectDirectory(rootPath);
  const patch = buildReversePatchInput(root, files);
  if (!patch.trim()) {
    throw new Error('No patch content was provided.');
  }
  runGitWithInput(
    root,
    ['apply', '--no-index', '--reverse', '--check', '--whitespace=nowarn'],
    patch,
  );
  const output = runGitWithInput(
    root,
    ['apply', '--no-index', '--reverse', '--whitespace=nowarn'],
    patch,
  );
  return {
    revertedFiles: files.filter((file) => String(file.path ?? '').trim()).length,
    output: output.trim() || 'Reverted file changes.',
  };
}

function buildReversePatchInput(
  root: string,
  files: Array<{ path: string; diff?: string; lines?: string[] }>,
) {
  return files
    .map((file) => {
      const filePath = normalizePatchPath(root, String(file.path ?? ''));
      if (!filePath) {
        return '';
      }
      const diff = normalizePatchDiff(
        String(file.diff ?? '') ||
          (Array.isArray(file.lines) ? file.lines.join('\n') : ''),
      );
      if (!diff.trim()) {
        return '';
      }
      if (diff.includes('diff --git ') || (diff.includes('--- ') && diff.includes('+++ '))) {
        return `${diff.trimEnd()}\n`;
      }
      return [
        `diff --git a/${filePath} b/${filePath}`,
        `--- a/${filePath}`,
        `+++ b/${filePath}`,
        diff.trimEnd(),
        '',
      ].join('\n');
    })
    .filter(Boolean)
    .join('\n');
}

function normalizePatchPath(root: string, value: string) {
  let normalized = value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^"|"$/g, '')
    .replace(/^([ab])\//, '');
  if (path.isAbsolute(normalized)) {
    const relative = path.relative(root, normalized).replace(/\\/g, '/');
    normalized = relative;
  }
  if (
    !normalized ||
    normalized === '/dev/null' ||
    path.isAbsolute(normalized) ||
    normalized.split('/').some((part) => part === '..')
  ) {
    return '';
  }
  return normalized;
}

function normalizePatchDiff(value: string) {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd();
}

function requireGitRoot(rootPath: string) {
  const root = requireProjectDirectory(rootPath);
  runGit(root, ['rev-parse', '--is-inside-work-tree']);
  return root;
}

function requireProjectDirectory(rootPath: string) {
  const root = path.resolve(rootPath);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`Project directory does not exist: ${root}`);
  }
  return root;
}

function normalizeGitName(value: string, label: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} is empty.`);
  }
  if (trimmed.startsWith('-') || /[\r\n\0]/.test(trimmed)) {
    throw new Error(`Invalid ${label}: ${trimmed}`);
  }
  return trimmed;
}

function runGit(root: string, args: string[]) {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (caught) {
    throw new Error(commandErrorMessage(caught));
  }
}

function runGitWithInput(root: string, args: string[], input: string) {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      input,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (caught) {
    throw new Error(commandErrorMessage(caught));
  }
}

function runGitMaybe(root: string, args: string[]) {
  try {
    return runGit(root, args);
  } catch {
    return '';
  }
}

function commandErrorMessage(caught: unknown) {
  if (
    typeof caught === 'object' &&
    caught !== null &&
    'stderr' in caught &&
    typeof (caught as { stderr?: unknown }).stderr === 'string'
  ) {
    const stderr = (caught as { stderr: string }).stderr.trim();
    if (stderr) {
      return stderr;
    }
  }
  if (
    typeof caught === 'object' &&
    caught !== null &&
    'message' in caught &&
    typeof (caught as { message?: unknown }).message === 'string'
  ) {
    return (caught as { message: string }).message;
  }
  return String(caught);
}

function createTerminalSession(ownerId: number, cwd?: string, runtime?: TerminalRuntime) {
  const workingDirectory = resolveCwd(cwd);
  const shellInfo = terminalShell(runtime, workingDirectory);
  const child = spawn(shellInfo.command, shellInfo.args, {
    cwd: workingDirectory,
    windowsHide: true,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    },
  });
  const id = randomUUID();
  terminalSessions.set(id, {
    process: child,
    ownerId,
    cwd: workingDirectory,
  });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    sendTerminalData(ownerId, id, chunk);
  });
  child.stderr.on('data', (chunk) => {
    sendTerminalData(ownerId, id, chunk);
  });
  child.on('error', (error) => {
    sendTerminalData(ownerId, id, `${error.message}\r\n`);
  });
  child.on('close', (exitCode) => {
    terminalSessions.delete(id);
    sendToOwner(ownerId, 'terminal:exit', {
      id,
      exitCode,
    });
  });

  return {
    id,
    cwd: workingDirectory,
    shell: path.basename(shellInfo.command),
  };
}

function sendTerminalData(ownerId: number, id: string, data: string | Buffer) {
  sendToOwner(ownerId, 'terminal:data', {
    id,
    data: typeof data === 'string' ? data : data.toString('utf8'),
  });
}

function sendToOwner(ownerId: number, channel: string, payload: unknown) {
  const owner = BrowserWindow.getAllWindows().find(
    (window) => window.webContents.id === ownerId,
  );
  if (!owner || owner.webContents.isDestroyed()) {
    return;
  }
  owner.webContents.send(channel, payload);
}

function terminalShell(runtime?: TerminalRuntime, cwd?: string) {
  const normalizedRuntime = normalizeTerminalRuntime(runtime);
  const override = process.env.CARDBUSH_TERMINAL_SHELL?.trim();
  if (override && normalizedRuntime === 'powershell') {
    return { command: override, args: [] };
  }
  if (process.platform === 'win32') {
    if (normalizedRuntime === 'wsl') {
      return cwd?.trim()
        ? { command: 'wsl.exe', args: ['--cd', cwd] }
        : { command: 'wsl.exe', args: [] };
    }
    if (normalizedRuntime === 'git_bash' || normalizedRuntime === 'bash') {
      return {
        command: findGitBashExecutable() || 'bash.exe',
        args: ['--login', '-i'],
      };
    }
    const pwsh = findExecutable('pwsh.exe');
    if (pwsh) {
      return { command: pwsh, args: [] };
    }
    return { command: 'powershell.exe', args: ['-NoExit'] };
  }
  if (normalizedRuntime === 'powershell') {
    return { command: findExecutable('pwsh') || 'pwsh', args: ['-NoExit'] };
  }
  const shellCommand = process.env.SHELL?.trim() || 'bash';
  return { command: shellCommand, args: [] };
}

function normalizeTerminalRuntime(value?: TerminalRuntime): TerminalRuntime {
  if (value === 'wsl' || value === 'git_bash' || value === 'bash') {
    return value;
  }
  return 'powershell';
}

function findGitBashExecutable() {
  const candidates = [
    process.env.ProgramFiles
      ? path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe')
      : '',
    process.env['ProgramFiles(x86)']
      ? path.join(process.env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe')
      : '',
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe')
      : '',
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || '';
}

function findExecutable(command: string) {
  try {
    return execFileSync('where.exe', [command], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
  } catch {
    return '';
  }
}

function runTerminalCommand(command: string, cwd?: string, runtime?: TerminalRuntime) {
  const trimmed = command.trim();
  if (!trimmed) {
    return {
      command,
      cwd: resolveCwd(cwd),
      exitCode: 0,
      stdout: '',
      stderr: '',
    };
  }
  return new Promise<{
    command: string;
    cwd: string;
    exitCode: number | null;
    stdout: string;
    stderr: string;
  }>((resolve) => {
    const workingDirectory = resolveCwd(cwd);
    const normalizedRuntime = normalizeTerminalRuntime(runtime);
    const shellCommand = process.platform === 'win32'
      ? normalizedRuntime === 'wsl'
        ? 'wsl.exe'
        : normalizedRuntime === 'git_bash' || normalizedRuntime === 'bash'
          ? findGitBashExecutable() || 'bash.exe'
          : 'powershell.exe'
      : normalizedRuntime === 'powershell'
        ? findExecutable('pwsh') || 'pwsh'
        : process.env.SHELL?.trim() || 'bash';
    const args = process.platform === 'win32'
      ? normalizedRuntime === 'wsl'
        ? ['--cd', workingDirectory, '--', 'bash', '-lc', trimmed]
        : normalizedRuntime === 'git_bash' || normalizedRuntime === 'bash'
          ? ['-lc', trimmed]
          : ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', trimmed]
      : normalizedRuntime === 'powershell'
        ? ['-NoLogo', '-NoProfile', '-Command', trimmed]
        : ['-lc', trimmed];
    const child = spawn(shellCommand, args, {
      cwd: workingDirectory,
      windowsHide: true,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      stderr += error.message;
    });
    child.on('close', (exitCode) => {
      resolve({
        command: trimmed,
        cwd: workingDirectory,
        exitCode,
        stdout: trimTerminalOutput(stdout),
        stderr: trimTerminalOutput(stderr),
      });
    });
  });
}

function saveImageDataUrl(
  dataUrl: string,
  name?: string,
  options?: { copyToClipboard?: boolean },
) {
  const match = dataUrl.match(/^data:image\/(png|jpe?g|webp|gif|bmp);base64,(.+)$/i);
  if (!match) {
    throw new Error('Invalid image data URL');
  }
  const extension = imageExtension(match[1]);
  const imagesDir = path.join(app.getPath('pictures'), 'cardbush-images');
  fs.mkdirSync(imagesDir, { recursive: true });
  const fileName = `${sanitizeFilePart(name || 'cardbush-image')}-${timestampForFile()}.${extension}`;
  const filePath = path.join(imagesDir, fileName);
  fs.writeFileSync(filePath, Buffer.from(match[2], 'base64'));
  const image = nativeImage.createFromPath(filePath);
  const copiedToClipboard = options?.copyToClipboard === true && !image.isEmpty();
  if (copiedToClipboard) {
    clipboard.writeImage(image);
  }
  return {
    path: filePath,
    name: fileName,
    width: image.getSize().width,
    height: image.getSize().height,
    copiedToClipboard,
  };
}

async function copyLocalFileToClipboard(targetPath: string) {
  const normalizedPath = normalizeShellPath(targetPath);
  const stats = await fs.promises.stat(normalizedPath).catch(() => null);
  if (!normalizedPath || !stats?.isFile()) {
    throw new Error('Copy target must be an existing local file.');
  }
  if (process.platform === 'win32') {
    await copyWindowsFileToClipboard(normalizedPath);
    return { copied: true as const, kind: 'file' as const };
  }
  clipboard.writeText(normalizedPath);
  return { copied: true as const, kind: 'path' as const };
}

function copyWindowsFileToClipboard(targetPath: string) {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$items = New-Object System.Collections.Specialized.StringCollection',
    '[void]$items.Add([IO.Path]::GetFullPath($env:CARDBUSH_CLIPBOARD_TARGET))',
    '[Windows.Forms.Clipboard]::SetFileDropList($items)',
  ].join('; ');
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-STA',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        script,
      ],
      {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, CARDBUSH_CLIPBOARD_TARGET: targetPath },
      },
    );
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Copy file operation timed out.'));
    }, 5_000);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (exitCode) => {
      clearTimeout(timeout);
      if (exitCode === 0) resolve();
      else reject(new Error(stderr.trim() || `Copy file exited with code ${exitCode}.`));
    });
  });
}

async function readLocalImageDataUrl(targetPath: string) {
  const normalizedPath = normalizeShellPath(targetPath);
  const stats = await fs.promises.stat(normalizedPath);
  if (!stats.isFile()) {
    throw new Error('Image path is not a file');
  }
  if (stats.size > localImagePreviewMaxBytes) {
    throw new Error(`Image exceeds ${localImagePreviewMaxBytes} bytes`);
  }
  const bytes = await fs.promises.readFile(normalizedPath);
  const declaredType = imageMimeTypeForPath(normalizedPath);
  const contentType = declaredType || contentTypeForBytes(bytes.subarray(0, 512));
  if (!contentType.startsWith('image/')) {
    throw new Error('File is not a supported image');
  }
  return `data:${contentType};base64,${bytes.toString('base64')}`;
}

function imageExtension(value: string) {
  const normalized = value.toLowerCase();
  if (normalized === 'jpeg' || normalized === 'jpg') {
    return 'jpg';
  }
  if (normalized === 'webp' || normalized === 'gif' || normalized === 'bmp') {
    return normalized;
  }
  return 'png';
}

function sanitizeFilePart(value: string) {
  return value
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 48)
    .replace(/^-|-$/g, '') || 'image';
}

function timestampForFile() {
  return new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .replace('Z', '');
}

function resolveCwd(cwd?: string) {
  const candidate = cwd?.trim();
  if (candidate && fs.existsSync(candidate)) {
    return path.resolve(candidate);
  }
  return app.getPath('home');
}

function trimTerminalOutput(value: string) {
  const maxLength = 20000;
  if (value.length <= maxLength) {
    return value;
  }
  return value.slice(value.length - maxLength);
}
