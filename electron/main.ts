import { terminalInvocation, terminalRuntimes, defaultTerminalRuntime, bundledToolPath, platformFeatures, localPath, type TerminalRuntime } from '@cardbush/platform';
import { registerRuntimePluginUiIpc } from './runtimePluginUi';
import { readWorkspaceDirectory } from './workspaceFiles';
import { inspectLocalApplication, launchLocalApplication, localApplicationDialog, validateLocalApplication } from './localApplications';
import { pickWindowsApplication, readWindowsApplicationIcon, readWindowsApplicationIcons } from './windowsApplicationShortcuts';
import type { SandboxSetupHost } from './sandboxTypes';
import type { RuntimeHostIpcRegistration } from './runtimeHostController.mjs' with { 'resolution-mode': 'import' };
import type { SshConnectionInput } from '@cardbush/bush-protocol' with { 'resolution-mode': 'import' };
import { mainWindowFrameOptions, resolveWindowAppearance, WindowAppearanceController, type WindowAppearanceOptions, type WindowAppearanceState, type WindowMaterialPreference } from './windowAppearance';
import { GlobalInstructionsStore, readAgentInstructionDocuments } from './globalInstructions';
import { VisualThemeContextStore } from './visualThemeContext';
import { UsageLedger } from './usageLedger';
import { McpDesktopHost } from './mcpDesktopHost';
import {
  app,
  BrowserWindow,
  clipboard,
  crashReporter,
  Menu,
  net,
  Notification,
  protocol,
  Tray,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  screen,
  session,
  shell,
  safeStorage,
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
import { watchCapabilityCatalog } from './capabilityCatalogWatcher';
import { sendToLiveRenderer } from './rendererDelivery';
import { restoreEditorFocus } from './rendererFocus';
import { windowMenuContext, executeWindowMenuAction } from './windowMenu';
import { WindowScrollDiagnostics } from './windowScrollDiagnostics';
import { windowsShellIconPath } from './windowsAppIdentity';
import { buildFileContextMenu, type FileContextMenuOptions } from './fileContextMenu';
import { PluginMarketplaceService } from './pluginMarketplaces';
import { collectPluginAcquisitionCache, runAcquisitionCommand } from './pluginAcquisition';
import { closeHostProcesses, processOwnerSignal, runHostCommand, spawnHostProcess, setHostApplicationMemoryProvider } from './hostProcesses';
import { applicationMemoryBytes, installPreviewResourceProtection, relievePreviewForMemoryPressure } from './previewResourceProtection';
import { installInspectorWindowOpen } from './inspectorWindowOpen';
import { browserConfigurationPath, browserConfigurationStore } from './browserSettings';
import { collectPluginInstallCache, installLocalProductPlugin, localPluginInstallDialog } from './localPluginInstall';
import { clearBrowserCaches, clearDiagnosticFiles, mergeCleanup } from './cacheMaintenance';
import { appendRotatingLog } from './rotatingLog';
import { renameProjectDirectory } from './projectDirectories';
import { isOfficePreviewPath } from './officePreview';
import { checkOfficePreviewAdmission, officePreviewLimits } from './officePreviewAdmission';
import { localFileResponse } from './localFileStream';
import { localFileSystemPathFromProtocolUrl } from './localFileProtocol';
import { readFilePrefix } from './fileRead';
import { ImageGalleryScanner } from './imageGallery';
import { readTextPreviewResult, renderTextFilePreview } from './textPreview';
import { ModelPreviewError, ModelPreviewService } from './modelPreview';
import {
  listProductSkills,
  migrateLegacyProductSkills,
  readProductSkill,
  type ProductSkillRoot,
} from './productSkills';
import {
  loadEnabledProductPluginSkillRootEntries,
  loadEnabledProductPluginExtensions,
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
let modelPreviewService: ModelPreviewService | undefined;
const cardbushProductionAppUserModelId = 'com.cardbush.desktop';
const cardbushDevelopmentRuntime =
  process.env.CARDBUSH_DEVELOPMENT_RUNTIME?.trim() === '1';
const cardbushRuntimeIsPackaged = app.isPackaged && !cardbushDevelopmentRuntime;
// Resolve the same immutable native asset for commands launched by the main process.
process.env.CARDBUSH_PROCESS_HOST_DIRECTORY = cardbushRuntimeIsPackaged
  ? path.join(process.resourcesPath, 'process-guard')
  : path.join(app.getAppPath(), 'dist-native', 'process-guard');
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
  { scheme: 'cardbush-agent', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
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
  dispose: () => void;
  command: (message: unknown) => Promise<RuntimeIpcOutboundMessage>;
  startStream: (message: unknown) => Promise<void>;
  stopStream: (message: unknown) => Promise<void>;
  cancelOperation: (message: unknown) => Promise<void>;
  onStreamFrame: (listener: (message: RuntimeIpcOutboundMessage) => void) => () => void;
};

let runtimeHostController: RuntimeHostController | null = null;
let sandboxSetup: SandboxSetupHost | undefined;
let runtimeHostIpc: RuntimeHostIpcRegistration | null = null;
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
  refreshMcp: () => Promise<unknown>;
  listMcpServers: () => Promise<unknown>;
  reconnectMcpServer: (id: string, signal?: AbortSignal) => Promise<unknown>;
  configureMcpServer: (input: import('./productMcpManagement.mjs', { with: { 'resolution-mode': 'import' } }).McpServerPatch, signal?: AbortSignal) => Promise<unknown>;
  removeMcpServer: (id: string, signal?: AbortSignal) => Promise<unknown>;
  listPluginConnections: (pluginId?: string) => Promise<unknown>;
  pluginTroubleshootingContext: (pluginId: string, componentId: string) => Promise<unknown>;
  configurePluginConnection: (input: unknown, signal?: AbortSignal) => Promise<unknown>;
  savePluginConnections: (input: unknown) => Promise<unknown>;
  uninstallPlugin: (pluginId: string) => Promise<unknown>;
  replacePlugin: import('./productPlugins').ProductPluginReplacement;
  requestPluginCredentials: (input: unknown, signal: AbortSignal) => Promise<unknown>;
  resolveAutomationModel: (modelId: string) => Promise<Record<string, unknown>>;
  subagentModels: () => Promise<Array<{ id: string; model: string; maxContextTokens?: number; maxOutputTokens?: number }>>;
  resolveSubagentModel: (modelId: string) => Promise<Record<string, unknown>>;
} | null = null;
let productMcpManagement: { url: string; token: string; close: () => Promise<void> } | null = null;
let disposeCapabilityCatalogWatcher: (() => void) | undefined;
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
let runtimeServicesAbort: AbortController | null = null;
let runtimeServicesStopping = false;
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
    stop: () => void;
    ownerId: number;
    cwd: string;
  }
>();



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
  miniChat?: {
    title?: string;
    lastUser?: string;
    lastAssistant?: string;
  };
};

type AppThemeMode = CardlingDesktopState['theme'];

const mainWindowThemeBackgrounds: Record<AppThemeMode, string> = {
  // Six-digit opaque backing colors are also used when native material is
  // unavailable, disabled, or the active theme owns its complete background.
  dark: '#1a1a1a',
  bright: '#f5f3ef',
  cyberpunk: '#050607',
};

let lastMainWindowTheme: AppThemeMode = 'dark';
let lastMainWindowMaterialPreference: WindowMaterialPreference = 'auto';
let lastMainWindowCustomTheme = false;
let lastMainWindowCaptionColor: string | undefined;
const windowAppearanceControllers = new WeakMap<BrowserWindow, WindowAppearanceController>();
const windowAppearanceStates = new WeakMap<BrowserWindow, WindowAppearanceState>();
const windowScrollDiagnostics = new WeakMap<BrowserWindow, WindowScrollDiagnostics>();
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
  appendRotatingLog(filePath, entry);
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
  const expectedBackground = windowAppearanceStates.get(target)?.material === 'mica'
    ? '#00000000' : backgroundForMainWindowTheme(lastMainWindowTheme);
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
    minWidth: 480,
    minHeight: 480,
    ...mainWindowFrameOptions(process.platform),
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
  windowScrollDiagnostics.set(window, new WindowScrollDiagnostics(window, appLogsDir()));
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
  nativeTheme.on('updated', refreshWindowBackdrop);
  app.on('gpu-info-update', refreshWindowBackdrop);
  window.once('closed', () => {
    nativeTheme.removeListener('updated', refreshWindowBackdrop);
    app.removeListener('gpu-info-update', refreshWindowBackdrop);
  });
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
  const theme = input.theme === 'bright' ||
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
    if (!sendToLiveRenderer(shadowWindow, 'shadow:close-request')) {
      state.allowClose = true;
      shadowWindow.close();
      return;
    }
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
  let controller = windowAppearanceControllers.get(target);
  if (!controller) {
    controller = new WindowAppearanceController(target, process.platform, (error) => {
      appendDebugLog('window-composition', { stage: 'material-fallback', error: String(error) });
    });
    windowAppearanceControllers.set(target, controller);
  }
  const state = controller.apply(resolveWindowAppearance({
    theme,
    preference: lastMainWindowMaterialPreference,
    customTheme: lastMainWindowCustomTheme,
    platform: process.platform,
    release: os.release(),
    reducedTransparency: nativeTheme.prefersReducedTransparency,
    highContrast: nativeTheme.shouldUseHighContrastColors || nativeTheme.inForcedColorsMode,
    gpuCompositing: app.getGPUFeatureStatus().gpu_compositing,
  }), background, lastMainWindowCaptionColor);
  const previous = windowAppearanceStates.get(target);
  windowAppearanceStates.set(target, state);
  if (JSON.stringify(previous) !== JSON.stringify(state)) {
    sendToLiveRenderer(target, 'appearance:window-changed', state);
  }
  if (windowCompositionDebugEnabled) {
    const actualBackground = target.getBackgroundColor();
    appendDebugLog('window-composition', {
      stage: 'background-applied',
      theme,
      material: state.material,
      requestedBackground: state.material === 'mica' ? '#00000000' : background,
      actualBackground,
      // For a normal HWND Electron's getter may omit alpha. It cannot verify
      // the native Mica surface; only compare opaque backing colors here.
      matches: state.material === 'none'
        ? actualBackground.toLowerCase() === background.toLowerCase() : undefined,
    });
  }
  return state;
}

function backgroundForMainWindowTheme(theme: AppThemeMode) {
  return mainWindowThemeBackgrounds[theme] ?? mainWindowThemeBackgrounds.dark;
}

