import {
  BrowserWindow,
  globalShortcut,
  screen,
  type Display,
} from 'electron';

export type DesktopControlTurn = {
  sessionId: string;
  turnId: string;
  toolCallId: string;
};

type DesktopControlScope = Pick<DesktopControlTurn, 'sessionId' | 'turnId'> & {
  toolCallId?: string;
};

type DesktopControlOverlayOptions = {
  onCancel: (turn: DesktopControlTurn) => void | Promise<void>;
  onDiagnostic?: (event: string, details?: Record<string, unknown>) => void;
};

const cursorWindowSize = 68;
const cursorPollIntervalMs = 24;

export class DesktopControlOverlay {
  readonly #onCancel: DesktopControlOverlayOptions['onCancel'];
  readonly #onDiagnostic?: DesktopControlOverlayOptions['onDiagnostic'];
  #activeTurn: DesktopControlTurn | null = null;
  #overlayWindows: BrowserWindow[] = [];
  #cursorWindow: BrowserWindow | null = null;
  #cursorTimer: ReturnType<typeof setInterval> | null = null;
  #escapeAccelerator: string | null = null;
  #displayListenersAttached = false;

  constructor(options: DesktopControlOverlayOptions) {
    this.#onCancel = options.onCancel;
    this.#onDiagnostic = options.onDiagnostic;
  }

