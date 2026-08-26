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
  type OpenDialogOptions,
} from 'electron';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { inspectProjectRoots } from './projectRoots';
import { isOfficePreviewPath, renderOfficePreview } from './officePreview';
import { localFileSystemPathFromProtocolUrl } from './localFileProtocol';

const devServerUrl = process.env.CARDBUSH_ELECTRON_DEV_SERVER_URL?.trim();
const localFileProtocol = 'cardbush-file';
const cardbushAppUserModelId = 'com.cardbush.desktop';
const cardbushDisplayName = 'cardbush';
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
let cardlingWindow: BrowserWindow | null = null;
const externalBrowserWindows = new Set<BrowserWindow>();
let tray: Tray | null = null;
let isQuitting = false;
let quitFallbackTimer: ReturnType<typeof setTimeout> | null = null;
let startupRevealFallback: ReturnType<typeof setTimeout> | null = null;
let osTaskbarWatchdog: ReturnType<typeof spawn> | null = null;
let osApplicationsCache: Awaited<ReturnType<typeof listOsApplications>> | null = null;
let osApplicationsPending: Promise<Awaited<ReturnType<typeof listOsApplications>>> | null = null;
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
const terminalSessions = new Map<
  string,
  {
    process: ChildProcessWithoutNullStreams;
    ownerId: number;
    cwd: string;
  }
>();

type TerminalRuntime = 'powershell' | 'wsl' | 'git_bash' | 'bash';

type OsLoginSettings = {
  enabled: boolean;
  startInOsMode: boolean;
};

function osLoginItemArgs(startInOsMode: boolean) {
  const modeArgs = startInOsMode ? ['--os-mode'] : [];
  return app.isPackaged ? modeArgs : [app.getAppPath(), ...modeArgs];
}

function readOsLoginSettings(): OsLoginSettings & { supported: boolean } {
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    return { enabled: false, startInOsMode: false, supported: false };
  }
  const startInOsMode = process.argv.includes('--os-mode');
  const enabled = app.getLoginItemSettings({
    path: process.execPath,
  }).openAtLogin;
  return { enabled, startInOsMode, supported: true };
}

function writeOsLoginSettings(value: OsLoginSettings) {
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    return { enabled: false, startInOsMode: false, supported: false };
  }
  app.setLoginItemSettings({
    openAtLogin: value.enabled === true,
    openAsHidden: false,
    path: process.execPath,
    args: osLoginItemArgs(value.startInOsMode === true),
  });
  return {
    enabled: value.enabled === true,
    startInOsMode: value.startInOsMode === true,
    supported: true,
  };
}

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
  miniChat?: {
    title?: string;
    lastUser?: string;
    lastAssistant?: string;
  };
};

type AppThemeMode = CardlingDesktopState['theme'];

const mainWindowThemeBackgrounds: Record<AppThemeMode, string> = {
  dark: '#1a1a1a',
  bright: '#f5f3ef',
  parchment: '#e1d4ba',
};

let lastMainWindowTheme: AppThemeMode = 'dark';

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
  return path.join(app.isPackaged ? app.getPath('userData') : process.cwd(), 'logs');
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

