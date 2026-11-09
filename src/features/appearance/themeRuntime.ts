import type { ThemeMode } from '../../types';

export const THEME_BACKGROUNDS: Readonly<Record<ThemeMode, string>> = {
  bright: '#f5f3ef',
  dark: '#1a1a1a',
};

export const THEME_ACCENTS: Readonly<Record<ThemeMode, string>> = {
  bright: '#175fb5',
  dark: '#83baff',
};

export const THEME_FOREGROUNDS: Readonly<Record<ThemeMode, string>> = {
  bright: '#1e1c1a',
  dark: '#f0ede7',
};

export const COLOR_INPUT_FALLBACK = '#808080';

export function themeClassNames(theme: ThemeMode) {
  return 'theme-' + theme;
}

export function themeBackgroundColor(theme: ThemeMode) {
  return THEME_BACKGROUNDS[theme];
}

export function themeAccentColor(theme: ThemeMode) {
  return THEME_ACCENTS[theme];
}
