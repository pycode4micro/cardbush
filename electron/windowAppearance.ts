import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';

// Keep the menu in the existing title bar, with Windows owning caption controls
// and their non-client hit testing (including maximize hover / Snap Layouts).
export function mainWindowFrameOptions(platform: string): Pick<BrowserWindowConstructorOptions,
  'frame' | 'titleBarStyle' | 'titleBarOverlay'> {
  return platform === 'win32' ? {
    frame: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#eeeeee', height: 36 },
  } : { frame: false };
}

export type WindowTheme = 'bright' | 'dark' | 'cyberpunk';
export type WindowMaterialPreference = 'auto' | 'solid';
export type WindowAppearanceOptions = {
  material?: WindowMaterialPreference;
  themeSource?: 'system' | 'light' | 'dark';
  customTheme?: boolean;
  captionColor?: string;
};
export type WindowAppearanceState = {
  revision: number;
  theme: WindowTheme;
  preference: WindowMaterialPreference;
  customTheme: boolean;
  material: 'mica' | 'none';
};
type WindowAppearanceRequest = Omit<WindowAppearanceState, 'revision'>;

export function resolveWindowAppearance(input: {
  theme: WindowTheme;
  preference: WindowMaterialPreference;
  customTheme: boolean;
  platform: string;
  release: string;
  reducedTransparency: boolean;
  highContrast: boolean;
  gpuCompositing: string;
}): WindowAppearanceRequest {
  const [major, , build] = input.release.split('.').map(Number);
  // Electron's public system backdrop API requires Windows 11 22H2.
  const supported = input.platform === 'win32' && major >= 10 && build >= 22621;
  const useMica = supported && input.preference === 'auto' && !input.customTheme &&
    (input.theme === 'dark' || input.theme === 'bright') &&
    !input.reducedTransparency && !input.highContrast && input.gpuCompositing === 'enabled';
  return {
    theme: input.theme,
    preference: input.preference,
    customTheme: input.customTheme,
    material: useMica ? 'mica' : 'none',
  };
}

type AppearanceWindow = Pick<BrowserWindow,
  'isDestroyed' | 'setBackgroundColor' | 'setBackgroundMaterial' | 'setTitleBarOverlay' | 'contentView'>;

function captionSymbolColor(theme: WindowTheme, customColor?: string) {
  const color = typeof customColor === 'string' ? customColor.trim() : '';
  if (color.length <= 96 && (/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color) ||
      /^(rgb|rgba|hsl|hsla)\([\d\s.,%/+\-]+\)$/.test(color))) return color;
  return theme === 'bright' ? '#1e1c1a' : theme === 'cyberpunk' ? '#f4f3dc' : '#eeeeee';
}

export class WindowAppearanceController {
  #key = '';
  #revision = 0;
  #state: WindowAppearanceState | undefined;
  #captionColor = '';

  constructor(
    private readonly target: AppearanceWindow,
    private readonly platform: string,
    private readonly onError: (error: unknown) => void,
  ) {}

  apply(request: WindowAppearanceRequest, opaqueBackground: string, captionColor?: string): WindowAppearanceState {
    if (this.target.isDestroyed()) return { ...request, material: 'none', revision: this.#revision };
    const symbolColor = captionSymbolColor(request.theme, request.customTheme ? captionColor : undefined);
    if (this.platform === 'win32' && symbolColor !== this.#captionColor) {
      try {
        this.target.setTitleBarOverlay({ color: '#00000000', symbolColor, height: 36 });
      } catch (error) {
        this.onError(error);
        // An invalid imported color must not prevent window startup.
        this.target.setTitleBarOverlay({ color: '#00000000', symbolColor: captionSymbolColor(request.theme), height: 36 });
      }
      this.#captionColor = symbolColor;
    }
    const key = JSON.stringify([request, opaqueBackground]);
    if (this.#key === key && this.#state) return this.#state;
    let state = request;
    if (request.material === 'mica') {
      try {
        // Both Chromium and its native content View must let DWM paint through.
        // Keep the normal, resizable HWND; transparent:true is not required.
        this.target.setBackgroundColor('#00000000');
        this.target.contentView.setBackgroundColor('#00000000');
        this.target.setBackgroundMaterial('mica');
      } catch (error) {
        this.onError(error);
        state = { ...request, material: 'none' };
      }
    }
    if (state.material === 'none') {
      if (this.platform === 'win32') {
        try { this.target.setBackgroundMaterial('none'); } catch { /* Unsupported OS. */ }
      }
      // Disabling the material may reset the HWND color. Set both opaque
      // backing colors last, including the View exposed during restore.
      this.target.setBackgroundColor(opaqueBackground);
      this.target.contentView.setBackgroundColor(opaqueBackground);
    }
    this.#key = key;
    this.#state = { ...state, revision: ++this.#revision };
    return this.#state;
  }
}