function createWindow() {
  if (mainWindow != null && !mainWindow.isDestroyed()) {
    return;
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
  applyMainWindowVisualMaterial(window, lastMainWindowTheme);

  installMainWindowNavigationGuard(window);
  window.webContents.once('did-finish-load', () => {
    applyCardbushWindowIcon(window, windowIcon, 'did-finish-load', loadedWindowIcon.sourcePath);
  });

  const refreshWindowBackdrop = () => {
    applyCardbushWindowIcon(window, windowIcon);
    applyMainWindowVisualMaterial(window, lastMainWindowTheme);
  };
  window.on('minimize', refreshWindowBackdrop);
  window.on('restore', refreshWindowBackdrop);
  window.on('show', refreshWindowBackdrop);
  window.on('focus', () => {
    refreshWindowBackdrop();
    window.flashFrame(false);
  });
  applySessionAttentionBadge();

  startupRevealFallback = setTimeout(() => {
    if (!window.isDestroyed() && !window.isVisible()) {
      applyMainWindowVisualMaterial(window, lastMainWindowTheme);
      window.show();
    }
  }, 5000);

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
}

function applyMainWindowVisualMaterial(target: BrowserWindow, theme: AppThemeMode) {
  if (target.isDestroyed()) {
    return;
  }
  lastMainWindowTheme = theme;
  target.setBackgroundColor(backgroundForMainWindowTheme(theme));
  if (process.platform !== 'win32') {
    return;
  }
  try {
    target.setBackgroundMaterial('none');
  } catch {
    // Older Windows builds ignore this; the CSS theme background still applies.
  }
}

function backgroundForMainWindowTheme(theme: AppThemeMode) {
  return mainWindowThemeBackgrounds[theme] ?? mainWindowThemeBackgrounds.dark;
}

function installMainWindowNavigationGuard(target: BrowserWindow) {
  target.webContents.setWindowOpenHandler(({ url }) => {
    if (sendLocalPreviewToInspector(target, url)) {
      return { action: 'deny' };
    }
    void openUiPreview(url);
    return { action: 'deny' };
  });
  target.webContents.on('will-navigate', (event, targetUrl) => {
    if (isAllowedAppNavigation(targetUrl)) {
      return;
    }
    if (sendLocalPreviewToInspector(target, targetUrl)) {
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

function sendLocalPreviewToInspector(target: BrowserWindow, value: string) {
  const previewTarget = resolveUiPreviewTarget(value);
  if (!previewTarget?.localPath) {
    return false;
  }
  target.webContents.send('shell:open-inspector', {
    target: previewTarget.localPath,
    title: path.basename(previewTarget.localPath),
  });
  return true;
}

async function openUiPreview(targetUrl: string) {
  const previewTarget = resolveUiPreviewTarget(targetUrl);
  if (previewTarget == null) {
    await openTargetExternally(targetUrl);
    return;
  }
  const officeReadOnlyPreview = Boolean(
    previewTarget.localPath && isOfficePreviewPath(previewTarget.localPath),
  );
  const browserIcon = loadCardbushIcon(128);
  const browser = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 760,
    minHeight: 520,
    title: officeReadOnlyPreview ? 'CardBush Office 只读预览' : 'CardBush UI 预览',
    icon: browserIcon,
    parent: mainWindow ?? undefined,
    show: false,
    autoHideMenuBar: officeReadOnlyPreview,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  applyCardbushWindowIcon(browser, browserIcon);
  externalBrowserWindows.add(browser);
  browser.setMenu(
    Menu.buildFromTemplate([
      {
        label: 'UI 预览',
        submenu: [
          {
            label: '返回应用',
            accelerator: 'Ctrl+Shift+B',
            click: () => {
              showMainWindow();
              browser.close();
            },
          },
          {
            label: '关闭预览',
            accelerator: 'Ctrl+W',
            click: () => browser.close(),
          },
          ...(!officeReadOnlyPreview ? [
            { type: 'separator' as const },
            {
              label: previewTarget.localPath ? '在系统中打开' : '在系统浏览器打开',
              click: () => {
                const currentUrl = browser.webContents.getURL() || previewTarget.url;
                const currentTarget = resolveUiPreviewTarget(currentUrl) ?? previewTarget;
                void openTargetExternally(currentTarget.externalTarget, currentTarget);
              },
            },
          ] : []),
          {
            label: '复制地址',
            accelerator: 'Ctrl+Shift+C',
            click: () => clipboard.writeText(browser.webContents.getURL() || previewTarget.url),
          },
        ],
      },
      {
        label: '视图',
        submenu: [
          {
            label: '后退',
            accelerator: 'Alt+Left',
            click: () => {
              if (browser.webContents.canGoBack()) {
                browser.webContents.goBack();
              } else {
                showMainWindow();
                browser.close();
              }
            },
          },
          {
            label: '前进',
            accelerator: 'Alt+Right',
            click: () => {
              if (browser.webContents.canGoForward()) {
                browser.webContents.goForward();
              }
            },
          },
          {
            label: '刷新',
            accelerator: 'Ctrl+R',
            click: () => browser.webContents.reload(),
          },
          {
            label: '强制刷新',
            accelerator: 'Ctrl+Shift+R',
            click: () => browser.webContents.reloadIgnoringCache(),
          },
          { type: 'separator' },
          {
            label: '放大',
            accelerator: 'Ctrl+=',
            click: () => setPreviewZoom(browser, 0.1),
          },
          {
            label: '缩小',
            accelerator: 'Ctrl+-',
            click: () => setPreviewZoom(browser, -0.1),
          },
          {
            label: '重置缩放',
            accelerator: 'Ctrl+0',
            click: () => browser.webContents.setZoomFactor(1),
          },
          { type: 'separator' },
          {
            label: '打开开发者工具',
            accelerator: 'Ctrl+Shift+I',
            click: () => browser.webContents.openDevTools({ mode: 'detach' }),
          },
        ],
      },
    ]),
  );
  browser.once('ready-to-show', () => {
    browser.show();
    browser.focus();
  });
  browser.on('closed', () => {
    externalBrowserWindows.delete(browser);
  });
  browser.webContents.setWindowOpenHandler(({ url }) => {
    const next = resolveUiPreviewTarget(url);
    if (next != null) {
      void browser.loadURL(next.url);
    } else {
      void openTargetExternally(url);
    }
    return { action: 'deny' };
  });
  browser.webContents.on('will-navigate', (event, nextUrl) => {
    if (resolveUiPreviewTarget(nextUrl) != null) {
      return;
    }
    event.preventDefault();
    void openTargetExternally(nextUrl);
  });
  await browser.loadURL(previewTarget.url).catch(async () => {
    browser.close();
    await openTargetExternally(targetUrl, previewTarget);
  });
}

function setPreviewZoom(browser: BrowserWindow, delta: number) {
  if (browser.isDestroyed()) {
    return;
  }
  const current = browser.webContents.getZoomFactor();
  const next = Math.min(3, Math.max(0.25, Math.round((current + delta) * 10) / 10));
  browser.webContents.setZoomFactor(next);
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

function loadRenderer(target: BrowserWindow, mode: 'main' | 'cardling') {
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
      payload.theme === 'dark'
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
  const icon = loadCardbushIcon(32);
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
        return {
          image: image.resize({ width: size, height: size, quality: 'best' }),
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
        packaged: app.isPackaged,
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
    const shortcutPath = path.join(programsDir, 'CardBush.lnk');
    const operation = fs.existsSync(shortcutPath) ? 'replace' : 'create';
    const success = shell.writeShortcutLink(shortcutPath, operation, {
      target: process.execPath,
      ...(app.isPackaged
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
  return app.isPackaged
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
  const notification = new Notification({
    title: payload.title,
    body: payload.body,
    icon: loadCardbushIcon(64),
    silent: false,
  });
  notification.on('click', () => {
    showMainWindow();
    if (mainWindow != null && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('attention:open-session', {
        sessionId: payload.sessionId,
      });
    }
  });
  notification.show();
  mainWindow?.flashFrame(true);
  return { shown: true };
}

function showMainWindow() {
  if (mainWindow == null || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  applyMainWindowVisualMaterial(mainWindow, lastMainWindowTheme);
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  } else {
    mainWindow.show();
  }
  mainWindow.focus();
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

ipcMain.handle('debug:append-log', (event, scope: string, payload: unknown) => {
  if (mainWindow == null || event.sender.id !== mainWindow.webContents.id) {
    throw new Error('debug log is only available to the main window');
  }
  return appendDebugLog(scope, payload);
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
  applyMainWindowVisualMaterial(sourceWindow, lastMainWindowTheme);
  const loadedIcon = loadCardbushIconWithSource(256);
  applyCardbushWindowIcon(
    sourceWindow,
    loadedIcon.image,
    'renderer-ready-before-show',
    loadedIcon.sourcePath,
  );
  sourceWindow.show();
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

ipcMain.handle('os:login-settings', () => readOsLoginSettings());

ipcMain.handle('os:set-login-settings', (_, value: OsLoginSettings) =>
  writeOsLoginSettings({
    enabled: value?.enabled === true,
    startInOsMode: value?.startInOsMode === true,
  }),
);

ipcMain.handle('os:startup-context', () => ({
  launchedInOsMode: process.argv.includes('--os-mode'),
  supported: process.platform === 'win32' || process.platform === 'darwin',
}));

ipcMain.handle('os:set-shell-mode', (event, enabled: boolean) => {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender);
  if (sourceWindow == null || sourceWindow.isDestroyed()) {
    return { enabled: false };
  }
  const nextEnabled = enabled === true;
  sourceWindow.setMenuBarVisibility(false);
  if (nextEnabled) {
    // On Windows, forcing an already maximized frameless window into Electron's
    // fullscreen mode can restore its previous bounds first. Keep the native
    // maximized state in that case; the OS renderer already fills the window.
    if (!sourceWindow.isMaximized() && !sourceWindow.isFullScreen()) {
      sourceWindow.setFullScreen(true);
    }
    hideWindowsTaskbarWithWatchdog();
    sourceWindow.show();
    sourceWindow.focus();
  } else {
    if (sourceWindow.isFullScreen()) {
      sourceWindow.setFullScreen(false);
    }
    restoreWindowsTaskbar();
  }
  return { enabled: nextEnabled };
});

ipcMain.handle('appearance:wallpaper-accent', () => {
  return readWallpaperAccent();
});

ipcMain.handle('appearance:wallpaper-path', () => {
  try {
    return currentWallpaperPath();
  } catch {
    return '';
  }
});

ipcMain.handle('appearance:wallpaper-data-url', async () => {
  try {
    const wallpaperPath = currentWallpaperPath();
    if (!wallpaperPath) {
      return '';
    }
    const bytes = await fs.promises.readFile(wallpaperPath);
    const detectedType = contentTypeForBytes(bytes);
    const contentType = detectedType === 'application/octet-stream'
      ? contentTypeForPath(wallpaperPath)
      : detectedType;
    if (!contentType.startsWith('image/')) {
      return '';
    }
    return `data:${contentType};base64,${bytes.toString('base64')}`;
  } catch {
    return '';
  }
});

ipcMain.handle('appearance:set-window-theme', (event, theme: AppThemeMode) => {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender);
  if (sourceWindow !== mainWindow || sourceWindow == null || sourceWindow.isDestroyed()) {
    return;
  }
  const normalizedTheme: AppThemeMode =
    theme === 'bright' || theme === 'parchment' || theme === 'dark'
      ? theme
      : 'dark';
  applyMainWindowVisualMaterial(sourceWindow, normalizedTheme);
});

ipcMain.handle('os:filesystem-locations', (event) => {
  assertMainWindowSender(event.sender.id);
  return osFilesystemLocations();
});

ipcMain.handle('os:list-directory', async (event, targetPath?: string) => {
  assertMainWindowSender(event.sender.id);
  return listOsDirectory(targetPath);
});

ipcMain.handle('os:create-directory', async (event, parentPath: string, name: string) => {
  assertMainWindowSender(event.sender.id);
  const parent = normalizeShellPath(parentPath);
  const safeName = path.basename(String(name ?? '').trim());
  if (!parent || !safeName || safeName === '.' || safeName === '..') {
    throw new Error('Invalid folder name.');
  }
  const target = path.join(parent, safeName);
  await fs.promises.mkdir(target);
  return target;
});

ipcMain.handle('os:rename-path', async (event, sourcePath: string, name: string) => {
  assertMainWindowSender(event.sender.id);
  const source = normalizeShellPath(sourcePath);
  const safeName = path.basename(String(name ?? '').trim());
  if (!source || !safeName || safeName === '.' || safeName === '..') {
    throw new Error('Invalid path or name.');
  }
  const target = path.join(path.dirname(source), safeName);
  await fs.promises.rename(source, target);
  return target;
});

ipcMain.handle('os:trash-path', async (event, targetPath: string) => {
  assertMainWindowSender(event.sender.id);
  const target = normalizeShellPath(targetPath);
  if (!target || path.parse(target).root === target) {
    throw new Error('This path cannot be moved to the recycle bin.');
  }
  await shell.trashItem(target);
});

ipcMain.handle('os:list-applications', async (event, forceRefresh = false) => {
  assertMainWindowSender(event.sender.id);
  return listOsApplicationsCached(forceRefresh === true);
});

ipcMain.handle('os:running-applications', async (event) => {
  assertMainWindowSender(event.sender.id);
  return listRunningOsApplications();
});

ipcMain.handle('os:list-windows', async (event) => {
  assertMainWindowSender(event.sender.id);
  return listOsWindows();
});

ipcMain.handle('os:window-action', async (
  event,
  windowId: string,
  action: 'focus' | 'minimize' | 'maximize' | 'restore' | 'close',
) => {
  assertMainWindowSender(event.sender.id);
  return controlOsWindow(windowId, action);
});

ipcMain.handle('os:launch-application', async (event, appId: string) => {
  assertMainWindowSender(event.sender.id);
  const target = normalizeShellPath(appId);
  if (!target || !isStartMenuApplication(target)) {
    throw new Error('Invalid application identifier.');
  }
  const record = resolvedStartMenuApplication(target);
  if (!record) {
    throw new Error('Application shortcut is no longer available.');
  }
  if (await focusExistingWindowsApplication(record.target)) {
    return { status: 'focused', applicationId: record.id };
  }
  const error = await shell.openPath(target);
  if (error) {
    throw new Error(error);
  }
  let focused = false;
  for (let attempt = 0; attempt < 10 && !focused; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 280));
    focused = await focusExistingWindowsApplication(record.target);
  }
  return {
    status: focused ? 'launched_and_focused' : 'launched',
    applicationId: record.id,
  };
});

ipcMain.handle('os:search-app-catalog', async (event, query: string) => {
  assertMainWindowSender(event.sender.id);
  const needle = String(query ?? '').trim().slice(0, 80);
  if (needle.length < 2) {
    return [];
  }
  const result = await runWinget([
    'search', '--query', needle, '--source', 'winget',
    '--accept-source-agreements', '--disable-interactivity',
  ], 45_000);
  return parseWingetSearch(result.stdout).slice(0, 24);
});

ipcMain.handle('os:install-catalog-application', async (event, packageId: string) => {
  assertMainWindowSender(event.sender.id);
  const id = String(packageId ?? '').trim();
  if (!/^[a-z0-9][a-z0-9._+-]{1,160}$/i.test(id)) {
    throw new Error('Invalid package identifier.');
  }
  const result = await runWinget([
    'install', '--id', id, '--exact', '--source', 'winget',
    '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity',
  ], 10 * 60_000);
  return { installed: true, output: result.stdout.slice(-4000) };
});

ipcMain.handle('bush:headers', (_, targetUrl: string, json = false) => {
  const headers: Record<string, string> = {};
  if (json) {
    headers['content-type'] = 'application/json';
  }
  const parsed = safeUrl(targetUrl);
  const localSecret = parsed != null && isLoopback(parsed.hostname)
    ? readLocalRequestSecret()
    : '';
  if (localSecret) {
    headers['X-Bush-Local-Key'] = localSecret;
  }
  const token = process.env.BUSH_API_AUTH_TOKEN?.trim();
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
});

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
    if (!stats?.isFile()) {
      return null;
    }
    return {
      path: targetPath,
      name: path.basename(targetPath),
      size: stats.size,
    };
  }));
  return inspected.filter((item) => item != null);
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

ipcMain.handle('dialog:pick-background-image', async () => {
  const options: OpenDialogOptions = {
    title: 'Choose background image',
    properties: ['openFile'],
    filters: [
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'ico'] },
      { name: 'All files', extensions: ['*'] },
    ],
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? null : result.filePaths[0] ?? null;
});

ipcMain.handle('dialog:cache-background-image', async (_, targetPath: string) => {
  return cacheBackgroundImage(String(targetPath ?? ''));
});

ipcMain.handle('project:list-root', (_, rootPath: string) => {
  return listProjectRoot(rootPath);
});

ipcMain.handle('project:validate-roots', (_, rootPaths: string[]) => {
  return inspectProjectRoots(Array.isArray(rootPaths) ? rootPaths : []);
});

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
  if (!sourceWindow || sourceWindow !== mainWindow) {
    return '';
  }
  return readLocalImageDataUrl(targetPath);
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
  if (sourceWindow !== mainWindow) {
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
  return openUiPreview(targetUrl);
});

ipcMain.handle('shell:open-ui-preview', (event, target: string) => {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender);
  if (sourceWindow !== mainWindow) {
    return;
  }
  return openUiPreview(target);
});

app.whenReady().then(async () => {
  if (process.platform === 'win32') {
    app.setAppUserModelId(cardbushAppUserModelId);
  }
  await applyProxySettings({
    mode: 'none',
    httpProxy: '',
    httpsProxy: '',
    noProxy: '',
  }).catch(() => undefined);
  const shortcutUpdated = ensureWindowsTaskbarShortcut();
  if (process.platform === 'win32') {
    const startupIcon = loadCardbushIconWithSource(256);
    appendDebugLog('taskbar', {
      stage: 'app-ready',
      appId: cardbushAppUserModelId,
      appName: app.getName(),
      packaged: app.isPackaged,
      execPath: process.execPath,
      appPath: app.getAppPath(),
      sourcePath: startupIcon.sourcePath,
      sourceExists:
        startupIcon.sourcePath !== 'generated-fallback' && fs.existsSync(startupIcon.sourcePath),
      iconSize: startupIcon.image.getSize(),
      shortcutUpdated,
    });
  }
  registerLocalFileProtocol();
  createWindow();
  createTray();
  void listOsApplicationsCached().catch(() => undefined);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      showMainWindow();
    }
  });
});