function installMainWindowNavigationGuard(target: BrowserWindow) {
  installPreviewResourceProtection(target.webContents);
  installInspectorWindowOpen(target.webContents);
  installSandboxFrameNavigationGuard(target.webContents);
  target.webContents.setWindowOpenHandler(({ url }) => {
    if (sendUiPreviewToInspector(target, url)) {
      return { action: 'deny' };
    }
    void openUiPreview(url);
    return { action: 'deny' };
  });
  target.webContents.on('will-navigate', (event, targetUrl) => {
    event.preventDefault();
    if (isAllowedAppNavigation(targetUrl)) {
      appendDebugLog('renderer-lifecycle', { stage: 'app-navigation-blocked', targetUrl });
      void showWindowError(target, '无法打开链接', '链接指向了应用页面，已阻止离开当前界面。');
      return;
    }
    if (sendUiPreviewToInspector(target, targetUrl)) {
      return;
    }
    const parsed = safeUrl(targetUrl);
    if (parsed != null && isWebProtocol(parsed)) {
      void openUiPreview(targetUrl);
      return;
    }
    void openTargetExternally(targetUrl);
  });
}

const windowErrorDialogs = new WeakMap<BrowserWindow, Promise<void>>();

function showWindowError(target: BrowserWindow, title: string, message: string) {
  if (isQuitting || target.isDestroyed()) return Promise.resolve();
  const active = windowErrorDialogs.get(target);
  if (active) return active;
  const pending = dialog.showMessageBox(target, {
    type: 'error', title, message,
    buttons: ['关闭提示'], defaultId: 0, cancelId: 0, noLink: true,
  }).then(() => undefined).catch((error: unknown) => {
    appendDebugLog('renderer-lifecycle', { stage: 'error-dialog-failed', error: String(error) });
  }).finally(() => { windowErrorDialogs.delete(target); });
  windowErrorDialogs.set(target, pending);
  return pending;
}

