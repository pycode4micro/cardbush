import {
  app,
  BrowserWindow,
  desktopCapturer,
  Menu,
  nativeTheme,
  Tray,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  screen,
  session,
  shell,
  type OpenDialogOptions,
} from 'electron';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const devServerUrl = process.env.CARDBUSH_ELECTRON_DEV_SERVER_URL?.trim();
const logoAssetNames = ['cardbush-logo.png', 'cardbush-logo-backup.png'];
const cardlingCollapsedSize = { width: 104, height: 104 };
const cardlingExpandedSize = { width: 324, height: 360 };
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

let mainWindow: BrowserWindow | null = null;
let cardlingWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let startupRevealFallback: ReturnType<typeof setTimeout> | null = null;
let cardlingExpanded = false;
let lastCardlingState: CardlingDesktopState | null = null;
const terminalSessions = new Map<
  string,
  {
    process: ChildProcessWithoutNullStreams;
    ownerId: number;
    cwd: string;
  }
>();

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

type ProjectFileSearchResult = {
  name: string;
  path: string;
  relativePath: string;
  kind: 'file' | 'folder';
};

function createWindow() {
  if (startupRevealFallback != null) {
    clearTimeout(startupRevealFallback);
    startupRevealFallback = null;
  }
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 960,
    minHeight: 620,
    frame: false,
    title: 'cardbush',
    icon: loadCardbushIcon(256),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1A1A1A' : '#F5F3EF',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  startupRevealFallback = setTimeout(() => {
    if (mainWindow != null && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show();
    }
  }, 5000);

  mainWindow.once('closed', () => {
    if (startupRevealFallback != null) {
      clearTimeout(startupRevealFallback);
      startupRevealFallback = null;
    }
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  loadRenderer(mainWindow, 'main');
}

function createCardlingWindow() {
  if (cardlingWindow != null && !cardlingWindow.isDestroyed()) {
    return cardlingWindow;
  }
  const size = cardlingExpanded ? cardlingExpandedSize : cardlingCollapsedSize;
  const bounds = cardlingBoundsForSize(size);
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
    title: 'Cardling',
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
  cardlingWindow.on('moved', () => saveCardlingAnchor());
  cardlingWindow.on('blur', () => {
    if (!cardlingExpanded || cardlingWindow == null || cardlingWindow.isDestroyed()) {
      return;
    }
    cardlingWindow.webContents.send('cardling:collapse');
  });
  cardlingWindow.on('closed', () => {
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
    if (mode === 'cardling') {
      url.searchParams.set('window', 'cardling');
    }
    target.loadURL(url.toString());
    return;
  }
  const indexPath = path.join(__dirname, '../dist/index.html');
  if (mode === 'cardling') {
    target.loadFile(indexPath, { query: { window: 'cardling' } });
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
      payload.theme === 'bright' || payload.theme === 'parchment' || payload.theme === 'dark'
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
  };
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

function resizeCardlingWindow(expanded: boolean) {
  if (cardlingWindow == null || cardlingWindow.isDestroyed()) {
    return;
  }
  const current = cardlingWindow.getBounds();
  const size = expanded ? cardlingExpandedSize : cardlingCollapsedSize;
  const next = ensureBoundsInDisplay({
    width: size.width,
    height: size.height,
    x: current.x + current.width - size.width,
    y: current.y + current.height - size.height,
  });
  cardlingWindow.setBounds(next, false);
  saveCardlingAnchor(next);
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
  const display =
    screen.getDisplayMatching(bounds) ||
    screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y }) ||
    screen.getPrimaryDisplay();
  const area = display.workArea;
  return {
    width: bounds.width,
    height: bounds.height,
    x: Math.max(area.x, Math.min(area.x + area.width - bounds.width, bounds.x)),
    y: Math.max(area.y, Math.min(area.y + area.height - bounds.height, bounds.y)),
  };
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
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('double-click', () => showMainWindow());
}

function loadCardbushIcon(size: number) {
  for (const fileName of logoAssetNames) {
    const image = nativeImage.createFromPath(path.join(__dirname, '../assets', fileName));
    if (!image.isEmpty()) {
      return image.resize({ width: size, height: size, quality: 'best' });
    }
  }
  return nativeImage.createFromDataURL(
    'data:image/svg+xml;utf8,' +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="8" fill="#637B61"/><path d="M10 21c6 0 10-4 12-11-7 2-11 6-12 11Z" fill="#F1E6CF"/></svg>',
      ),
  );
}