  show(turn: DesktopControlTurn): void {
    if (sameTurn(this.#activeTurn, turn)) return;
    this.hide();
    this.#activeTurn = { ...turn };
    this.#attachDisplayListeners();
    this.#rebuildWindows();
    this.#registerEscape();
    this.#startCursorTracking();
    this.#onDiagnostic?.('shown', { ...turn });
  }

  hide(turn?: DesktopControlScope): void {
    if (turn && !sameTurn(this.#activeTurn, turn)) return;
    const hiddenTurn = this.#activeTurn;
    this.#activeTurn = null;
    this.#unregisterEscape();
    this.#stopCursorTracking();
    this.#destroyWindows();
    if (hiddenTurn) this.#onDiagnostic?.('hidden', { ...hiddenTurn });
  }

  dispose(): void {
    this.hide();
    this.#detachDisplayListeners();
  }

  #registerEscape(): void {
    const cancel = () => {
      const turn = this.#activeTurn;
      if (!turn) return;
      this.#onDiagnostic?.('escape_pressed', { ...turn });
      this.hide(turn);
      void Promise.resolve(this.#onCancel(turn)).catch((error: unknown) => {
        this.#onDiagnostic?.('cancel_failed', {
          ...turn,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    };
    for (const accelerator of ['Esc', 'Escape']) {
      try {
        if (globalShortcut.register(accelerator, cancel)) {
          this.#escapeAccelerator = accelerator;
          return;
        }
      } catch {
        // Try Electron's alternate spelling below.
      }
    }
    this.#onDiagnostic?.('escape_registration_failed');
  }

  #unregisterEscape(): void {
    if (!this.#escapeAccelerator) return;
    globalShortcut.unregister(this.#escapeAccelerator);
    this.#escapeAccelerator = null;
  }

  #rebuildWindows = (): void => {
    if (!this.#activeTurn) return;
    this.#destroyWindows();
    const displays = screen.getAllDisplays();
    const statusDisplayId = screen.getDisplayNearestPoint(
      screen.getCursorScreenPoint(),
    ).id;
    this.#overlayWindows = displays.map((display) =>
      this.#createOverlayWindow(display, display.id === statusDisplayId),
    );
    this.#cursorWindow = this.#createCursorWindow();
    this.#updateCursorPosition();
  };

  #createOverlayWindow(display: Display, showStatus: boolean): BrowserWindow {
    const window = new BrowserWindow({
      ...display.bounds,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      show: false,
      focusable: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    window.setIgnoreMouseEvents(true);
    window.setContentProtection(true);
    window.setAlwaysOnTop(true, 'screen-saver');
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    void window.loadURL(htmlDataUrl(overlayHtml(showStatus))).then(() => {
      if (!window.isDestroyed() && this.#activeTurn) window.showInactive();
    }).catch((error: unknown) => {
      this.#onDiagnostic?.('overlay_load_failed', {
        displayId: display.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return window;
  }

  #createCursorWindow(): BrowserWindow {
    const window = new BrowserWindow({
      width: cursorWindowSize,
      height: cursorWindowSize,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      show: false,
      focusable: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    window.setIgnoreMouseEvents(true);
    window.setContentProtection(true);
    window.setAlwaysOnTop(true, 'screen-saver');
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    void window.loadURL(htmlDataUrl(cursorHtml())).then(() => {
      if (!window.isDestroyed() && this.#activeTurn) window.showInactive();
    }).catch((error: unknown) => {
      this.#onDiagnostic?.('cursor_load_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return window;
  }

  #startCursorTracking(): void {
    this.#stopCursorTracking();
    this.#cursorTimer = setInterval(
      () => this.#updateCursorPosition(),
      cursorPollIntervalMs,
    );
  }

  #stopCursorTracking(): void {
    if (this.#cursorTimer) clearInterval(this.#cursorTimer);
    this.#cursorTimer = null;
  }

  #updateCursorPosition(): void {
    const window = this.#cursorWindow;
    if (!window || window.isDestroyed()) return;
    const point = screen.getCursorScreenPoint();
    window.setPosition(
      Math.round(point.x - cursorWindowSize / 2),
      Math.round(point.y - cursorWindowSize / 2),
      false,
    );
  }

  #destroyWindows(): void {
    for (const window of this.#overlayWindows) {
      if (!window.isDestroyed()) window.destroy();
    }
    this.#overlayWindows = [];
    if (this.#cursorWindow && !this.#cursorWindow.isDestroyed()) {
      this.#cursorWindow.destroy();
    }
    this.#cursorWindow = null;
  }

  #attachDisplayListeners(): void {
    if (this.#displayListenersAttached) return;
    screen.on('display-added', this.#rebuildWindows);
    screen.on('display-removed', this.#rebuildWindows);
    screen.on('display-metrics-changed', this.#rebuildWindows);
    this.#displayListenersAttached = true;
  }

  #detachDisplayListeners(): void {
    if (!this.#displayListenersAttached) return;
    screen.off('display-added', this.#rebuildWindows);
    screen.off('display-removed', this.#rebuildWindows);
    screen.off('display-metrics-changed', this.#rebuildWindows);
    this.#displayListenersAttached = false;
  }
}

function sameTurn(left: DesktopControlTurn | null, right: DesktopControlScope): boolean {
  return left?.sessionId === right.sessionId &&
    left.turnId === right.turnId &&
    (right.toolCallId === undefined || left.toolCallId === right.toolCallId);
}

function htmlDataUrl(html: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function overlayHtml(showStatus: boolean): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <style>
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
    body {
      background: rgba(11, 15, 24, 0.13);
      box-shadow: inset 0 0 120px rgba(52, 119, 255, 0.08);
      font-family: "Segoe UI Variable", "Microsoft YaHei UI", sans-serif;
      user-select: none;
    }
    .status {
      position: absolute;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
      min-width: 286px;
      display: ${showStatus ? 'flex' : 'none'};
      align-items: center;
      gap: 13px;
      padding: 13px 17px;
      color: #f8fafc;
      background: rgba(19, 22, 31, 0.91);
      border: 1px solid rgba(255, 255, 255, 0.16);
      border-radius: 18px;
      box-shadow: 0 18px 56px rgba(0, 0, 0, 0.32), 0 0 0 1px rgba(64, 137, 255, 0.08);
      backdrop-filter: blur(18px) saturate(1.18);
    }
    .brand {
      width: 38px;
      height: 38px;
      flex: none;
      display: grid;
      grid-template-columns: repeat(2, 8px);
      grid-template-rows: repeat(2, 8px);
      place-content: center;
      gap: 5px;
      border-radius: 12px;
      background: linear-gradient(145deg, rgba(255,255,255,.13), rgba(255,255,255,.05));
      box-shadow: inset 0 0 0 1px rgba(255,255,255,.06);
    }
    .brand i { width: 8px; height: 8px; border-radius: 50%; animation: breathe 1.55s ease-in-out infinite; }
    .brand i:nth-child(1) { background: #4f8cff; }
    .brand i:nth-child(2) { background: #34c995; animation-delay: .15s; }
    .brand i:nth-child(3) { background: #7868ee; animation-delay: .3s; }
    .brand i:nth-child(4) { background: #3d82ef; animation-delay: .45s; }
    .copy { min-width: 0; flex: 1; }
    .title { font-size: 14px; line-height: 20px; font-weight: 650; letter-spacing: .1px; }
    .hint { margin-top: 2px; color: rgba(241,245,249,.64); font-size: 12px; line-height: 17px; }
    kbd {
      margin-left: 9px;
      padding: 3px 7px;
      color: rgba(255,255,255,.82);
      background: rgba(255,255,255,.09);
      border: 1px solid rgba(255,255,255,.13);
      border-radius: 7px;
      font: 11px/16px "Segoe UI Variable", sans-serif;
    }
    @keyframes breathe { 0%,100% { opacity:.72; transform:scale(.88); } 50% { opacity:1; transform:scale(1.08); } }
    @media (prefers-reduced-motion: reduce) { .brand i { animation: none; } }
  </style>
</head>
<body>
  <div class="status" role="status" aria-live="polite">
    <span class="brand"><i></i><i></i><i></i><i></i></span>
    <span class="copy"><span class="title">CardBush 正在控制</span><span class="hint">请暂时不要操作鼠标和键盘</span></span>
    <kbd>Esc 取消</kbd>
  </div>
</body>
</html>`;
}

function cursorHtml(): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <style>
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; }
    .halo {
      position: absolute;
      left: 12px;
      top: 12px;
      width: 44px;
      height: 44px;
      border: 2px solid rgba(80, 148, 255, .92);
      border-radius: 50%;
      box-shadow: 0 0 0 5px rgba(73, 135, 255, .16), 0 6px 22px rgba(22, 91, 221, .34);
      animation: cursorPulse 1.25s ease-in-out infinite;
    }
    .mark {
      position: absolute;
      right: 4px;
      bottom: 4px;
      width: 22px;
      height: 22px;
      display: grid;
      grid-template-columns: repeat(2, 4px);
      grid-template-rows: repeat(2, 4px);
      place-content: center;
      gap: 3px;
      border-radius: 8px;
      background: rgba(20, 24, 34, .94);
      border: 1px solid rgba(255,255,255,.18);
      box-shadow: 0 4px 12px rgba(0,0,0,.3);
    }
    .mark i { width:4px; height:4px; border-radius:50%; }
    .mark i:nth-child(1) { background:#4f8cff; } .mark i:nth-child(2) { background:#34c995; }
    .mark i:nth-child(3) { background:#7868ee; } .mark i:nth-child(4) { background:#3d82ef; }
    @keyframes cursorPulse { 0%,100% { transform:scale(.92); opacity:.76; } 50% { transform:scale(1.04); opacity:1; } }
    @media (prefers-reduced-motion: reduce) { .halo { animation:none; } }
  </style>
</head>
<body><span class="halo"></span><span class="mark"><i></i><i></i><i></i><i></i></span></body>
</html>`;
}
