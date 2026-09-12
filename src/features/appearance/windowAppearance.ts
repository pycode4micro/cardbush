import { useEffect } from 'react';
import type { ThemeMode, ThemePreference } from '../../types';
import type { WindowAppearanceState, WindowMaterialPreference } from '../../../electron/windowAppearance';
import { themeBackgroundColor } from './themeRuntime';

export type { WindowMaterialPreference } from '../../../electron/windowAppearance';
export const WINDOW_MATERIAL_STORAGE_KEY = 'cardbush_window_material';

export function readWindowMaterialPreference(): WindowMaterialPreference {
  return localStorage.getItem(WINDOW_MATERIAL_STORAGE_KEY) === 'solid' ? 'solid' : 'auto';
}

export function applyDocumentBackdrop(theme: ThemeMode, material: 'mica' | 'none' = 'none') {
  const background = material === 'mica' ? 'transparent' : themeBackgroundColor(theme);
  const html = document.documentElement;
  html.dataset.startTheme = theme;
  html.dataset.windowMaterial = material;
  html.style.setProperty('--cardbush-window-bg', background);
  html.style.backgroundColor = background;
  document.body.style.backgroundColor = background;
  document.getElementById('root')?.style.setProperty('background', background);
  delete html.dataset.startCustomBackground;
  html.style.removeProperty('--cardbush-custom-background-image');
  localStorage.removeItem('cardbush_background_image_path');
  localStorage.removeItem('cardbush_shadow_accent_color');
}

export function useWindowAppearance(
  theme: ThemeMode,
  themePreference: ThemePreference,
  preference: WindowMaterialPreference,
) {
  useEffect(() => {
    let disposed = false;
    let material: 'mica' | 'none' = 'none';
    let revision = -1;
    const customTheme = themePreference === 'custom';
    const desktop = window.cardbushDesktop;
    const refresh = () => applyDocumentBackdrop(theme, material);
    const receive = (state: WindowAppearanceState | undefined) => {
      if (disposed || !state || state.theme !== theme ||
          state.preference !== preference || state.customTheme !== customTheme ||
          !Number.isSafeInteger(state.revision) || state.revision <= revision) return;
      revision = state.revision;
      material = state.material === 'mica' ? 'mica' : 'none';
      refresh();
    };
    // Keep a themed backing until the native host has confirmed the material.
    refresh();
    const unsubscribe = desktop?.onWindowAppearanceChanged?.(receive);
    void desktop?.setWindowTheme?.(theme, {
      material: preference,
      customTheme,
      themeSource: themePreference === 'system' ? 'system' :
        theme === 'dark' || theme === 'cyberpunk' ? 'dark' : 'light',
    }).then(receive).catch(() => {
      if (!disposed && revision < 0) { material = 'none'; refresh(); }
    });
    window.addEventListener('focus', refresh);
    window.addEventListener('pageshow', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      disposed = true;
      unsubscribe?.();
      window.removeEventListener('focus', refresh);
      window.removeEventListener('pageshow', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [theme, themePreference, preference]);
}