function showMainWindow() {
  if (mainWindow == null) {
    createWindow();
    return;
  }
  mainWindow.show();
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

ipcMain.handle('app:renderer-ready', (event) => {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender);
  if (sourceWindow !== mainWindow || sourceWindow == null || sourceWindow.isDestroyed()) {
    return;
  }
  if (startupRevealFallback != null) {
    clearTimeout(startupRevealFallback);
    startupRevealFallback = null;
  }
  sourceWindow.show();
});

ipcMain.handle('appearance:wallpaper-accent', () => {
  return readWallpaperAccent();
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
      mode: 'system' | 'manual';
      httpProxy: string;
      httpsProxy: string;
      noProxy: string;
    },
  ) => {
    await applyProxySettings(proxy);
  },
);

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

ipcMain.handle('project:list-root', (_, rootPath: string) => {
  return listProjectRoot(rootPath);
});

ipcMain.handle('project:search-files', (_, rootPath: string, query: string) => {
  return searchProjectFiles(rootPath, query);
});

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

ipcMain.handle('terminal:create', (event, cwd?: string) => {
  return createTerminalSession(event.sender.id, cwd);
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

ipcMain.handle('terminal:run', (_, command: string, cwd?: string) => {
  return runTerminalCommand(command, cwd);
});

ipcMain.handle('screenshot:capture', (_, options?: { hideWindow?: boolean }) => {
  return capturePrimaryDisplay(options?.hideWindow ?? false);
});

ipcMain.handle('screenshot:save-edited', (_, dataUrl: string, name?: string) => {
  return saveScreenshotDataUrl(dataUrl, name);
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
  cardlingWindow.setFocusable(expanded);
  resizeCardlingWindow(expanded);
  if (expanded) {
    cardlingWindow.focus();
  }
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
  cardlingWindow.setBounds(next, false);
  saveCardlingAnchor(next);
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
    const size = cardlingExpanded ? cardlingExpandedSize : cardlingCollapsedSize;
    const bounds = cardlingBoundsForSize(size);
    cardlingWindow.setBounds(bounds, false);
    saveCardlingAnchor(bounds);
  }
});

ipcMain.handle('cardling:action', (event, action: CardlingDesktopAction) => {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender);
  if (sourceWindow !== cardlingWindow || mainWindow == null || mainWindow.isDestroyed()) {
    return;
  }
  showMainWindow();
  mainWindow.webContents.send('cardling:action', action);
});

ipcMain.handle('shell:open-path', (_, targetPath: string) => {
  return shell.openPath(targetPath);
});

ipcMain.handle('shell:open-external', (_, targetUrl: string) => {
  return shell.openExternal(targetUrl);
});

app.whenReady().then(() => {
  createWindow();
  createTray();
  registerGlobalShortcuts();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      showMainWindow();
    }
  });
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
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