function registerLocalFileProtocol() {
  if (protocol.isProtocolHandled(localFileProtocol)) {
    return;
  }
  protocol.handle(localFileProtocol, async (request) => {
    try {
      const parsed = new URL(request.url);
      if (parsed.hostname.toLowerCase() === 'office-preview') {
        const officePath = normalizeShellPath(parsed.searchParams.get('path') ?? '');
        const stats = await fs.promises.stat(officePath);
        if (!stats.isFile() || !isOfficePreviewPath(officePath)) {
          return new Response('Not found', { status: 404 });
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

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('will-quit', () => {
  restoreWindowsTaskbar();
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
  const parsed = new URL(value);
  if (parsed.hostname.toLowerCase() === 'backgrounds') {
    return path.join(
      app.getPath('userData'),
      'backgrounds',
      path.basename(decodeURIComponent(parsed.pathname)),
    );
  }
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

async function cacheBackgroundImage(sourcePath: string) {
  const normalized = normalizeShellPath(sourcePath);
  const mimeType = imageMimeTypeForPath(normalized);
  if (!normalized || !mimeType) {
    throw new Error('Unsupported background image path');
  }
  const stats = await fs.promises.stat(normalized);
  if (!stats.isFile()) {
    throw new Error('Background image path is not a file');
  }
  const cacheDir = path.join(app.getPath('userData'), 'backgrounds');
  const relative = path.relative(cacheDir, normalized);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return normalized;
  }
  await fs.promises.mkdir(cacheDir, { recursive: true });
  const extension = path.extname(normalized).toLowerCase() || extensionForMimeType(mimeType);
  const hash = createHash('sha256')
    .update(await fs.promises.readFile(normalized))
    .digest('hex')
    .slice(0, 24);
  const targetPath = path.join(cacheDir, `background-${hash}${extension}`);
  if (fs.existsSync(targetPath)) {
    return targetPath;
  }
  await fs.promises.copyFile(normalized, targetPath);
  return targetPath;
}

function extensionForMimeType(mimeType: string) {
  if (mimeType === 'image/jpeg') {
    return '.jpg';
  }
  if (mimeType === 'image/png') {
    return '.png';
  }
  if (mimeType === 'image/webp') {
    return '.webp';
  }
  if (mimeType === 'image/gif') {
    return '.gif';
  }
  if (mimeType === 'image/bmp') {
    return '.bmp';
  }
  if (mimeType === 'image/x-icon') {
    return '.ico';
  }
  return '.img';
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

function readWallpaperAccent() {
  const fallback = normalizeAccent({ r: 99, g: 123, b: 97 });
  try {
    const wallpaperPath = currentWallpaperPath();
    if (!wallpaperPath) {
      return { ...fallback, source: 'fallback' };
    }
    const color = dominantColorFromImage(wallpaperPath);
    if (!color) {
      return { ...fallback, source: 'fallback' };
    }
    return {
      ...normalizeAccent(color),
      source: 'wallpaper',
    };
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
    throw new Error('OS integration is only available to the main CardBush window.');
  }
}

function osFilesystemLocations() {
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

async function listOsDirectory(targetPath?: string) {
  const normalized = normalizeShellPath(targetPath || app.getPath('home'));
  const stats = await fs.promises.stat(normalized);
  if (!stats.isDirectory()) {
    throw new Error('The selected path is not a directory.');
  }
  const entries = await fs.promises.readdir(normalized, { withFileTypes: true });
  const visible = entries
    .filter((entry) => entry.name !== '.' && entry.name !== '..')
    .slice(0, 600);
  const items = await Promise.all(
    visible.map(async (entry) => {
      const itemPath = path.join(normalized, entry.name);
      const itemStats = await fs.promises.stat(itemPath).catch(() => null);
      return {
        id: itemPath,
        name: entry.name,
        path: itemPath,
        kind: entry.isDirectory() ? 'directory' : 'file',
        extension: entry.isDirectory() ? '' : path.extname(entry.name).toLowerCase(),
        size: itemStats?.isFile() ? itemStats.size : 0,
        modifiedAt: itemStats?.mtime?.toISOString() ?? '',
        hidden: entry.name.startsWith('.'),
      };
    }),
  );
  items.sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === 'directory' ? -1 : 1;
    }
    return left.name.localeCompare(right.name, undefined, { numeric: true });
  });
  return {
    path: normalized,
    parentPath: path.dirname(normalized) === normalized ? '' : path.dirname(normalized),
    truncated: entries.length > visible.length,
    items,
  };
}

function startMenuRoots() {
  return [process.env.APPDATA, process.env.ProgramData]
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => path.resolve(value, 'Microsoft', 'Windows', 'Start Menu', 'Programs'))
    .filter((value, index, all) => fs.existsSync(value) && all.indexOf(value) === index);
}

function isStartMenuApplication(targetPath: string) {
  const target = path.resolve(targetPath).toLowerCase();
  const extension = path.extname(target).toLowerCase();
  return (
    extension === '.lnk' &&
    startMenuRoots().some((root) => target.startsWith(`${root.toLowerCase()}${path.sep}`))
  );
}

const ignoredStartMenuEntryPattern = new RegExp(
  [
    'uninstall',
    'unins(?:tall)?',
    'install(?:er)?',
    'update(?:r)?',
    'upgrade',
    'repair',
    'help',
    'documentation',
    'manuals?',
    'module docs?',
    'readme',
    'release notes?',
    'changelog',
    'licen[cs]e',
    'website',
    'faq',
    'administrative tools',
    'debuggable package manager',
    'error reporter',
    'language preferences',
    'node\.js command prompt',
    'send to',
    'vim tutor',
    '卸载',
    '安装',
    '升级',
    '更新',
    '修复',
    '帮助',
    '文档',
    '手册',
    '发送至',
    '语言首选项',
    '配置工具',
  ].join('|'),
  'i',
);

const launchableStartMenuTargetExtensions = new Set(['.exe', '.com', '.bat', '.cmd', '.msc']);
const ignoredStartMenuGroups = new Set([
  'accessibility',
  'accessories',
  'administrative tools',
  'system tools',
  'windows kits',
  'windows powershell',
]);

function startMenuGroupForShortcut(shortcutPath: string) {
  const resolvedShortcut = path.resolve(shortcutPath);
  for (const root of startMenuRoots()) {
    const relative = path.relative(root, resolvedShortcut);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
      const segments = relative.split(path.sep);
      return segments.length > 1 ? segments[0].trim().toLowerCase() : '';
    }
  }
  return '';
}

function resolvedStartMenuApplication(shortcutPath: string) {
  try {
    const details = shell.readShortcutLink(shortcutPath);
    const target = expandWindowsEnv(details.target?.trim() ?? '');
    const declaredIcon = expandWindowsEnv(details.icon?.trim() ?? '');
    const name = path.basename(shortcutPath, path.extname(shortcutPath)).trim();
    const targetExtension = path.extname(target).toLowerCase();
    const targetName = path.basename(target);
    const group = startMenuGroupForShortcut(shortcutPath);
    if (
      !name ||
      !target ||
      ignoredStartMenuGroups.has(group) ||
      !launchableStartMenuTargetExtensions.has(targetExtension) ||
      !fs.existsSync(target) ||
      ignoredStartMenuEntryPattern.test(name) ||
      ignoredStartMenuEntryPattern.test(targetName)
    ) {
      return null;
    }
    return {
      id: shortcutPath,
      name,
      path: shortcutPath,
      target,
      iconPath: declaredIcon && fs.existsSync(declaredIcon) ? declaredIcon : target,
      args: details.args?.trim() ?? '',
      source: 'start_menu' as const,
    };
  } catch {
    return null;
  }
}

async function listOsApplications() {
  const shortcuts: string[] = [];
  const stack = startMenuRoots();
  while (stack.length > 0 && shortcuts.length < 260) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    const entries = await fs.promises.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const itemPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(itemPath);
      } else if (isStartMenuApplication(itemPath)) {
        shortcuts.push(itemPath);
      }
    }
  }
  const recordsByTarget = new Map<string, NonNullable<ReturnType<typeof resolvedStartMenuApplication>>>();
  for (const shortcutPath of shortcuts) {
    const record = resolvedStartMenuApplication(shortcutPath);
    if (!record) {
      continue;
    }
    const key = path.resolve(record.target).toLowerCase();
    const current = recordsByTarget.get(key);
    if (!current || (current.args && !record.args) || record.name.length < current.name.length) {
      recordsByTarget.set(key, record);
    }
  }
  const records = [...recordsByTarget.values()]
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }))
    .slice(0, 120);
  const applications = await Promise.all(
    records.map(async (record) => {
      const iconImage = await app
        .getFileIcon(record.iconPath, { size: 'large' })
        .catch(() => nativeImage.createEmpty());
      const icon = iconImage.isEmpty() ? '' : iconImage.toDataURL();
      const iconSignature = iconImage.isEmpty()
        ? ''
        : createHash('sha1')
            .update(iconImage.resize({ width: 16, height: 16, quality: 'good' }).toBitmap())
            .digest('hex');
      const { target: _target, iconPath: _iconPath, args: _args, ...publicRecord } = record;
      return { ...publicRecord, icon, iconSignature };
    }),
  );
  const iconCounts = new Map<string, number>();
  for (const item of applications) {
    if (item.iconSignature) {
      iconCounts.set(item.iconSignature, (iconCounts.get(item.iconSignature) ?? 0) + 1);
    }
  }
  return applications.map(({ iconSignature, ...item }) => ({
    ...item,
    icon: item.icon && (iconCounts.get(iconSignature) ?? 0) < 3 ? item.icon : '',
  }));
}