function installMainRendererResilience(target: BrowserWindow) {
  let rendererPid = 0;
  target.webContents.on('dom-ready', () => { rendererPid = target.webContents.getOSProcessId(); });

  target.webContents.on('before-input-event', (event, input) => {
    const key = input.key.toLowerCase();
    const reloadShortcut = key === 'f5' || ((input.control || input.meta) && key === 'r');
    if (!reloadShortcut) return;
    event.preventDefault();
    // Keep the app protected from reload, but let the menu route Ctrl+R to
    // the active preview and honor the user's configured shortcut binding.
    if (key === 'r' && input.type === 'keyDown' && !input.isAutoRepeat) {
      sendToLiveRenderer(target, 'window:menu-keydown', {
        key: input.key, code: input.code, ctrlKey: input.control, metaKey: input.meta,
        altKey: input.alt, shiftKey: input.shift,
      });
    }
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
      exitCodeHex: `0x${(details.exitCode >>> 0).toString(16).padStart(8, '0')}`,
      rendererPid,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      crashDumps: app.getPath('crashDumps'),
    });
    if (isQuitting || target.isDestroyed() || details.reason === 'clean-exit') return;

    void showWindowError(target, 'CardBush 界面异常',
      `界面进程已退出（${details.reason}，退出码 ${details.exitCode}）。\n应用未自动重新加载。请关闭窗口后手动重新打开。`);
  });

  target.on('unresponsive', () => {
    appendDebugLog('renderer-lifecycle', { stage: 'unresponsive' });
    void showWindowError(target, 'CardBush 暂时未响应', '当前界面未响应。可以关闭此提示继续等待，应用不会自动重新加载。');
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
      void showWindowError(target, '无法加载应用界面', `${errorDescription}（${errorCode}）\n${validatedURL}`);
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
  return sendToLiveRenderer(target, 'shell:open-inspector', {
    target: inspectorTarget,
    title: previewTarget.localPath
      ? path.basename(previewTarget.localPath)
      : parsed?.hostname || inspectorTarget,
  });
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
    ['office-preview', 'text-preview', 'model-preview'].includes(parsed.hostname.toLowerCase())
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

async function openFileWithChooser(targetPath: string) {
  if (process.platform !== 'win32') {
    const error = await shell.openPath(targetPath);
    if (error) throw new Error(error);
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
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
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
    sendToLiveRenderer(cardlingWindow, 'cardling:collapse');
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
  sendToLiveRenderer(cardlingWindow, 'cardling:state', lastCardlingState);
}

function sanitizeCardlingState(payload: CardlingDesktopState): CardlingDesktopState {
  return {
    enabled: payload.enabled !== false,
    language: payload.language === 'en' ? 'en' : 'zh',
    theme:
      payload.theme === 'bright' ||
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
  const iconPath = windowsShellIconPath({ packaged: cardbushRuntimeIsPackaged,
    executablePath: process.execPath, candidates: cardbushIconAssetPaths('cardbush.ico') });
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
  const iconPath = windowsShellIconPath({ packaged: cardbushRuntimeIsPackaged,
    executablePath: process.execPath, candidates: cardbushIconAssetPaths('cardbush.ico') });
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
      cwd: cardbushRuntimeIsPackaged ? path.dirname(process.execPath) : app.getAppPath(),
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
  sendToLiveRenderer(mainWindow, 'attention:open-session');
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

ipcMain.handle('window:menu-context', (event) => windowMenuContext(event, mainWindow));
ipcMain.handle('window:menu-action', (event, action: unknown, editTargetId: unknown) =>
  executeWindowMenuAction(event, mainWindow, action, editTargetId, requestAppQuit));

ipcMain.handle('window:restore-editor-focus', async (event, state: import('./rendererFocus').EditorFocusRequest) => {
  const target = mainWindow?.webContents === event.sender
    ? mainWindow : shadowWindows.get(event.sender.id)?.window ?? null;
  const wasFocused = !event.sender.isDestroyed() && event.sender.isFocused();
  const restored = await restoreEditorFocus(event, target, state);
  if (!wasFocused || state?.documentFocused === false || !restored) {
    appendDebugLog('input-focus', {
      stage: 'editor-focus-request', windowId: target?.id, passive: state?.passive === true,
      documentFocused: state?.documentFocused === true, wasFocused, restored,
      windowFocused: target && !target.isDestroyed() ? target.isFocused() : false,
      focusedContentsId: electronWebContents.getFocusedWebContents()?.id,
    });
  }
  return restored;
});

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
  if (scope === 'window-scroll') return windowScrollDiagnostics.get(mainWindow)?.append(payload);
  return appendDebugLog(scope, payload);
});

ipcMain.handle('debug:window-scroll-config', (event) => {
  if (mainWindow == null || event.sender.id !== mainWindow.webContents.id) return undefined;
  return windowScrollDiagnostics.get(mainWindow)?.config;
});

let globalInstructionsStore: GlobalInstructionsStore | undefined;
function getGlobalInstructionsStore() {
  return globalInstructionsStore ??= new GlobalInstructionsStore(path.join(app.getPath('userData'), 'AGENTS.md'));
}
ipcMain.handle('instructions:read-global', (event) => {
  assertRuntimeRendererSender(event.sender.id);
  return getGlobalInstructionsStore().read();
});

let usageLedger: UsageLedger | undefined;
app.on('will-quit', () => { usageLedger?.close(); usageLedger = undefined; });
ipcMain.handle('usage:statistics', event => {
  assertMainWindowSender(event.sender.id);
  usageLedger ??= new UsageLedger(path.join(app.getPath('userData'), 'usage', 'ledger.sqlite'));
  return usageLedger.snapshot();
});
ipcMain.handle('instructions:read-applicable', (event, projectDir?: string, workspaceDir?: string) => {
  assertRuntimeRendererSender(event.sender.id);
  if (projectDir?.startsWith('ssh://') || workspaceDir?.startsWith('ssh://')) return readAgentInstructionDocuments(getGlobalInstructionsStore());
  return readAgentInstructionDocuments(getGlobalInstructionsStore(), projectDir, workspaceDir);
});
ipcMain.handle('instructions:save-global', (event, content: string, revision: string) => {
  assertMainWindowSender(event.sender.id);
  return getGlobalInstructionsStore().save(content, revision);
});

ipcMain.handle('app:runtime-startup-status', (event) => {
  assertMainWindowSender(event.sender.id);
  return { ...runtimeStartupStatus };
});

ipcMain.handle('app:show-error', (event, error: { title?: unknown; message?: unknown }) => {
  assertMainWindowSender(event.sender.id);
  const target = BrowserWindow.fromWebContents(event.sender);
  if (!target || target.isDestroyed()) return;
  const title = typeof error?.title === 'string' ? error.title.slice(0, 200) : 'CardBush';
  const message = typeof error?.message === 'string' ? error.message.slice(0, 8000) : '发生了未知错误。';
  appendDebugLog('renderer-lifecycle', { stage: 'error-dialog', title, message });
  return showWindowError(target, title, message);
});

ipcMain.handle('app:retry-runtime', async (event) => {
  assertMainWindowSender(event.sender.id);
  await (runtimeServicesInitialization ?? startRuntimeServices(true));
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

let visualThemeContextStore: VisualThemeContextStore | undefined;
function visualThemeContextPath() { return path.join(app.getPath('userData'), 'appearance', 'current-theme.json'); }
ipcMain.handle('appearance:publish-visual-theme', (event, context) => {
  assertMainWindowSender(event.sender.id);
  visualThemeContextStore ??= new VisualThemeContextStore(visualThemeContextPath());
  return visualThemeContextStore.write(context);
});

ipcMain.handle('appearance:set-window-theme', (event, theme: AppThemeMode, options?: WindowAppearanceOptions) => {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender);
  if (sourceWindow !== mainWindow || sourceWindow == null || sourceWindow.isDestroyed()) {
    return;
  }
  const normalizedTheme: AppThemeMode =
    theme === 'bright' || theme === 'dark' ||
      theme === 'cyberpunk'
      ? theme
      : 'dark';
  lastMainWindowMaterialPreference = options?.material === 'solid' ? 'solid' : 'auto';
  lastMainWindowCustomTheme = options?.customTheme === true;
  lastMainWindowCaptionColor = typeof options?.captionColor === 'string' ? options.captionColor : undefined;
  lastMainWindowTheme = normalizedTheme;
  const source = options?.themeSource === 'dark' || options?.themeSource === 'light'
    ? options.themeSource : 'system';
  if (nativeTheme.themeSource !== source) nativeTheme.themeSource = source;
  const state = applyMainWindowVisualMaterial(sourceWindow, normalizedTheme);
  traceMainWindowComposition(sourceWindow, 'theme-change', [0, 80]);
  return state;
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
  if (runtimeServicesStopping) throw new Error('CardBush Runtime is shutting down.');
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

async function ensureRuntimeHostReady(): Promise<RuntimeHostController> {
  await ensureRuntimeServicesReady();
  if (!runtimeHostController) throw new Error('CardBush Runtime is unavailable.');
  return runtimeHostController;
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
    // Async MCP scheduling replaces only connections whose effective route changed.
    await productHostController?.refreshMcp();
  },
);

ipcMain.handle('models:list', async (_, baseUrl: string, apiKey: string) => {
  const endpoint = modelListEndpoint(baseUrl);
  const token = String(apiKey ?? '').trim();
  if (!token) {
    throw new Error('Missing API key');
  }
  const response = await session.fromPartition('cardbush-model-network').fetch(endpoint, {
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

ipcMain.handle('app-center:pick-local', async (event, language: string) => {
  assertMainWindowSender(event.sender.id);
  if (process.platform === 'win32') {
    const owner = mainWindow, abort = new AbortController();
    const close = () => abort.abort();
    owner?.once('closed', close);
    try {
      const selected = await pickWindowsApplication(language, owner?.getNativeWindowHandle(), abort.signal);
      return selected ? await inspectLocalApplication(selected.path, readWindowsApplicationIcon) : null;
    } finally { owner?.removeListener('closed', close); }
  }
  const options = { ...localApplicationDialog(language), defaultPath: app.getPath('desktop') };
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths[0]) return null;
  return inspectLocalApplication(result.filePaths[0], async target => {
    const icon = await app.getFileIcon(target, { size: 'normal' });
    return icon.isEmpty() ? '' : icon.toDataURL();
  });
});

ipcMain.handle('app-center:refresh-local-icons', async (event, paths: unknown) => {
  assertMainWindowSender(event.sender.id);
  if (!Array.isArray(paths) || paths.length > 100) throw Error('Invalid local apps');
  const valid = (await Promise.all(paths.map(async target => {
    try { await validateLocalApplication(target); return target as string; } catch { return null; }
  }))).filter((target): target is string => target !== null);
  if (process.platform === 'win32') return readWindowsApplicationIcons(valid);
  return Object.fromEntries(await Promise.all(valid.map(async target => [target,
    await app.getFileIcon(target, { size: 'normal' }).then(icon => icon.toDataURL()).catch(() => ''),
  ])));
});

ipcMain.handle('app-center:open-local', async (event, target: unknown) => {
  assertMainWindowSender(event.sender.id);
  await launchLocalApplication(target, async applicationPath => {
    if (process.platform !== 'linux') return shell.openPath(applicationPath);
    await new Promise<void>((resolve, reject) => {
      const desktopEntry = path.extname(applicationPath).toLowerCase() === '.desktop';
      const child = spawn(desktopEntry ? 'gio' : applicationPath, desktopEntry ? ['launch', applicationPath] : [], {
        cwd: path.dirname(applicationPath), detached: true, stdio: 'ignore', shell: false,
      });
      child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
    });
    return '';
  });
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
      ...(stats.isFile() ? { size: stats.size, mtimeMs: stats.mtimeMs } : {}),
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

ipcMain.handle('files:read-workspace-directory', async (event, input: Parameters<typeof readWorkspaceDirectory>[0]) => {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender);
  if (sourceWindow !== mainWindow && !shadowWindows.has(event.sender.id)) throw new Error('Unknown workspace window.');
  if (input.rootPath.startsWith('ssh://')) {
    const manager = await sshConnections();
    const permitted = await manager.authorize(input.rootPath, input.directoryPath || input.rootPath);
    if (!permitted.inside) throw Error('Directory is outside the remote workspace.');
    const result = await manager.directory(permitted.path);
    const offset = Math.max(0, Math.floor(input.offset || 0));
    return { entries: result.entries.slice(offset, offset + 200), ...(offset + 200 < result.entries.length ? { nextOffset: offset + 200 } : {}) };
  }
  return readWorkspaceDirectory(input);
});

let sshConnectionsPromise: Promise<import('./sshConnections.mjs', { with: { 'resolution-mode': 'import' } }).SshConnectionManager> | undefined;
let agentConnectionsPromise: Promise<import('./agentConnections.mjs', { with: { 'resolution-mode': 'import' } }).AgentConnectionManager> | undefined;
let agentFilePreviewsPromise: Promise<import('./agentFilePreview.mjs', { with: { 'resolution-mode': 'import' } }).AgentFilePreviews> | undefined;
function agentFilePreviews() {
  return agentFilePreviewsPromise ??= import('./agentFilePreview.mjs').then(({ AgentFilePreviews }) => new AgentFilePreviews(
    async (id, input) => (await agentConnections()).call(id, 'files.read', input), contentTypeForPath));
}
const agentPreviewOwners = new Set<number>();
function agentConnections() {
  return agentConnectionsPromise ??= import('./agentConnections.mjs').then(async ({ AgentConnectionManager }) => {
    const manager = new AgentConnectionManager(path.join(app.getPath('userData'), 'agents', 'connections.json'), {
    encrypt: value => {
      if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text')) throw new Error('Secure credential storage is unavailable.');
      return safeStorage.encryptString(value).toString('base64');
    },
    decrypt: value => safeStorage.decryptString(Buffer.from(value, 'base64')),
    }, { ssh: await sshConnections() });
    await manager.restore();
    return manager;
  });
}
ipcMain.handle('agents:command', async (event, action: string, input: unknown) => {
  assertMainWindowSender(event.sender.id);
  const manager = await agentConnections();
  switch (action) {
    case 'file-preview': {
      const request = input as { id: string; sessionId: string; path: string };
      const owner = event.sender.id;
      if (!agentPreviewOwners.has(owner)) {
        agentPreviewOwners.add(owner);
        const release = () => { void agentFilePreviews().then(previews => previews.releaseOwner(owner)); };
        event.sender.on('render-process-gone', release);
        event.sender.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) release(); });
        event.sender.once('destroyed', () => { agentPreviewOwners.delete(owner); release(); });
      }
      return (await agentFilePreviews()).create(owner, request.id, request.sessionId, request.path);
    }
    case 'release-file-preview': return (await agentFilePreviews()).release(event.sender.id, String(input));
    case 'list': return manager.list();
    case 'save': return manager.save(input as Parameters<typeof manager.save>[0]);
    case 'remove': return manager.remove(String(input));
    case 'connect': return manager.connect(String(input));
    case 'disconnect': return manager.disconnect(String(input));
    case 'call': {
      const request = input as { id: string; operation: Parameters<typeof manager.call>[1]; input?: Record<string, unknown> };
      return manager.call(request.id, request.operation, request.input);
    }
    default: throw new Error('Unknown Agent connection operation.');
  }
});
const agentEventReaders = new Map<string, AbortController>();
ipcMain.on('agents:events:start', (event, input: { subscriptionId: string; id: string; request: import('./agentTypes.js').AgentEventRequest }) => {
  assertMainWindowSender(event.sender.id);
  if (!input || typeof input.subscriptionId !== 'string' || input.subscriptionId.length > 100) return;
  const key = `${event.sender.id}:${input.subscriptionId}`;
  agentEventReaders.get(key)?.abort();
  const send = (frame: import('./agentTypes.js').AgentEventFrame) => { if (!event.sender.isDestroyed()) event.sender.send('agents:events:frame', input.subscriptionId, frame); };
  if (agentEventReaders.size >= 32) { send({ type: 'error', error: 'Too many Agent event readers.' }); return; }
  const abort = new AbortController(); agentEventReaders.set(key, abort);
  const closed = () => abort.abort(); event.sender.once('destroyed', closed);
  void (async () => {
    try {
      const manager = await agentConnections();
      abort.signal.throwIfAborted();
      for await (const frame of manager.events(input.id, input.request, abort.signal)) {
        if (abort.signal.aborted) break;
        send(frame);
      }
    } catch (error) {
      if (!abort.signal.aborted) send({ type: 'error', error: error instanceof Error ? error.message : String(error) });
    } finally {
      abort.abort(); event.sender.removeListener('destroyed', closed);
      if (agentEventReaders.get(key) === abort) agentEventReaders.delete(key);
    }
  })();
});
ipcMain.on('agents:events:stop', (event, subscriptionId: string) => {
  assertMainWindowSender(event.sender.id);
  agentEventReaders.get(`${event.sender.id}:${subscriptionId}`)?.abort();
});
function sshConnections() {
  return sshConnectionsPromise ??= import('./sshConnections.mjs').then(({ SshConnectionManager }) => new SshConnectionManager(path.join(app.getPath('userData'), 'ssh', 'connections.json'), {
    encrypt: value => { if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text')) throw Error('系统安全凭据存储不可用，请使用 SSH Agent 或无口令密钥。'); return safeStorage.encryptString(value).toString('base64'); },
    decrypt: value => safeStorage.decryptString(Buffer.from(value, 'base64')),
  }));
}
ipcMain.handle('ssh:connections', async (event, action: string, input: any) => {
  assertMainWindowSender(event.sender.id); const manager = await sshConnections();
  switch (action) {
    case 'list': return manager.list();
    case 'save': return manager.save(input as SshConnectionInput);
    case 'remove': return manager.remove(String(input));
    case 'test': return manager.test(String(input));
    case 'directory': return manager.directory(String(input));
    case 'disconnect': return manager.disconnect(String(input));
    case 'pick-key': return (await dialog.showOpenDialog(mainWindow!, { title: 'SSH 私钥', properties: ['openFile'] })).filePaths[0] ?? null;
    default: throw Error('Unknown SSH management action.');
  }
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
  const shortcutIcon = await readWindowsApplicationIcon(normalizedPath).catch(() => '');
  const iconImage = shortcutIcon ? nativeImage.createFromDataURL(shortcutIcon) : await app
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

ipcMain.handle('plugins:commands', async event => {
  assertMainWindowSender(event.sender.id);
  const { commands, skills } = await loadEnabledProductPluginExtensions(productPluginRoots(), productAppsConfigPath());
  return [...commands, ...skills].filter(command => command.userInvocable).map(command => ({ id: command.id, pluginId: command.pluginId, name: command.name, path: command.path, description: command.description, argumentHint: command.argumentHint, kind: command.kind ?? 'command' }));
});
ipcMain.handle('plugins:install-local', async (event, kind: unknown = 'directory') => {
  assertMainWindowSender(event.sender.id);
  const options = localPluginInstallDialog(kind);
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  const sourcePath = result.canceled ? '' : result.filePaths[0] ?? '';
  if (!sourcePath) return null;
  return installLocalProductPlugin(sourcePath, path.join(app.getPath('userData'), 'plugins'), replaceInstalledProductPlugin);
});
ipcMain.handle('plugins:uninstall', async (event, pluginId: unknown) => {
  assertMainWindowSender(event.sender.id);
  if (typeof pluginId !== 'string' || !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(pluginId)) throw new Error('Invalid plugin id.');
  return (await ensureRuntimeServicesReady()).uninstallPlugin(pluginId);
});

let pluginMarketplaceService: PluginMarketplaceService | undefined;
const replaceInstalledProductPlugin: import('./productPlugins').ProductPluginReplacement = async (id, replace) =>
  (await ensureRuntimeServicesReady()).replacePlugin(id, replace);
let pluginNetworkPromise: Promise<import('./pluginNetwork.mjs', { with: { 'resolution-mode': 'import' } }).PluginNetwork> | undefined;
function pluginNetworking() {
  return pluginNetworkPromise ??= import('./pluginNetwork.mjs').then(({ PluginNetwork }) =>
    new PluginNetwork(productAppsConfigPath(), partition => session.fromPartition(partition)));
}
let pluginUiNetworkPromise: Promise<import('./pluginUiNetwork.mjs', { with: { 'resolution-mode': 'import' } }).PluginUiNetwork> | undefined;
function refreshPluginUiNetwork() {
  pluginUiNetworkPromise ??= Promise.all([pluginNetworking(), import('./pluginUiNetwork.mjs')])
    .then(([network, { PluginUiNetwork }]) => new PluginUiNetwork(network, session.defaultSession, app));
  return pluginUiNetworkPromise.then(network => network.refresh());
}
ipcMain.handle('plugins:prepare-ui-network', async event => {
  assertMainWindowSender(event.sender.id);
  await refreshPluginUiNetwork();
});
const pluginFetch: typeof fetch = async (input, init) => (await pluginNetworking()).fetch(input, init);
let mcpDesktopHost: McpDesktopHost | undefined;
let openAiAccountPromise: Promise<import('./openAiAccount.mjs', { with: { 'resolution-mode': 'import' } }).OpenAiAccount> | undefined;
function notifyAccountsChanged() {
  const contents = mainWindow?.webContents;
  try { if (contents && !contents.isDestroyed() && !contents.mainFrame.isDestroyed()) { contents.send('openai:account-changed'); contents.send('accounts:changed'); } } catch { /* Restored views read the current state. */ }
}
function openAiDesktop() {
  return openAiAccountPromise ??= import('./openAiAccount.mjs').then(({ OpenAiAccount, OPENAI_ACCOUNT_CREDENTIAL_KEY }) => new OpenAiAccount({
    read: () => mcpDesktop().handle('credentials.read', { key: OPENAI_ACCOUNT_CREDENTIAL_KEY }, new AbortController().signal),
    write: value => mcpDesktop().handle('credentials.write', { key: OPENAI_ACCOUNT_CREDENTIAL_KEY, value }, new AbortController().signal),
    fetch: pluginFetch,
    openUrl: url => shell.openExternal(url),
    changed: notifyAccountsChanged,
  }));
}
async function refreshOpenAiRuntime() {
  if (!runtimeHostController) return;
  const response = await runtimeHostController.command({ protocol: bushRuntimeIpcProtocol, type: 'command', operationId: randomUUID(),
    command: { kind: 'runtime.openai_account_changed', payload: {} } }) as { ok?: boolean; error?: { message?: string } };
  if (!response.ok) throw new Error(response.error?.message ?? 'OpenAI runtime refresh failed.');
}
ipcMain.handle('openai:account-status', async event => { assertMainWindowSender(event.sender.id); return (await openAiDesktop()).status(); });
ipcMain.handle('openai:account-action', async (event, action: string) => {
  assertMainWindowSender(event.sender.id);
  return performOpenAiAccountAction(action);
});
async function performOpenAiAccountAction(action: string) {
  if (!['login', 'logout', 'cancel_login', 'reconnect', 'manage_apps'].includes(action)) throw new Error('Invalid OpenAI account action.');
  const account = await openAiDesktop();
  if (action === 'manage_apps') { await shell.openExternal('https://chatgpt.com/apps'); return account.status(); }
    try {
      if (action === 'cancel_login') account.cancelLogin();
      if (action === 'login') await account.login();
      if (action === 'logout') await account.logout();
    } catch (error) {
      // Login cancellation and failed persistence still invalidate the old account generation.
      await refreshOpenAiRuntime().catch(() => {});
      notifyAccountsChanged();
      throw error;
    }
  await refreshOpenAiRuntime();
  notifyAccountsChanged();
  return account.status();
}
let accountManagerPromise: Promise<import('./accountManager.mjs', { with: { 'resolution-mode': 'import' } }).AccountManager> | undefined;
function accountsDesktop() {
  return accountManagerPromise ??= import('./accountManager.mjs').then(({ AccountManager, openAiAccountSummary }) => new AccountManager([{ providerId: 'openai',
    list: async () => [openAiAccountSummary(await (await openAiDesktop()).status())],
    action: async (_accountId, action) => { await performOpenAiAccountAction(action); },
  }]));
}
ipcMain.handle('accounts:snapshot', async event => { assertMainWindowSender(event.sender.id); return (await accountsDesktop()).snapshot(); });
ipcMain.handle('accounts:action', async (event, input: unknown) => { assertMainWindowSender(event.sender.id); return (await accountsDesktop()).action(input); });
function mcpDesktop() {
  return mcpDesktopHost ??= new McpDesktopHost({
    path: path.join(app.getPath('userData'), 'mcp-oauth.bin'),
    encrypt: value => { if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text')) throw new Error('Secure credential storage is unavailable.'); return safeStorage.encryptString(value); },
    decrypt: value => safeStorage.decryptString(value),
    openUrl: url => shell.openExternal(url),
    changed: () => {
      const contents = mainWindow?.webContents;
      try { if (contents && !contents.isDestroyed() && !contents.mainFrame.isDestroyed()) contents.send('mcp:requests-changed'); }
      catch { /* A closed renderer restores pending requests on next mount. */ }
    },
  });
}
ipcMain.handle('mcp:requests', event => { assertMainWindowSender(event.sender.id); return mcpDesktop().requests(); });
ipcMain.handle('mcp:answer', (event, id: string, answer: unknown) => { assertMainWindowSender(event.sender.id); return mcpDesktop().answer(String(id), answer); });
ipcMain.handle('mcp:open-request-url', (event, id: string) => { assertMainWindowSender(event.sender.id); return mcpDesktop().openRequestUrl(String(id)); });
ipcMain.handle('plugins:troubleshooting-context', async (event, pluginId: string, componentId: string) => {
  assertMainWindowSender(event.sender.id);
  const controller = await ensureRuntimeServicesReady();
  return controller.pluginTroubleshootingContext(String(pluginId), String(componentId));
});
ipcMain.handle('plugins:save-connections', async (event, input: unknown) => {
  assertMainWindowSender(event.sender.id);
  const controller = await ensureRuntimeServicesReady();
  // Private renderer IPC: credential values never enter a Runtime command or tool journal.
  return controller.savePluginConnections(input);
});
ipcMain.handle('mcp:connection-action', async (event, serverId: string, action: string) => {
  assertMainWindowSender(event.sender.id);
  if (!['login', 'logout', 'cancel_login', 'reconnect'].includes(action)) throw new Error('Invalid MCP connection action.');
  const controller = await ensureRuntimeHostReady();
  const response = await controller.command({ protocol: bushRuntimeIpcProtocol, type: 'command', operationId: randomUUID(),
    command: { kind: `runtime.mcp_${action}`, payload: { serverId: String(serverId) } } }) as { ok?: boolean; result?: unknown; error?: { message: string } };
  if (!response.ok) throw new Error(response.error?.message ?? 'MCP connection action failed.');
  return response.result;
});
ipcMain.handle('automation:command', async (event, input: unknown) => {
  assertMainWindowSender(event.sender.id);
  const controller = await ensureRuntimeHostReady();
  const response = await controller.command({ protocol: bushRuntimeIpcProtocol, type: 'command', operationId: randomUUID(),
    command: { kind: 'runtime.automation', payload: input } }) as { ok?: boolean; result?: unknown; error?: { message: string } };
  if (!response.ok) throw new Error(response.error?.message ?? 'Automation action failed.');
  return response.result;
});
let calendarStore: Promise<import('./calendarStore.mjs', { with: { 'resolution-mode': 'import' } }).CalendarStore> | undefined;
let conversationExtractStore: Promise<import('./conversationExtracts.mjs', { with: { 'resolution-mode': 'import' } }).ConversationExtractStore> | undefined;
function conversationExtracts() {
  return conversationExtractStore ??= import('./conversationExtracts.mjs').then(({ ConversationExtractStore }) => {
    const store = new ConversationExtractStore(path.join(app.getPath('userData'), 'conversation-extracts'), async (sessionId, keys) => {
      const controller = await ensureRuntimeHostReady();
      const response = await controller.command({ protocol: bushRuntimeIpcProtocol, type: 'command', operationId: randomUUID(),
        command: { kind: 'runtime.extract_session', payload: { sessionId, keys } } }) as { ok?: boolean;
          result?: import('@cardbush/bush-protocol', { with: { 'resolution-mode': 'import' } }).ConversationExtractSource; error?: { message: string } };
      if (!response.ok || !response.result) throw new Error(response.error?.message ?? '无法读取会话。');
      return response.result;
    }, { notify: () => { for (const window of BrowserWindow.getAllWindows()) sendToLiveRenderer(window, 'conversation-extracts:changed'); } });
    app.once('will-quit', () => store.close());
    return store;
  });
}
ipcMain.handle('conversation-extracts:command', async (event, input: { action?: string; selection?: unknown; kind?: string; id?: string; contextWindowTokens?: number }) => {
  assertMainWindowSender(event.sender.id);
  if (!input || typeof input !== 'object') throw new Error('Invalid extraction request.');
  const store = await conversationExtracts();
  switch (input.action) {
    case 'list': return store.list();
    case 'preview': return store.preview(input.selection);
    case 'save': {
      if (!['temporary', 'permanent', 'reference'].includes(input.kind ?? '')) throw new Error('Invalid extraction save mode.');
      return store.save(input.selection, input.kind as 'temporary' | 'permanent' | 'reference');
    }
    case 'consume': return store.consume(String(input.id));
    case 'resolve': return store.resolve(String(input.id), input.contextWindowTokens);
    case 'remove': return store.remove(String(input.id));
    case 'export': return store.export(input.selection, async title => {
      const options = { title: '保存会话提取', defaultPath: `${title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100) || 'conversation'}.md`,
        filters: [{ name: 'Markdown', extensions: ['md'] }] };
      const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
      return result.canceled ? undefined : result.filePath;
    });
    default: throw new Error('Unknown extraction action.');
  }
});
ipcMain.handle('calendar:command', async (event, input: unknown) => {
  assertMainWindowSender(event.sender.id);
  calendarStore ??= import('./calendarStore.mjs').then(({ CalendarStore }) => new CalendarStore(path.join(app.getPath('userData'), 'calendars', 'calendars.json')));
  const result = await (await calendarStore).command(input, async () => {
    const options = { title: '导入日历', properties: ['openFile'] as Array<'openFile'>, filters: [{ name: '日历数据', extensions: ['json', 'ics'] }] };
    const chosen = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    return chosen.canceled ? undefined : chosen.filePaths[0];
  });
  if ((input as { action?: string })?.action !== 'list' && !result.cancelled) {
    for (const window of BrowserWindow.getAllWindows()) sendToLiveRenderer(window, 'calendar:changed');
  }
  return result;
});
function pluginMarkets() {
  return pluginMarketplaceService ??= new PluginMarketplaceService({
    dataRoot: path.join(app.getPath('userData'), 'plugin-marketplaces'),
    userPluginRoot: path.join(app.getPath('userData'), 'plugins'),
    bundledPluginRoot: path.join(app.getAppPath(), 'assets', 'plugins'),
    fetch: pluginFetch,
    replacePlugin: replaceInstalledProductPlugin,
    runAcquisition: async (command, args, cwd) => {
      const env = await (await pluginNetworking()).environment();
      return runAcquisitionCommand(command, command === 'git' ? ['-c', `http.proxy=${env.HTTPS_PROXY}`, ...args] : args, cwd, env);
    },
  });
}

const cacheSessions = new Set<Electron.Session>();
app.on('session-created', created => cacheSessions.add(created));
async function collectTemporaryCaches() {
  const results = [];
  for (const collect of [
    () => pluginMarkets().collectCache(),
    () => collectPluginAcquisitionCache(path.join(app.getPath('userData'), 'plugin-marketplaces')),
    () => collectPluginInstallCache(path.join(app.getPath('userData'), 'plugins')).then(results => mergeCleanup(...results)),
    () => ModelPreviewService.collectCache(),
  ]) {
    try { results.push(await collect()); }
    catch (error) { results.push({ counts: {}, errors: [error instanceof Error ? error.message : String(error)] }); }
  }
  return mergeCleanup(...results);
}

async function clearApplicationCaches() {
  cacheSessions.add(session.defaultSession);
  // Include persistent partitions from plugins that have not been opened this launch.
  const partitions = path.join(app.getPath('sessionData'), 'Partitions');
  const storageKey = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  const openedPaths = new Set([...cacheSessions].flatMap(value => value.storagePath ? [storageKey(value.storagePath)] : []));
  if (fs.existsSync(partitions) && !fs.lstatSync(partitions).isSymbolicLink()) {
    for (const entry of fs.readdirSync(partitions, { withFileTypes: true })) {
      const storage = path.join(partitions, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink() && !openedPaths.has(storageKey(storage))) {
        cacheSessions.add(session.fromPath(storage)); openedPaths.add(storageKey(storage));
      }
    }
  }
  return mergeCleanup(await clearBrowserCaches(cacheSessions), await collectTemporaryCaches());
}
ipcMain.handle('plugins:market-sources', async event => {
  assertMainWindowSender(event.sender.id);
  return pluginMarkets().sources();
});
ipcMain.handle('plugins:market-add', async (event, source: string) => {
  assertMainWindowSender(event.sender.id);
  return pluginMarkets().addSource(String(source ?? ''));
});
ipcMain.handle('plugins:market-add-local', async event => {
  assertMainWindowSender(event.sender.id);
  const result = await dialog.showOpenDialog(mainWindow!, { title: 'Choose plugin marketplace root', properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths[0]) return null;
  return pluginMarkets().addLocal(result.filePaths[0]);
});
ipcMain.handle('plugins:market-remove', async (event, id: string) => {
  assertMainWindowSender(event.sender.id);
  return pluginMarkets().remove(String(id));
});
ipcMain.handle('plugins:market-catalog', async (event, id: string, refresh: boolean) => {
  assertMainWindowSender(event.sender.id);
  return pluginMarkets().catalog(String(id), refresh === true);
});
ipcMain.handle('plugins:market-preview', async (event, sourceId: string, name: string) => {
  assertMainWindowSender(event.sender.id);
  return pluginMarkets().preview(String(sourceId), String(name));
});
ipcMain.handle('plugins:market-install', async (event, token: string) => {
  assertMainWindowSender(event.sender.id);
  return pluginMarkets().install(String(token));
});
ipcMain.handle('plugins:market-presentation', async (event, sourceId: string, name: string) => {
  assertMainWindowSender(event.sender.id);
  return pluginMarkets().presentation(String(sourceId), String(name));
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

registerRuntimePluginUiIpc(ipcMain, {
  dataRoot: () => path.join(app.getPath('userData'), 'plugin-data'),
  roots: productPluginRoots, configPath: productAppsConfigPath,
  window: () => mainWindow,
  assertSender: assertMainWindowSender,
});

ipcMain.handle('project:list-root', async (_, rootPath: string) => {
  if (rootPath.startsWith('ssh://')) return (await (await sshConnections()).directory(rootPath)).entries;
  return listProjectRoot(rootPath);
});

ipcMain.handle('project:validate-roots', async (_, rootPaths: string[]) => {
  const roots = Array.isArray(rootPaths) ? rootPaths : [];
  const connections = await (await sshConnections()).list();
  return [...inspectProjectRoots(roots.filter(root => !root.startsWith('ssh://'))), ...roots.filter(root => root.startsWith('ssh://')).map(rootPath => ({ rootPath, resolvedPath: rootPath, exists: connections.some(item => item.id === new URL(rootPath).hostname) }))];
});

ipcMain.handle(
  'project:rename-directory',
  (event, input: { rootPath?: string; name?: string }) => {
    assertMainWindowSender(event.sender.id);
    if (input.rootPath?.startsWith('ssh://')) throw Error('远程项目可修改显示名称；目录重命名请在远程终端执行。');
    return renameProjectDirectory(
      String(input?.rootPath ?? ''),
      String(input?.name ?? ''),
    );
  },
);

ipcMain.handle('project:search-files', async (_, rootPath: string, query: string) => {
  if (rootPath.startsWith('ssh://')) return (await sshConnections()).searchFiles(rootPath, query);
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
    if (requestedProjectDir.startsWith('ssh://')) throw Error('远程工作流文件请使用远程文件工具保存。');
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

ipcMain.handle('project:git-info', async (_, rootPath: string) => {
  if (rootPath.startsWith('ssh://')) return (await sshConnections()).git(rootPath, 'info');
  return readGitInfo(rootPath);
});

ipcMain.handle('project:git-branches', async (_, rootPath: string) => {
  if (rootPath.startsWith('ssh://')) return (await sshConnections()).git(rootPath, 'branches');
  return readGitBranches(rootPath);
});

ipcMain.handle('project:git-checkout', async (_, rootPath: string, branch: string) => {
  if (rootPath.startsWith('ssh://')) return (await sshConnections()).git(rootPath, 'checkout', branch);
  return checkoutGitBranch(rootPath, branch);
});

ipcMain.handle('project:git-create-branch', async (_, rootPath: string, branch: string) => {
  if (rootPath.startsWith('ssh://')) return (await sshConnections()).git(rootPath, 'create-branch', branch);
  return createGitBranch(rootPath, branch);
});

ipcMain.handle('project:git-commit', async (_, rootPath: string, message: string) => {
  if (rootPath.startsWith('ssh://')) return (await sshConnections()).git(rootPath, 'commit', message);
  return commitGitChanges(rootPath, message);
});

ipcMain.handle('project:git-push', async (_, rootPath: string) => {
  if (rootPath.startsWith('ssh://')) return (await sshConnections()).git(rootPath, 'push');
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

ipcMain.handle('app:host-capabilities', () => ({
  platform: process.platform, arch: process.arch, terminalRuntimes: terminalRuntimes(),
  defaultTerminalRuntime: defaultTerminalRuntime(process.platform), ...platformFeatures(process.platform, process.arch),
}));

ipcMain.handle('terminal:create', (event, cwd?: string, runtime?: TerminalRuntime) => {
  return createTerminalSession(event.sender.id, cwd, runtime, processOwnerSignal(event.sender));
});

ipcMain.handle('project:restore-file-changes', (_, rootPath: string,
  files: Array<{ path: string; diff?: string; lines?: string[] }>) => {
  const result = applyFileChanges(rootPath, files, false);
  return { restoredFiles: result.fileCount, output: result.output };
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
  session.stop();
  terminalSessions.delete(sessionId);
});

ipcMain.handle('terminal:run', (event, command: string, cwd?: string, runtime?: TerminalRuntime) => {
  return runTerminalCommand(command, cwd, runtime, processOwnerSignal(event.sender));
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

const imageGalleryScanner = new ImageGalleryScanner();
const imageGalleryOwners = new WeakSet<Electron.WebContents>();
function imageGalleryOwner(event: Electron.IpcMainInvokeEvent) {
  const owner = event.sender;
  const sourceWindow = BrowserWindow.fromWebContents(owner);
  if (!sourceWindow || (sourceWindow !== mainWindow && !shadowWindows.has(owner.id))) {
    throw new Error('Image galleries are available only in the application.');
  }
  if (!imageGalleryOwners.has(owner)) {
    imageGalleryOwners.add(owner);
    const id = owner.id;
    owner.once('destroyed', () => { void imageGalleryScanner.close(id); });
    owner.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) void imageGalleryScanner.close(id);
    });
  }
  return owner.id;
}
ipcMain.handle('image:gallery-start', (event, root: string, recursive: boolean) =>
  imageGalleryScanner.start(imageGalleryOwner(event), normalizeShellPath(root), recursive === true));
ipcMain.handle('image:gallery-next', (event, id: string) => imageGalleryScanner.next(imageGalleryOwner(event), id));
ipcMain.handle('image:gallery-close', (event, id: string) => imageGalleryScanner.close(imageGalleryOwner(event), id));

ipcMain.handle('browser:settings-read', async event => {
  assertMainWindowSender(event.sender.id);
  return (await browserConfigurationStore()).read();
});
ipcMain.handle('browser:settings-update', async (event, input: { startPage: string; expectedRevision: number }) => {
  assertMainWindowSender(event.sender.id);
  return (await browserConfigurationStore()).update(input);
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
    template.push(...buildFileContextMenu({ path: localTarget, exists: true, isFile: true }, {
      openWith: () => openFileWithChooser(localTarget),
      reveal: () => shell.showItemInFolder(localTarget),
      copyFile: () => copyLocalFileToClipboard(localTarget),
      copyPath: () => clipboard.writeText(localTarget),
      onError: error => { if (mainWindow) void showWindowError(mainWindow, '文件操作失败', error instanceof Error ? error.message : String(error)); },
    }));
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
    sendToLiveRenderer(mainWindow, 'cardling:action', {
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
  sendToLiveRenderer(mainWindow, 'cardling:action', action);
});

ipcMain.handle('shell:open-path', (event, targetPath: string) => {
  if (targetPath.startsWith('ssh://')) return '远程路径请在项目的 SSH 目录浏览器中查看。';
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

ipcMain.handle('shell:file-context-menu', async (event, targetPath: string, options: FileContextMenuOptions = {}) => {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender);
  if (!sourceWindow || (sourceWindow !== mainWindow && !shadowWindows.has(event.sender.id))) {
    return 'File menu is only available from the main CardBush window.';
  }
  const normalizedPath = /^cardbush-file:/i.test(targetPath) ? localPathFromProtocolUrl(targetPath) : normalizeShellPath(targetPath);
  const image = options.image && Number.isFinite(options.image.x) && Number.isFinite(options.image.y) ? options.image : undefined;
  if ((!normalizedPath && !image) || (normalizedPath && !path.isAbsolute(normalizedPath))) {
    return 'Invalid path.';
  }
  const stats = normalizedPath ? await fs.promises.stat(normalizedPath).catch(() => null) : null;
  if (sourceWindow.isDestroyed() || event.sender.isDestroyed()) return '';
  const menu = Menu.buildFromTemplate(buildFileContextMenu({ path: normalizedPath, exists: Boolean(stats), isFile: stats?.isFile() === true, language: options.language }, {
    open: () => openUiPreview(normalizedPath),
    openWith: () => openFileWithChooser(normalizedPath),
    reveal: () => shell.showItemInFolder(normalizedPath),
    copyPath: () => clipboard.writeText(normalizedPath),
    copyFile: () => copyLocalFileToClipboard(normalizedPath),
    ...(image ? { copyImage: () => { if (!event.sender.isDestroyed()) event.sender.copyImageAt(Math.round(image.x), Math.round(image.y)); } } : {}),
    onError: error => { void showWindowError(sourceWindow, options.language === 'en' ? 'File operation failed' : '文件操作失败', error instanceof Error ? error.message : String(error)); },
  }));
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
  return readTextPreviewResult(normalizedPath);
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
    const smokeDirectory = path.join(app.getPath('userData'), 'smoke space 中文');
    fs.mkdirSync(smokeDirectory, { recursive: true });
    fs.writeFileSync(path.join(smokeDirectory, '示例.txt'), 'cardbush-search-中文\n', 'utf8');
    const terminal = await runTerminalCommand(process.platform === 'win32'
      ? "[Console]::WriteLine('cardbush-terminal-中文')"
      : "printf '%s\\n' 'cardbush-terminal-中文'", smokeDirectory);
    if (terminal.exitCode !== 0 || !terminal.stdout.includes('cardbush-terminal-中文')) {
      throw new Error(`Packaged terminal failed: ${terminal.stderr}`);
    }
    if (!bundledRipgrep) throw new Error('Packaged search executable is missing.');
    const search = await runHostCommand({ executable: bundledRipgrep,
      args: ['--fixed-strings', '--', 'cardbush-search-中文', smokeDirectory],
      cwd: smokeDirectory, env: process.env, maxOutputBytes: 4096, outputLimit: 'truncate' });
    if (search.exitCode !== 0 || !search.stdout.includes('cardbush-search-中文')) {
      throw new Error('Packaged ripgrep did not find the Unicode fixture.');
    }
    Object.assign(report, { terminalReady: true, searchReady: true,
      hostCapabilities: platformFeatures(process.platform, process.arch) });
    const shellIcon = windowsShellIconPath({ packaged: cardbushRuntimeIsPackaged,
      executablePath: process.execPath, candidates: cardbushIconAssetPaths('cardbush.ico') });
    const shellIconReady = process.platform !== 'win32' || Boolean(shellIcon &&
      (require('original-fs') as typeof fs).existsSync(shellIcon) &&
      !(await app.getFileIcon(shellIcon, { size: 'normal' })).isEmpty());
    const assets = {
      windowIcon: !loadCardbushIcon(64).isEmpty(),
      windowsShellIcon: shellIconReady,
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
      chromeNativeHost: !platformFeatures(process.platform, process.arch).chromeNativeConnector || fs.existsSync(path.join(
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
      runtimeSearch: Boolean(
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

// Collect the native stack locally: a Chromium crash cannot be diagnosed from
// a renderer error boundary or an exit code alone. No reports are uploaded.
try {
  crashReporter.start({ uploadToServer: false, productName: 'CardBush' });
} catch (error) {
  console.warn('[crash-reporter]', String(error));
}
app.on('child-process-gone', (_event, details) => {
  appendDebugLog('renderer-lifecycle', { stage: 'child-process-gone', ...details });
});

app.whenReady().then(async () => {
  void collectTemporaryCaches().then(result => { if (result.errors.length) console.warn('[cache-maintenance]', result.errors); }).catch(error => console.warn('[cache-maintenance]', error));
  await setHostApplicationMemoryProvider(applicationMemoryBytes, relievePreviewForMemoryPressure);
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
  // Register the transport before any renderer exists. It survives failed boots
  // and explicit retries; requests share the services' readiness promise.
  const runtimeIpcModule = await import(pathToFileURL(path.join(__dirname, 'runtimeHostController.mjs')).href);
  runtimeHostIpc = runtimeIpcModule.registerRuntimeHostIpc(ipcMain, ensureRuntimeHostReady,
    (sender: Electron.WebContents) =>
      (mainWindow != null && sender.id === mainWindow.webContents.id) || shadowWindows.has(sender.id));
  try {
    await startChromeConnectorBroker();
  } catch (error) {
    console.error('[chrome-connector] bridge failed to start', error);
  }
  if (packagedSmokeMode) {
    await runPackagedApplicationSmoke();
    return;
  }
  await applyProxySettings({ mode: 'none', httpProxy: '', httpsProxy: '', noProxy: '' });
  createWindow();
  createTray();
  appendDebugLog('startup', {
    stage: 'window-created',
    elapsedMs: Date.now() - desktopStartupStartedAt,
    packaged: cardbushRuntimeIsPackaged,
  });
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
    sendToLiveRenderer(mainWindow, runtimeStartupStatusChannel, { ...next });
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
  if (runtimeServicesStopping || (!force && runtimeStartupStatus.attempt > 0 && runtimeStartupStatus.phase !== 'initializing')) return;
  const attempt = runtimeStartupStatus.attempt + 1;
  const startedAtMs = Date.now();
  publishRuntimeStartupStatus({
    phase: 'initializing',
    attempt,
    startedAt: new Date(startedAtMs).toISOString(),
  });
  // Assign a single flight before asynchronous cleanup or initialization starts.
  // Background reads must not turn a failed boot into an automatic retry loop.
  runtimeServicesInitialization = Promise.resolve().then(async () => {
    if (force) await disposeRuntimeServices();
    if (runtimeServicesStopping) throw new Error('CardBush Runtime is shutting down.');
    await initializeRuntimeHost();
  })
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

async function disposeRuntimeServices(error?: Error) {
  disposeDesktopControlMonitor();
  disposeCapabilityCatalogWatcher?.();
  disposeCapabilityCatalogWatcher = undefined;
  runtimeHostIpc?.reset(error);
  runtimeHostController?.dispose();
  runtimeHostController = null;
  productHostController = null;
  const management = productMcpManagement;
  productMcpManagement = null;
  await management?.close();
}

async function initializeRuntimeHost() {
  const abort = new AbortController();
  runtimeServicesAbort = abort;
  try {
    await withRuntimeStartupTimeout(
      initializeRuntimeHostWithinDeadline(abort.signal),
      runtimeServicesStartupTimeoutMs,
      abort,
    );
  } catch (error) {
    abort.abort(error);
    await disposeRuntimeServices(error instanceof Error ? error : new Error(String(error)))
      .catch(cleanupError => console.warn('[bush-runtime] startup cleanup failed', cleanupError));
    throw error;
  } finally {
    if (runtimeServicesAbort === abort) runtimeServicesAbort = null;
  }
}

async function initializeRuntimeHostWithinDeadline(signal: AbortSignal) {
  const sandboxSettingsPath = path.join(app.getPath('userData'), 'product-host', 'config', 'sandbox.json');
  const sandboxHostEnv = { ...process.env, CARDBUSH_EXECUTION_SANDBOX: process.env.CARDBUSH_EXECUTION_SANDBOX || app.commandLine.getSwitchValue('execution-sandbox') || undefined };
  const sandboxModule = await import(pathToFileURL(path.join(__dirname, 'sandboxSetup.mjs')).href);
  signal.throwIfAborted();
  sandboxSetup = new sandboxModule.SandboxSetup({ path: sandboxSettingsPath, env: sandboxHostEnv, interactive: true,
    windowsHostDirectory: cardbushRuntimeIsPackaged ? path.join(process.resourcesPath, 'process-guard') : path.join(app.getAppPath(), 'dist-native', 'process-guard') }) as SandboxSetupHost;
  // Detection never installs anything or prompts. An existing saved opt-out is preserved.
  await sandboxSetup.get().catch(error => console.warn('[sandbox-check]', error));
  signal.throwIfAborted();
  const bundledRipgrep = resolveBundledRipgrepPath();
  const managementModule = await import(pathToFileURL(path.join(__dirname, 'productMcpManagement.mjs')).href);
  signal.throwIfAborted();
  const management = await managementModule.startProductMcpManagement(() => {
    if (!productHostController) throw new Error('CardBush Product Host is not ready.');
    return productHostController;
  });
  if (signal.aborted) { await management.close(); signal.throwIfAborted(); }
  productMcpManagement = management;
  const controllerModuleUrl = pathToFileURL(
      path.join(__dirname, 'runtimeHostController.mjs'),
    ).href;
    const controllerModule = await import(controllerModuleUrl);
    signal.throwIfAborted();
    let runtimeWorkerReadySeen = false;
    const controller = new controllerModule.RuntimeUtilityProcessController({
      modulePath: path.join(__dirname, 'runtimeHostWorker.mjs'),
      startupTimeoutMs: 12_000,
      env: {
        ...process.env,
        // Host startup option only. A deployment environment policy takes
        // precedence; session settings and renderer payloads cannot change it.
        CARDBUSH_EXECUTION_SANDBOX: sandboxHostEnv.CARDBUSH_EXECUTION_SANDBOX,
        CARDBUSH_SANDBOX_SETTINGS_PATH: sandboxSettingsPath,
        CARDBUSH_MCP_MANAGEMENT_URL: productMcpManagement!.url,
        CARDBUSH_MCP_DESKTOP_BRIDGE: '1',
        CARDBUSH_PROCESS_HOST_DIRECTORY: cardbushRuntimeIsPackaged
          ? path.join(process.resourcesPath, 'process-guard')
          : path.join(app.getAppPath(), 'dist-native', 'process-guard'),
        CARDBUSH_MCP_MANAGEMENT_TOKEN: productMcpManagement!.token,
        CARDBUSH_RUNTIME_STATE_ROOT: path.join(
          app.getPath('userData'),
          'runtime-state',
        ),
        CARDBUSH_USAGE_LEDGER_PATH: path.join(app.getPath('userData'), 'usage', 'ledger.sqlite'),
        CARDBUSH_SUBAGENT_CONFIG_PATH: path.join(
          app.getPath('userData'),
          'product-host',
          'config',
          'subagents.json',
        ),
        CARDBUSH_RUNTIME_SKILL_ROOTS: JSON.stringify(productSkillRoots()),
        CARDBUSH_THEME_CONTEXT_PATH: visualThemeContextPath(),
        CARDBUSH_RUNTIME_PLUGIN_ROOTS: JSON.stringify(productPluginRoots()),
        CARDBUSH_RUNTIME_PLUGIN_DATA_ROOT: path.join(app.getPath('userData'), 'plugin-data'),
        CARDBUSH_BROWSER_CONFIG_PATH: browserConfigurationPath(),
        ...(bundledRipgrep ? { CARDBUSH_RG_PATH: bundledRipgrep } : {}),
        CARDBUSH_APPS_MCP_ENTRY: platformFeatures(process.platform, process.arch).computerUse ? path.join(
          app.getAppPath(),
          'packages',
          'cardbush-apps-mcp',
          'dist',
          'index.js',
        ) : '',
        CARDBUSH_CHROME_CONNECTOR_MCP_ENTRY: platformFeatures(process.platform, process.arch).chromeNativeConnector ? path.join(
          app.getAppPath(),
          'packages',
          'cardbush-chrome-mcp',
          'dist',
          'index.js',
        ) : '',
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
      onReady: () => {
        // The initial boot is owned by initializeProductHost; later worker
        // generations must restore the MCP catalog and restart the timer too.
        if (runtimeWorkerReadySeen) startRuntimeAutomations(controller);
        runtimeWorkerReadySeen = true;
      },
      onStderr: (text: string) => console.error('[bush-runtime]', text.trimEnd()),
      onMcpHostRequest: async (operation: Parameters<McpDesktopHost['handle']>[0], payload: unknown, signal: AbortSignal) => {
        if (operation === 'ssh.workspace') {
          const input = payload as { action: string; uri: string; path?: string; write?: boolean; owner: string; name: string; input: Record<string, unknown> };
          const manager = await sshConnections();
          if (input.action === 'directory') return manager.directory(input.uri);
          if (input.action === 'terminals') return manager.listTerminals(input.owner);
          if (input.action === 'authorize') return manager.authorize(input.uri, String(input.path ?? '.'), input.write);
          if (input.action === 'execute') return manager.execute(input.uri, input.owner, input.name, input.input, signal);
          throw Error('Unknown SSH workspace operation.');
        }
        if (operation === 'network.configuration') return (await pluginNetworking()).configuration();
        if (operation === 'network.route') return (await pluginNetworking()).endpoint(payload);
        if (operation === 'automation.changed') { for (const window of BrowserWindow.getAllWindows()) sendToLiveRenderer(window, 'automation:changed'); return; }
        if (operation === 'automation.prepare-model') {
          if (!productHostController) throw new Error('Product Host is not ready.');
          return productHostController.resolveAutomationModel(String((payload as { modelId?: unknown })?.modelId ?? ''));
        }
        if (operation === 'agents.list') return (await (await agentConnections()).list()).filter(item => item.hasToken && !item.migrationIssue).map(({ id, name, agentId }) => ({ id, name, agentId }));
        if (operation === 'agents.delegate') {
          const { runRemoteSubagent } = await import('./remoteSubagent.mjs');
          return runRemoteSubagent(await agentConnections(), payload as import('@cardbush/bush-protocol', { with: { 'resolution-mode': 'import' } }).RemoteSubagentRequest, signal);
        }
        if (operation === 'subagent.models' || operation === 'subagent.prepare-model') {
          if (!productHostController) throw new Error('Product Host is not ready.');
          return operation === 'subagent.models' ? productHostController.subagentModels()
            : productHostController.resolveSubagentModel(String((payload as { modelId?: unknown })?.modelId ?? ''));
        }
        if (operation === 'openai.access-token') return (await openAiDesktop()).access({
          rejectedToken: typeof (payload as { rejectedToken?: unknown })?.rejectedToken === 'string' ? (payload as { rejectedToken: string }).rejectedToken : undefined, signal });
        return mcpDesktop().handle(operation, payload, signal);
      },
    }) as RuntimeHostController;
    runtimeHostController = controller;
    registerDesktopControlMonitor(controller);
  await Promise.all([
    controller.start(),
    initializeProductHost(controller, signal),
  ]);
  signal.throwIfAborted();
  await productHostController?.execute({
    protocol: 'cardbush.product_host_ipc.v1',
    kind: 'apps.get',
  });
  signal.throwIfAborted();
}

function withRuntimeStartupTimeout<T>(operation: Promise<T>, timeoutMs: number, abort: AbortController): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(
        `Runtime services did not become ready within ${timeoutMs}ms`,
      ) as Error & { code?: string };
      error.code = 'runtime_services_startup_timeout';
      abort.abort(error);
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

function startRuntimeAutomations(controller: RuntimeHostController) {
  const host = productHostController;
  if (!host || runtimeServicesStopping) return;
  void host.refreshMcp().catch((error: unknown) => console.warn('[automation-startup]', error))
    .then(() => {
      if (runtimeServicesStopping || productHostController !== host || runtimeHostController !== controller) return;
      return controller.command({ protocol: bushRuntimeIpcProtocol, type: 'command', operationId: randomUUID(), command: { kind: 'runtime.automation_start', payload: {} } });
    })
    .catch((error: unknown) => console.warn('[automation-startup]', error));
}

async function initializeProductHost(controller: RuntimeHostController, signal: AbortSignal) {
  const moduleUrl = pathToFileURL(
    path.join(__dirname, 'productHostController.mjs'),
  ).href;
  const productModule = await import(moduleUrl);
  signal.throwIfAborted();
  const runtimeStateRoot = path.join(app.getPath('userData'), 'runtime-state');
  const bundledSkillRoot = bundledProductSkillRoot();
  const userSkillRoot = path.join(app.getPath('userData'), 'skills');
  const bundledPluginRoot = path.join(app.getAppPath(), 'assets', 'plugins');
  const userPluginRoot = path.join(app.getPath('userData'), 'plugins');
  productHostController = new productModule.ElectronProductHostController({
    sandbox: sandboxSetup,
    dataRoot: path.join(app.getPath('userData'), 'product-host'),
    runtimeStateRoot,
    logRoots: [appLogsDir(), path.join(app.getPath('userData'), 'logs')],
    clearApplicationCaches,
    clearCrashReports: () => clearDiagnosticFiles(app.getPath('crashDumps'), (name, modified) => /\.(dmp|meta)$/i.test(name) && modified < Date.now() - 24 * 60 * 60_000),
    bundledSkillRoot,
    userSkillRoot,
    bundledPluginRoot,
    userPluginRoot,
    legacyModelConfigPaths: legacyBushserverModelConfigPaths(),
    runtimeBridge: controller,
    credentials: {
      read: (key: string) => mcpDesktop().handle('credentials.read', { key }, new AbortController().signal),
      write: (key: string, value: unknown) => mcpDesktop().handle('credentials.write', { key, value }, new AbortController().signal),
    },
    requestClientCredentials: (input: Parameters<McpDesktopHost['requestClientCredentials']>[0], signal: AbortSignal) => mcpDesktop().requestClientCredentials(input, signal),
  }) as NonNullable<typeof productHostController>;
  startRuntimeAutomations(controller);
  disposeCapabilityCatalogWatcher?.();
  disposeCapabilityCatalogWatcher = watchCapabilityCatalog([
    ...productSkillRoots(),
    bundledPluginRoot, userPluginRoot,
    path.join(app.getPath('userData'), 'product-host', 'config'),
  ], () => {
    void refreshPluginUiNetwork().catch((error: unknown) => console.warn('[plugin-ui-network]', error));
    const notify = () => {
      for (const window of BrowserWindow.getAllWindows()) {
        sendToLiveRenderer(window, 'capabilities:changed');
      }
    };
    notify();
    void productHostController?.refreshMcp().catch((error: unknown) => {
      console.warn('[capability-refresh]', error instanceof Error ? error.message : String(error));
    }).finally(notify);
  });
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
  return bundledToolPath(cardbushRuntimeIsPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'assets'), 'ripgrep');
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
  if (!platformFeatures(process.platform, process.arch).chromeNativeConnector) return;
  if (chromeConnectorBroker) return;
  const broker = new ChromeConnectorBroker(app.getPath('userData'));
  chromeConnectorBroker = broker;
  unregisterChromeConnectorStatus = broker.onStatus((status) => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoadingMainFrame()) {
      sendToLiveRenderer(mainWindow, 'chrome-connector:status', {
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
  if (!protocol.isProtocolHandled('cardbush-agent')) protocol.handle('cardbush-agent', async request => (await agentFilePreviews()).respond(request));
  if (protocol.isProtocolHandled(localFileProtocol)) {
    return;
  }
  protocol.handle(localFileProtocol, async (request) => {
    try {
      const parsed = new URL(request.url);
      const protocolHost = parsed.hostname.toLowerCase();
      if (protocolHost === 'model-preview') {
        if (parsed.pathname.startsWith('/assets/')) {
          return await previewRendererAssetResponse(parsed.pathname) ?? new Response('Not found', { status: 404 });
        }
        if (parsed.pathname === '/' || parsed.pathname === '/model-preview.html') {
          if (devServerUrl) {
            const url = new URL('/model-preview.html', devServerUrl);
            url.search = parsed.search;
            return Response.redirect(url.toString(), 302);
          }
          return await previewRendererAssetResponse('/model-preview.html', false) ?? new Response('Not found', { status: 404 });
        }
        modelPreviewService ??= new ModelPreviewService({ scriptPath: path.join(app.getAppPath(), 'assets', 'previewers', 'blender_preview.py') });
        const headers = { 'cache-control': 'no-store', ...(devServerUrl ? {
          'access-control-allow-origin': new URL(devServerUrl).origin,
          'access-control-allow-methods': 'GET, DELETE, OPTIONS',
        } : {}) };
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
        if (parsed.pathname === '/manifest' && request.method === 'GET') {
          try {
            const result = await modelPreviewService.preview(normalizeShellPath(parsed.searchParams.get('path') ?? ''), parsed.searchParams.get('scene') ?? '', request.signal, parsed.searchParams.get('requestId') || undefined);
            return Response.json({ ...result.metadata, size: result.size, resource: `cardbush-file://model-preview/resource/${result.id}` }, { headers });
          } catch (error) {
            return Response.json({ error: error instanceof Error ? error.message : String(error), code: error instanceof ModelPreviewError ? error.code : 'read_failed' }, { headers });
          }
        }
        if (parsed.pathname.startsWith('/resource/')) {
          const id = parsed.pathname.slice('/resource/'.length);
          if (request.method === 'DELETE') {
            await modelPreviewService.release(id);
            return new Response(null, { status: 204, headers });
          }
          if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers });
          const file = modelPreviewService.resource(id);
          if (!file) return new Response('Preview expired', { status: 404, headers });
          const response = await net.fetch(pathToFileURL(file).toString());
          return new Response(response.body, { headers: { ...headers, 'content-type': 'model/gltf-binary', ...(response.headers.has('content-length') ? { 'content-length': response.headers.get('content-length')! } : {}) } });
        }
        return new Response('Not found', { status: 404 });
      }
      if (protocolHost === 'office-source') {
        const officePath = normalizeShellPath(parsed.searchParams.get('path') ?? '');
        const stats = await fs.promises.stat(officePath);
        if (!stats.isFile() || !isHighFidelityOfficePreviewPath(officePath)) {
          return new Response('Not found', { status: 404 });
        }
        try { await checkOfficePreviewAdmission(officePath); }
        catch (error) { return new Response(error instanceof Error ? error.message : String(error), { status: 413 }); }
        const source = await localFileResponse(officePath, contentTypeForPath(officePath), request, undefined, officePreviewLimits.compressedBytes);
        source.headers.set('x-content-type-options', 'nosniff');
        return source;
      }
      if (protocolHost === 'office-preview') {
        if (parsed.pathname.startsWith('/assets/')) {
          return await previewRendererAssetResponse(parsed.pathname)
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
          await checkOfficePreviewAdmission(officePath);
          const preview = await runHostCommand({ executable: process.execPath, args: [path.join(__dirname, 'officePreviewWorker.js'), officePath],
            cwd: path.dirname(officePath), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, signal: request.signal,
            memoryCeilingBytes: 512 * 1024 ** 2, maxOutputBytes: 24 * 1024 ** 2, timeoutMs: 20_000 });
          if (preview.exitCode !== 0) throw new Error(preview.stderr || '预览未完成，可在外部应用打开文件。');
          previewHtml = preview.stdout;
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
      const response = await localFileResponse(normalizedPath, responseType, request, range ?? undefined);
      response.headers.set('cache-control', 'public, max-age=31536000, immutable');
      return response;
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
  return previewRendererAssetResponse('/office-preview.html', false);
}

async function previewRendererAssetResponse(
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
  disposeCapabilityCatalogWatcher?.();
  disposeCapabilityCatalogWatcher = undefined;
  if (hostShutdownComplete) {
    return;
  }
  event.preventDefault();
  if (hostShutdownPromise == null) {
    // Stop only main-process-owned commands; the Runtime and shared MCP services
    // continue through their own orderly shutdown below.
    const processesClosed = closeHostProcesses();
    hostShutdownPromise = (productHostController?.shutdown() ?? Promise.resolve()).finally(async () => {
      await (await openAiAccountPromise)?.close();
      await (await pluginNetworkPromise)?.close();
      await productMcpManagement?.close();
      productMcpManagement = null;
      await modelPreviewService?.dispose();
      await processesClosed;
      await (await agentConnectionsPromise)?.close();
      await (await sshConnectionsPromise)?.close();
      modelPreviewService = undefined;
      hostShutdownComplete = true;
      app.quit();
    });
  }
});

app.on('will-quit', () => {
  runtimeServicesStopping = true;
  runtimeServicesAbort?.abort(new Error('CardBush Runtime is shutting down.'));
  unregisterChromeConnectorStatus?.();
  unregisterChromeConnectorStatus = null;
  chromeConnectorBroker?.stop();
  chromeConnectorBroker = null;
  disposeDesktopControlMonitor();
  runtimeHostIpc?.dispose();
  runtimeHostIpc = null;
  runtimeHostController?.dispose();
  runtimeHostController = null;
  productHostController = null;
  if (quitFallbackTimer != null) {
    clearTimeout(quitFallbackTimer);
    quitFallbackTimer = null;
  }
  for (const session of terminalSessions.values()) {
    session.stop();
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
  if (value.trim().startsWith('ssh://')) return '';
  return localPath(value);
}

function localPathFromProtocolUrl(value: string) {
  return localFileSystemPathFromProtocolUrl(value);
}

function imageMimeTypeForPath(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.avif') return 'image/avif';
  if (extension === '.apng') return 'image/apng';
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
  if (extension === '.pdf') return 'application/pdf';
  if (['.txt', '.csv', '.tsv', '.md'].includes(extension)) return 'text/plain; charset=utf-8';
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
  (await pluginNetworking()).setModel(proxy);
  await refreshPluginUiNetwork();
  const modelSession = session.fromPartition('cardbush-model-network');
  if (proxy.mode === 'system') {
    await modelSession.setProxy({ mode: 'system' });
    return;
  }
  if (proxy.mode === 'none') {
    await modelSession.setProxy({ mode: 'direct' });
    return;
  }
  const rules = [
    proxy.httpProxy.trim() ? `http=${normalizeProxyRule(proxy.httpProxy)}` : '',
    proxy.httpsProxy.trim() ? `https=${normalizeProxyRule(proxy.httpsProxy)}` : '',
  ].filter(Boolean);
  await modelSession.setProxy({
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
  const result = applyFileChanges(rootPath, files, true);
  return { revertedFiles: result.fileCount, output: result.output };
}

function applyFileChanges(
  rootPath: string,
  files: Array<{ path: string; diff?: string; lines?: string[] }>,
  reverse: boolean,
) {
  const root = requireProjectDirectory(rootPath);
  const patch = buildReversePatchInput(root, files);
  if (!patch.trim()) {
    throw new Error('No patch content was provided.');
  }
  runGitWithInput(
    root,
    ['apply', '--no-index', ...(reverse ? ['--reverse'] : []), '--check', '--whitespace=nowarn'],
    patch,
  );
  const output = runGitWithInput(
    root,
    ['apply', '--no-index', ...(reverse ? ['--reverse'] : []), '--whitespace=nowarn'],
    patch,
  );
  return {
    fileCount: files.filter((file) => String(file.path ?? '').trim()).length,
    output: output.trim() || (reverse ? 'Reverted file changes.' : 'Restored file changes.'),
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
  if (rootPath.startsWith('ssh://')) throw Error('此操作需要使用远程终端完成。');
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

async function createTerminalSession(ownerId: number, cwd?: string, runtime?: TerminalRuntime, signal?: AbortSignal) {
  const workingDirectory = resolveCwd(cwd);
  const shellInfo = terminalShell(runtime, workingDirectory);
  const managed = await spawnHostProcess({ executable: shellInfo.command, args: shellInfo.args,
    cwd: workingDirectory,
    signal,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    },
  });
  const child = managed.child;
  const id = randomUUID();
  terminalSessions.set(id, {
    process: child,
    stop: managed.stop,
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
  child.stdin.on('error', () => undefined); // The shell can close between a write and renderer delivery.
  child.on('close', async (exitCode) => {
    terminalSessions.delete(id);
    const report = await managed.complete();
    if (report?.code && !signal?.aborted && !child.killed) sendTerminalData(ownerId, id, `${report.message}\r\n`);
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
  sendToLiveRenderer(owner, channel, payload);
}

function terminalShell(runtime?: TerminalRuntime, cwd?: string) {
  return terminalInvocation(runtime, cwd);
}

async function runTerminalCommand(command: string, cwd?: string, runtime?: TerminalRuntime, signal?: AbortSignal) {
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
  const workingDirectory = resolveCwd(cwd);
  try {
    const { command: shellCommand, args } = terminalInvocation(runtime, workingDirectory, trimmed);
    const result = await runHostCommand({ executable: shellCommand, args,
      cwd: workingDirectory,
      env: process.env,
      signal, maxOutputBytes: 80 * 1024, outputLimit: 'truncate',
    });
    return { command: trimmed, cwd: workingDirectory, exitCode: result.exitCode,
      stdout: trimTerminalOutput(result.stdout), stderr: trimTerminalOutput(result.stderr),
      outputTruncated: result.outputTruncated || result.stdout.length > 20000 || result.stderr.length > 20000 };
  } catch (error) {
    return { command: trimmed, cwd: workingDirectory, exitCode: 1, stdout: '', stderr: commandErrorMessage(error) };
  }
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

async function copyWindowsFileToClipboard(targetPath: string) {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$items = New-Object System.Collections.Specialized.StringCollection',
    '[void]$items.Add([IO.Path]::GetFullPath($env:CARDBUSH_CLIPBOARD_TARGET))',
    '[Windows.Forms.Clipboard]::SetFileDropList($items)',
  ].join('; ');
  const result = await runHostCommand({
    executable: 'powershell.exe',
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script],
    cwd: path.dirname(targetPath), timeoutMs: 5_000, maxOutputBytes: 16 * 1024,
    env: { ...process.env, CARDBUSH_CLIPBOARD_TARGET: targetPath },
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Copy file exited with code ${result.exitCode}.`);
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
import { installSandboxFrameNavigationGuard } from './sandboxFrameGuard';
