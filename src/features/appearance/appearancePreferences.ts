import type { ImportedThemeStyle, ThemeMode } from '../../types';
import { importedThemeStyleVariables } from './importedThemeStyle';

export const APPEARANCE_STORAGE_KEY = 'cardbush_appearance';
export type AppearanceFont = 'system' | 'sans' | 'serif' | 'mono' | 'imported';
export type FontStyle = 'regular' | 'medium' | 'italic';
export interface AppearanceProfile {
  theme: 'default' | 'imported';
  accent: string;
  background: string;
  foreground: string;
  font: AppearanceFont;
  contentFont: AppearanceFont | 'inherit';
  codeFont: 'system' | 'consolas' | 'cascadia' | 'courier';
  fontStyle: FontStyle;
  contentStyle: FontStyle;
  codeStyle: FontStyle;
}
export interface AppearancePreferences {
  separateModes: boolean;
  modeProfilesInitialized: boolean;
  shared: AppearanceProfile;
  light: AppearanceProfile;
  dark: AppearanceProfile;
  interfaceSize: number;
  codeSize: number;
  reducedMotion: 'system' | 'on' | 'off';
  translucentSidebar: boolean;
  contrast: number;
  diffIndicators: 'color' | 'symbols';
  pointerCursor: boolean;
}

const choice = <T extends string>(value: unknown, options: readonly T[], fallback: T): T =>
  options.includes(value as T) ? value as T : fallback;
const bounded = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.min(max, Math.max(min, value))) : fallback;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const normalizeAppearanceColor = (value: unknown) =>
  typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toUpperCase() : '';

function normalizeProfile(value: unknown): AppearanceProfile {
  const input = record(value);
  return {
    theme: choice(input.theme, ['default', 'imported'], 'default'),
    accent: normalizeAppearanceColor(input.accent),
    background: normalizeAppearanceColor(input.background),
    foreground: normalizeAppearanceColor(input.foreground),
    font: choice(input.font, ['system', 'sans', 'serif', 'mono', 'imported'], 'system'),
    contentFont: choice(input.contentFont, ['inherit', 'system', 'sans', 'serif', 'mono', 'imported'], 'inherit'),
    codeFont: choice(input.codeFont, ['system', 'consolas', 'cascadia', 'courier'], 'system'),
    fontStyle: choice(input.fontStyle, ['regular', 'medium', 'italic'], 'regular'),
    contentStyle: choice(input.contentStyle, ['regular', 'medium', 'italic'], 'regular'),
    codeStyle: choice(input.codeStyle, ['regular', 'medium', 'italic'], 'regular'),
  };
}

export function normalizeAppearance(value?: unknown): AppearancePreferences {
  const input = record(value);
  return {
    separateModes: input.separateModes === true,
    modeProfilesInitialized: input.modeProfilesInitialized === true || input.separateModes === true,
    shared: normalizeProfile(input.shared), light: normalizeProfile(input.light), dark: normalizeProfile(input.dark),
    interfaceSize: bounded(input.interfaceSize, 12, 20, 14),
    codeSize: bounded(input.codeSize, 10, 20, 12),
    reducedMotion: choice(input.reducedMotion, ['system', 'on', 'off'], 'system'),
    translucentSidebar: input.translucentSidebar !== false,
    contrast: bounded(input.contrast, 0, 100, 60),
    diffIndicators: choice(input.diffIndicators, ['color', 'symbols'], 'color'),
    pointerCursor: input.pointerCursor !== false,
  };
}

export function readAppearance(): AppearancePreferences {
  try {
    const saved = localStorage.getItem(APPEARANCE_STORAGE_KEY);
    if (saved) return normalizeAppearance(JSON.parse(saved));
  } catch { /* Invalid settings fall back to the readable default palette. */ }
  const result = normalizeAppearance();
  if (localStorage.getItem('cardbush_theme_mode') === 'custom') result.shared.theme = 'imported';
  if (localStorage.getItem('cardbush_font_family')) result.shared.font = 'imported';
  return result;
}

export function appearanceProfileKey(settings: AppearancePreferences, theme: ThemeMode) {
  return settings.separateModes ? theme === 'bright' ? 'light' : 'dark' : 'shared';
}

export function setSeparateAppearanceModes(settings: AppearancePreferences, enabled: boolean, theme: ThemeMode): AppearancePreferences {
  if (settings.separateModes === enabled) return settings;
  return enabled
    ? { ...settings, separateModes: true, modeProfilesInitialized: true,
        light: { ...(settings.modeProfilesInitialized ? settings.light : settings.shared) },
        dark: { ...(settings.modeProfilesInitialized ? settings.dark : settings.shared) } }
    : { ...settings, separateModes: false, shared: { ...settings[appearanceProfileKey(settings, theme)] } };
}