function listOsApplicationsCached(forceRefresh = false) {
  if (!forceRefresh && osApplicationsCache) {
    return Promise.resolve(osApplicationsCache);
  }
  if (!forceRefresh && osApplicationsPending) {
    return osApplicationsPending;
  }
  const pending = listOsApplications()
    .then((applications) => {
      osApplicationsCache = applications;
      return applications;
    })
    .finally(() => {
      if (osApplicationsPending === pending) {
        osApplicationsPending = null;
      }
    });
  osApplicationsPending = pending;
  return pending;
}

async function listRunningOsApplications() {
  if (process.platform !== 'win32') {
    return [];
  }
  const applications = await listOsApplicationsCached();
  const executablePaths = await runningWindowsExecutablePaths();
  return applications.filter((application) => {
    const record = resolvedStartMenuApplication(application.id);
    return record ? executablePaths.has(path.resolve(record.target).toLowerCase()) : false;
  });
}

function runningWindowsExecutablePaths() {
  const source = `$ErrorActionPreference = 'SilentlyContinue'\n` +
    `Get-Process | ForEach-Object { try { if ($_.Path) { $_.Path } } catch {} } | ` +
    `Sort-Object -Unique`;
  return new Promise<Set<string>>((resolve) => {
    const child = spawnWindowsShellScript(source);
    let stdout = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(new Set(
      stdout
        .replace(/\r/g, '')
        .split('\n')
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => path.resolve(value).toLowerCase()),
      ));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish();
    }, 3500);
    child.stdout.on('data', (chunk) => {
      stdout = `${stdout}${String(chunk)}`.slice(-200_000);
    });
    child.once('error', () => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve(new Set<string>());
      }
    });
    child.once('close', () => {
      clearTimeout(timer);
      finish();
    });
  });
}

