import type { ThemeMode } from '../../types';

export const THEME_BACKGROUNDS: Readonly<Record<ThemeMode, string>> = {
  parchment: '#e1d4ba',
  bright: '#f5f3ef',
  dark: '#1a1a1a',
  cyberpunk: '#050607',
};

/**
 * Cyberpunk is a dark-theme specialization. Keeping the dark compatibility
 * class lets mature component-specific dark styles remain available while the
 * later cyberpunk stylesheet replaces their visual tokens and key surfaces.
 */
export function themeClassNames(theme: ThemeMode) {
  return theme === 'cyberpunk'
    ? 'theme-dark theme-cyberpunk'
    : `theme-${theme}`;
}

export function themeBackgroundColor(theme: ThemeMode) {
  return THEME_BACKGROUNDS[theme];
}