async function applyProxySettings(proxy: {
  mode: 'system' | 'manual';
  httpProxy: string;
  httpsProxy: string;
  noProxy: string;
}) {
  if (proxy.mode === 'system') {
    await session.defaultSession.setProxy({ mode: 'system' });
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
  const local = runGit(root, ['branch', '--format=%(refname:short)'])
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^\*\s*/, ''))
    .filter(Boolean);
  const remote = runGit(root, ['branch', '-r', '--format=%(refname:short)'])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.includes('->'))
    .map((line) => line.replace(/^origin\//, ''))
    .filter(Boolean);
  return [...new Set([...local, ...remote])].sort((left, right) =>
    left.localeCompare(right),
  );
}

function checkoutGitBranch(rootPath: string, branch: string) {
  const root = requireGitRoot(rootPath);
  const target = normalizeGitName(branch, 'branch');
  const output = runGit(root, ['switch', target]);
  const info = readGitInfo(root);
  return {
    branch: info.branch,
    output: output.trim() || `Switched to ${target}`,
  };
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
  const root = requireGitRoot(rootPath);
  const patch = buildReversePatchInput(root, files);
  if (!patch.trim()) {
    throw new Error('No patch content was provided.');
  }
  runGitWithInput(root, ['apply', '--reverse', '--check', '--whitespace=nowarn'], patch);
  const output = runGitWithInput(
    root,
    ['apply', '--reverse', '--whitespace=nowarn'],
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
  const root = path.resolve(rootPath);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`Project directory does not exist: ${root}`);
  }
  runGit(root, ['rev-parse', '--is-inside-work-tree']);
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

function createTerminalSession(ownerId: number, cwd?: string) {
  const workingDirectory = resolveCwd(cwd);
  const shellInfo = terminalShell();
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

function terminalShell() {
  const override = process.env.CARDBUSH_TERMINAL_SHELL?.trim();
  if (override) {
    return { command: override, args: [] };
  }
  if (process.platform === 'win32') {
    const pwsh = findExecutable('pwsh.exe');
    if (pwsh) {
      return { command: pwsh, args: [] };
    }
    return { command: 'powershell.exe', args: ['-NoExit'] };
  }
  const shellCommand = process.env.SHELL?.trim() || 'sh';
  return { command: shellCommand, args: [] };
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

function runTerminalCommand(command: string, cwd?: string) {
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
    const shellCommand = process.platform === 'win32' ? 'powershell.exe' : 'sh';
    const args = process.platform === 'win32'
      ? ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', trimmed]
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

async function capturePrimaryDisplay(hideWindow: boolean) {
  const wasVisible = mainWindow?.isVisible() ?? false;
  if (hideWindow && mainWindow) {
    mainWindow.hide();
    await delay(180);
  }
  try {
    const display = screen.getPrimaryDisplay();
    const scaleFactor = display.scaleFactor || 1;
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(display.size.width * scaleFactor),
        height: Math.round(display.size.height * scaleFactor),
      },
    });
    const source = sources.find((item) => item.display_id === String(display.id)) ?? sources[0];
    if (!source) {
      throw new Error('No screen source is available');
    }
    const image = source.thumbnail;
    const screenshotsDir = path.join(app.getPath('pictures'), 'cardbush-screenshots');
    fs.mkdirSync(screenshotsDir, { recursive: true });
    const fileName = `cardbush-screenshot-${timestampForFile()}.png`;
    const filePath = path.join(screenshotsDir, fileName);
    fs.writeFileSync(filePath, image.toPNG());
    return {
      path: filePath,
      name: fileName,
      width: image.getSize().width,
      height: image.getSize().height,
      dataUrl: image.toDataURL(),
      windows: await captureWindowThumbnails(screenshotsDir),
    };
  } finally {
    if (hideWindow && wasVisible) {
      showMainWindow();
    }
  }
}

async function captureWindowThumbnails(screenshotsDir: string) {
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 960, height: 640 },
  });
  return sources
    .filter((source) => !source.thumbnail.isEmpty())
    .slice(0, 12)
    .map((source, index) => {
      const image = source.thumbnail;
      const safeName = sanitizeFilePart(source.name || `window-${index + 1}`);
      const fileName = `cardbush-window-${timestampForFile()}-${index + 1}-${safeName}.png`;
      const filePath = path.join(screenshotsDir, fileName);
      fs.writeFileSync(filePath, image.toPNG());
      return {
        id: source.id,
        name: source.name || `Window ${index + 1}`,
        path: filePath,
        width: image.getSize().width,
        height: image.getSize().height,
        dataUrl: image.toDataURL(),
      };
    });
}

function saveScreenshotDataUrl(dataUrl: string, name?: string) {
  const match = dataUrl.match(/^data:image\/(png|jpe?g|webp|gif|bmp);base64,(.+)$/i);
  if (!match) {
    throw new Error('Invalid image data URL');
  }
  const extension = imageExtension(match[1]);
  const screenshotsDir = path.join(app.getPath('pictures'), 'cardbush-screenshots');
  fs.mkdirSync(screenshotsDir, { recursive: true });
  const fileName = `${sanitizeFilePart(name || 'cardbush-screenshot-edited')}-${timestampForFile()}.${extension}`;
  const filePath = path.join(screenshotsDir, fileName);
  fs.writeFileSync(filePath, Buffer.from(match[2], 'base64'));
  const image = nativeImage.createFromPath(filePath);
  return {
    path: filePath,
    name: fileName,
    width: image.getSize().width,
    height: image.getSize().height,
  };
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
    .replace(/^-|-$/g, '') || 'screenshot';
}

function registerGlobalShortcuts() {
  globalShortcut.register('Alt+A', () => {
    mainWindow?.webContents.send('screenshot:trigger');
  });
}

function timestampForFile() {
  return new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .replace('Z', '');
}

function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
