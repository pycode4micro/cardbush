import { type AppLanguage, type AppLanguageMode } from '../../types';

const defaultSidebarWidth = 272;

const minSidebarWidth = 220;

const maxSidebarWidth = 420;

export function readInitialSidebarWidth() {
  const stored = window.localStorage.getItem('cardbush.sidebar_width');
  if (stored) {
    const width = Number(stored);
    if (Number.isFinite(width)) {
      return clampSidebarWidth(width);
    }
  }
  return defaultSidebarWidth;
}

export function clampSidebarWidth(value: number) {
  return Math.max(minSidebarWidth, Math.min(maxSidebarWidth, Math.round(value)));
}

export function readInitialLanguageMode(): AppLanguageMode {
  const stored = window.localStorage.getItem('cardbush_language_mode');
  if (stored === 'system' || stored === 'zh' || stored === 'en') {
    return stored;
  }
  const legacy = window.localStorage.getItem('cardbush.language');
  if (legacy === 'zh' || legacy === 'en') {
    return legacy;
  }
  return 'system';
}

export function readSystemLanguage(): AppLanguage {
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export function resolveAppLanguage(mode: AppLanguageMode, systemLanguage: AppLanguage) {
  return mode === 'system' ? systemLanguage : mode;
}

export function readDisabledSkillNames() {
  const raw = window.localStorage.getItem('cardbush_disabled_skills');
  if (!raw?.trim()) {
    return new Set<string>();
  }
  try {
    const decoded: unknown = JSON.parse(raw);
    return new Set(
      Array.isArray(decoded)
        ? decoded.map((item) => String(item)).filter((item) => item.trim())
        : [],
    );
  } catch {
    return new Set<string>();
  }
}

export function persistDisabledSkillNames(value: Set<string>) {
  window.localStorage.setItem(
    'cardbush_disabled_skills',
    JSON.stringify([...value].sort()),
  );
}

export function readVisualInputEnabled() {
  return window.localStorage.getItem('cardbush_visual_input_enabled') === 'true';
}

export function persistVisualInputEnabled(value: boolean) {
  window.localStorage.setItem('cardbush_visual_input_enabled', value ? 'true' : 'false');
}