function runWinget(args: string[], timeoutMs: number) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn('winget.exe', args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('The application catalog request timed out.'));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout = `${stdout}${String(chunk)}`.slice(-200_000);
    });
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-20_000);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr.trim() || stdout.trim() || `winget exited with code ${code}`));
      }
    });
  });
}

const windowsShellBridgeSource = String.raw`
using System;
using System.Runtime.InteropServices;
public static class CardBushWindowsShell {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int Size; public RECT Monitor; public RECT Work; public uint Flags; }
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr FindWindow(string className, string windowName);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool ShowWindow(IntPtr handle, int command);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetForegroundWindow(IntPtr handle);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool BringWindowToTop(IntPtr handle);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", SetLastError=true)] public static extern bool IsIconic(IntPtr handle);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool IsZoomed(IntPtr handle);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool PostMessage(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr MonitorFromWindow(IntPtr handle, uint flags);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetWindowPos(IntPtr handle, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
  public static bool FitOsWorkspace(IntPtr handle) {
    IntPtr monitor = MonitorFromWindow(handle, 2);
    MONITORINFO info = new MONITORINFO(); info.Size = Marshal.SizeOf(typeof(MONITORINFO));
    if (monitor == IntPtr.Zero || !GetMonitorInfo(monitor, ref info)) return false;
    const int topInset = 48;
    const int bottomInset = 8;
    return SetWindowPos(handle, IntPtr.Zero, info.Monitor.Left, info.Monitor.Top + topInset,
      info.Monitor.Right - info.Monitor.Left,
      info.Monitor.Bottom - info.Monitor.Top - topInset - bottomInset,
      0x0064);
  }
}`;