export function updateAppearanceProfile(settings: AppearancePreferences, theme: ThemeMode, patch: Partial<AppearanceProfile>): AppearancePreferences {
  const key = appearanceProfileKey(settings, theme);
  return { ...settings, [key]: { ...settings[key], ...patch } };
}

const sans = '"Microsoft YaHei UI", Inter, "Segoe UI", "PingFang SC", "Noto Sans SC", Arial, sans-serif';
const mono = 'ui-monospace, "Cascadia Code", Consolas, "Courier New", monospace';
function fontFamily(font: AppearanceFont, importedFamily: string) {
  if (font === 'imported' && importedFamily) return `${JSON.stringify(importedFamily)}, ${sans}`;
  if (font === 'serif') return '"Noto Serif SC", "Songti SC", SimSun, Georgia, serif';
  if (font === 'mono') return mono;
  if (font === 'sans') return 'Arial, "Microsoft YaHei UI", sans-serif';
  return sans;
}

export function appearanceVariables(settings: AppearancePreferences, theme: ThemeMode, imported: ImportedThemeStyle | null, importedFamily = ''): Record<string, string> {
  const profile = settings[appearanceProfileKey(settings, theme)];
  // A dark palette must never leak into the light profile (and vice versa).
  const custom = profile.theme === 'imported' && imported?.base === (theme === 'bright' ? 'light' : 'dark')
    ? importedThemeStyleVariables(imported) : {};
  const vars: Record<string, string | number> = { ...custom };
  if (profile.accent) vars['--accent'] = profile.accent;
  if (profile.background || profile.foreground) {
    const bg = profile.background || vars['--bg'] || (theme === 'bright' ? '#f5f3ef' : '#1a1a1a');
    const fg = profile.foreground || vars['--text'] || (theme === 'bright' ? '#1e1c1a' : '#f0ede7');
    Object.assign(vars, {
      '--bg': bg, '--surface': bg, '--text': fg,
      '--surface-strong': `color-mix(in srgb, ${bg} 94%, ${fg})`,
      '--surface-raised': `color-mix(in srgb, ${bg} 90%, ${fg})`,
      '--user-bubble': `color-mix(in srgb, ${bg} 90%, ${fg})`,
    });
  }
  if (settings.contrast !== 60 || profile.background || profile.foreground) {
    vars['--text-mid'] = `color-mix(in srgb, var(--text) ${58 + settings.contrast * .3}%, var(--surface))`;
    vars['--text-soft'] = `color-mix(in srgb, var(--text) ${34 + settings.contrast * .35}%, var(--surface))`;
    vars['--border'] = `color-mix(in srgb, var(--text) ${8 + settings.contrast * .2}%, var(--surface))`;
  }
  if (vars['--accent']) {
    vars['--appearance-accent'] = vars['--accent'];
    vars['--info'] = vars['--accent'];
    vars['--info-hover'] = 'color-mix(in srgb, var(--accent) 80%, var(--text))';
    vars['--accent-soft'] = 'color-mix(in srgb, var(--accent) 10%, var(--surface))';
  }
  Object.assign(vars, {
    '--app-font-family': fontFamily(profile.font, importedFamily),
    '--content-font-family': profile.contentFont === 'inherit' ? 'var(--app-font-family)' : fontFamily(profile.contentFont, importedFamily),
    '--mono-font-family': ({ system: mono, consolas: 'Consolas, monospace', cascadia: '"Cascadia Code", Consolas, monospace', courier: '"Courier New", monospace' })[profile.codeFont],
    '--ui-font-scale': settings.interfaceSize / 14,
    '--code-font-size': `${settings.codeSize}px`,
    '--ui-font-weight': profile.fontStyle === 'medium' ? 500 : 400,
    '--ui-font-style': profile.fontStyle === 'italic' ? 'italic' : 'normal',
    '--content-font-weight': profile.contentStyle === 'medium' ? 500 : 400,
    '--content-font-style': profile.contentStyle === 'italic' ? 'italic' : 'normal',
    '--code-font-weight': profile.codeStyle === 'medium' ? 500 : 400,
    '--code-font-style': profile.codeStyle === 'italic' ? 'italic' : 'normal',
  });
  return Object.fromEntries(Object.entries(vars).map(([key, value]) => [key, String(value)]));
}

export function appearanceHasCustomPalette(settings: AppearancePreferences, theme: ThemeMode, imported: ImportedThemeStyle | null) {
  const profile = settings[appearanceProfileKey(settings, theme)];
  return Boolean(profile.background || profile.foreground || (profile.theme === 'imported' && imported?.base === (theme === 'bright' ? 'light' : 'dark')));
}

export function resolveReducedMotion(preference: AppearancePreferences['reducedMotion'], system: boolean) {
  return preference === 'on' || (preference === 'system' && system);
}
