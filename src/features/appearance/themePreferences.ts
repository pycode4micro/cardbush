import { type ImportedThemeStyle, type ThemeMode, type ThemePreference } from '../../types';
import { normalizeImportedThemeStyle } from './importedThemeStyle';

export const importedThemeStyleStorageKey = 'cardbush_imported_theme_style';

export function readImportedThemeStyle(): ImportedThemeStyle | null {
  const raw = window.localStorage.getItem(importedThemeStyleStorageKey);
  if (!raw?.trim()) return null;
  try {
    return normalizeImportedThemeStyle(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function readInitialThemePreference(): ThemePreference {
  const stored = window.localStorage.getItem('cardbush_theme_mode');
  window.localStorage.removeItem('cardbush_light_theme_style');
  if (
    stored === 'system' ||
    stored === 'light' ||
    stored === 'dark'
  ) {
    return stored;
  }
  if (stored === 'cyberpunk') return 'dark';
  if (stored === 'custom' && readImportedThemeStyle()) {
    return readImportedThemeStyle()!.base;
  }
  // Retired or invalid selections fall back without reviving a stale legacy value.
  if (stored) return 'system';
  const legacy = window.localStorage.getItem('cardbush.theme');
  if (legacy === 'dark' || legacy === 'cyberpunk') {
    return 'dark';
  }
  if (legacy === 'bright') {
    return 'light';
  }
  return 'system';
}

export function systemPrefersDark() {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

export function resolveTheme(
  preference: ThemePreference,
  prefersDark: boolean,
): ThemeMode {
  if (preference === 'dark') {
    return 'dark';
  }
  if (preference === 'light') {
    return 'bright';
  }
  return prefersDark ? 'dark' : 'bright';
}