function encodedPowerShell(source: string) {
  return Buffer.from(source, 'utf16le').toString('base64');
}

function spawnWindowsShellScript(source: string, env?: NodeJS.ProcessEnv) {
  const utf8Source =
    `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n` +
    `$OutputEncoding = [Console]::OutputEncoding\n` +
    source;
  return spawn('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', encodedPowerShell(utf8Source),
  ], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
}

function runWindowsShellScript(source: string, timeoutMs = 4500) {
  return new Promise<string>((resolve, reject) => {
    const child = spawnWindowsShellScript(source);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(stdout.trim());
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('Windows desktop request timed out.'));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout = `${stdout}${String(chunk)}`.slice(-300_000);
    });
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-30_000);
    });
    child.once('error', (error) => finish(error));
    child.once('close', (code) => {
      if (code === 0) finish();
      else finish(new Error(stderr.trim() || `Windows desktop request exited with code ${code}`));
    });
  });
}

async function listOsWindows() {
  if (process.platform !== 'win32') return [];
  const source = `Add-Type -TypeDefinition @'\n${windowsShellBridgeSource}\n'@\n` +
    `$selfPid = ${process.pid}\n` +
    `$ignored = @('ApplicationFrameHost','TextInputHost','ShellExperienceHost','StartMenuExperienceHost','SearchHost','LockApp')\n` +
    `$items = Get-Process -ErrorAction SilentlyContinue | Where-Object { ` +
    `$_.Id -ne $selfPid -and $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -and ` +
    `$ignored -notcontains $_.ProcessName -and $_.MainWindowTitle -ne 'Program Manager' ` +
    `} | ForEach-Object { ` +
    `$handle = $_.MainWindowHandle; $processPath = ''; ` +
    `try { $processPath = $_.Path } catch {}; ` +
    `[PSCustomObject]@{ ` +
    `id = ($_.Id.ToString() + ':' + $handle.ToString()); ` +
    `process_id = $_.Id; handle = $handle.ToInt64(); title = $_.MainWindowTitle; ` +
    `process_name = $_.ProcessName; path = $processPath; ` +
    `minimized = [CardBushWindowsShell]::IsIconic($handle); ` +
    `maximized = [CardBushWindowsShell]::IsZoomed($handle) } ` +
    `}\n$items | ConvertTo-Json -Compress`;
  const output = await runWindowsShellScript(source);
  if (!output) return [];
  const decoded: unknown = JSON.parse(output);
  const records = (Array.isArray(decoded) ? decoded : [decoded]) as Array<Record<string, unknown>>;
  return Promise.all(records.slice(0, 40).map(async (record) => {
    const executablePath = typeof record.path === 'string' ? record.path : '';
    const iconImage = executablePath
      ? await app.getFileIcon(executablePath, { size: 'large' }).catch(() => nativeImage.createEmpty())
      : nativeImage.createEmpty();
    return {
      id: String(record.id ?? ''),
      processId: Number(record.process_id ?? 0),
      handle: Number(record.handle ?? 0),
      title: String(record.title ?? ''),
      processName: String(record.process_name ?? ''),
      minimized: record.minimized === true,
      maximized: record.maximized === true,
      icon: iconImage.isEmpty() ? '' : iconImage.toDataURL(),
    };
  }));
}

async function controlOsWindow(
  windowId: string,
  action: 'focus' | 'minimize' | 'maximize' | 'restore' | 'close',
) {
  if (process.platform !== 'win32') throw new Error('Window control is unavailable.');
  if (!/^[1-9]\d{0,9}:[1-9]\d{0,19}$/.test(windowId)) {
    throw new Error('Invalid window identifier.');
  }
  const [processId, handle] = windowId.split(':');
  const allowedActions = new Set(['focus', 'minimize', 'maximize', 'restore', 'close']);
  if (!allowedActions.has(action)) throw new Error('Unsupported window action.');
  const source = `Add-Type -TypeDefinition @'\n${windowsShellBridgeSource}\n'@\n` +
    `$process = Get-Process -Id ${processId} -ErrorAction Stop\n` +
    `$handle = [IntPtr]${handle}\n` +
    `if ($process.MainWindowHandle -ne $handle) { throw 'Window target is stale.' }\n` +
    (action === 'close'
      ? `[void][CardBushWindowsShell]::PostMessage($handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)\n`
      : action === 'minimize'
        ? `[void][CardBushWindowsShell]::ShowWindow($handle, 6)\n`
      : action === 'maximize'
          ? `[void][CardBushWindowsShell]::ShowWindow($handle, 9)\n` +
            `[void][CardBushWindowsShell]::FitOsWorkspace($handle)\n`
          : action === 'restore'
            ? `[void][CardBushWindowsShell]::ShowWindow($handle, 9)\n`
            : `[void][CardBushWindowsShell]::ShowWindow($handle, 9)\n` +
              `[void][CardBushWindowsShell]::FitOsWorkspace($handle)\n` +
            `[void][CardBushWindowsShell]::BringWindowToTop($handle)\n` +
            `$activated = [CardBushWindowsShell]::SetForegroundWindow($handle)\n` +
            `if (-not $activated) { try { $activated = (New-Object -ComObject WScript.Shell).AppActivate($process.Id) } catch {} }\n` +
            `Start-Sleep -Milliseconds 120\n` +
            `[void][CardBushWindowsShell]::FitOsWorkspace($handle)\n`);
  await runWindowsShellScript(source);
  return { ok: true, windowId, action };
}

function taskbarVisibilityBody(show: boolean) {
  return `$command = ${show ? '5' : '0'}\n` +
    `@('Shell_TrayWnd','Shell_SecondaryTrayWnd') | ForEach-Object { ` +
    `$handle = [CardBushWindowsShell]::FindWindow($_, $null); ` +
    `if ($handle -ne [IntPtr]::Zero) { [void][CardBushWindowsShell]::ShowWindow($handle, $command) } }`;
}

function taskbarVisibilityScript(show: boolean) {
  return `Add-Type -TypeDefinition @'\n${windowsShellBridgeSource}\n'@\n${taskbarVisibilityBody(show)}`;
}

function hideWindowsTaskbarWithWatchdog() {
  if (process.platform !== 'win32') {
    return;
  }
  if (osTaskbarWatchdog && osTaskbarWatchdog.exitCode == null) {
    const child = spawnWindowsShellScript(taskbarVisibilityScript(false));
    child.unref();
    return;
  }
  const source = `Add-Type -TypeDefinition @'\n${windowsShellBridgeSource}\n'@\n` +
    `${taskbarVisibilityBody(false)}\n` +
    `try { Wait-Process -Id ${process.pid} -ErrorAction SilentlyContinue } finally {\n` +
    `${taskbarVisibilityBody(true)}\n}`;
  osTaskbarWatchdog = spawnWindowsShellScript(source);
  osTaskbarWatchdog.once('exit', () => {
    osTaskbarWatchdog = null;
  });
  osTaskbarWatchdog.unref();
}

function restoreWindowsTaskbar() {
  if (process.platform !== 'win32') {
    return;
  }
  const child = spawnWindowsShellScript(taskbarVisibilityScript(true));
  child.unref();
}

function focusExistingWindowsApplication(executablePath: string) {
  if (process.platform !== 'win32' || !executablePath) {
    return Promise.resolve(false);
  }
  const source = `Add-Type -TypeDefinition @'\n${windowsShellBridgeSource}\n'@\n` +
    `$target = $env:CARDBUSH_TARGET_EXE\n` +
    `$process = Get-Process -ErrorAction SilentlyContinue | Where-Object { ` +
    `$_.MainWindowHandle -ne 0 -and $_.Path -and $_.Path.Equals($target, [StringComparison]::OrdinalIgnoreCase) ` +
    `} | Sort-Object StartTime | Select-Object -First 1\n` +
    `if ($process) { $handle = $process.MainWindowHandle; ` +
    `[void][CardBushWindowsShell]::ShowWindow($handle, 9); ` +
    `[void][CardBushWindowsShell]::FitOsWorkspace($handle); ` +
    `[void][CardBushWindowsShell]::BringWindowToTop($handle); ` +
    `$activated = [CardBushWindowsShell]::SetForegroundWindow($handle); ` +
    `if (-not $activated) { try { $activated = (New-Object -ComObject WScript.Shell).AppActivate($process.Id) } catch {} }; ` +
    `Start-Sleep -Milliseconds 120; ` +
    `[void][CardBushWindowsShell]::FitOsWorkspace($handle); ` +
    `if ($activated -or [CardBushWindowsShell]::GetForegroundWindow() -eq $handle) { Write-Output 'focused' } }`;
  return new Promise<boolean>((resolve) => {
    const child = spawnWindowsShellScript(source, { CARDBUSH_TARGET_EXE: executablePath });
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 3500);
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once('close', () => {
      clearTimeout(timer);
      resolve(stdout.includes('focused'));
    });
  });
}

function parseWingetSearch(output: string) {
  const lines = output.replace(/\r/g, '').split('\n');
  const separatorIndex = lines.findIndex((line) => /^\s*-{3,}/.test(line));
  if (separatorIndex < 1) {
    return [];
  }
  return lines.slice(separatorIndex + 1)
    .filter((line) => line.trim())
    .map((line) => line.trim().split(/\s{2,}/))
    .filter((columns) => columns.length >= 3)
    .map((columns) => ({
      name: columns[0],
      id: columns[1],
      version: columns[2],
      source: 'winget',
    }))
    .filter((item) => item.name && /^[a-z0-9][a-z0-9._+-]{1,160}$/i.test(item.id));
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

function readLocalRequestSecret() {
  const envSecret = process.env.BUSH_LOCAL_REQUEST_SECRET?.trim();
  if (envSecret) {
    return envSecret;
  }
  const secretPath = localRequestSecretPath();
  if (secretPath == null) {
    return '';
  }
  try {
    return fs.readFileSync(secretPath, 'utf8').trim();
  } catch {
    return '';
  }
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

function localRequestSecretPath() {
  const override = process.env.BUSH_LOCAL_REQUEST_SECRET_PATH?.trim();
  if (override) {
    return override;
  }
  if (process.platform === 'win32') {
    const root = process.env.LOCALAPPDATA || process.env.APPDATA;
    return root ? path.join(root, 'bushserver', 'config', 'local_request_secret') : null;
  }
  return path.join(os.homedir(), '.local', 'share', 'bushserver', 'config', 'local_request_secret');
}
