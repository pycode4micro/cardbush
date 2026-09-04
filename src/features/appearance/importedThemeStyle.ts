import type {
  ImportedThemeBase,
  ImportedThemeColorKey,
  ImportedThemeStyle,
  ThemeMode,
} from '../../types';

export const IMPORTED_THEME_STYLE_PROTOCOL = 'cardbush.appearance_style.v1' as const;

const importedThemeColorTokens: Readonly<
  Record<ImportedThemeColorKey, `--${string}`>
> = {
  background: '--bg',
  surface: '--surface',
  surfaceStrong: '--surface-strong',
  surfaceRaised: '--surface-raised',
  border: '--border',
  accent: '--accent',
  accentSoft: '--accent-soft',
  text: '--text',
  textMuted: '--text-mid',
  textSoft: '--text-soft',
  userBubble: '--user-bubble',
  terminalBackground: '--terminal-bg',
  danger: '--danger',
};

const importedThemeColorKeys = new Set<ImportedThemeColorKey>(
  Object.keys(importedThemeColorTokens) as ImportedThemeColorKey[],
);

export function parseImportedThemeStyle(
  source: string,
  sourcePath = '',
): ImportedThemeStyle {
  let decoded: unknown;
  try {
    decoded = JSON.parse(source);
  } catch {
    throw new Error('invalid_json');
  }
  return normalizeImportedThemeStyle(decoded, sourcePath, true)!;
}

export function normalizeImportedThemeStyle(
  value: unknown,
  sourcePath = '',
  strict = false,
): ImportedThemeStyle | null {
  if (!isRecord(value)) {
    if (strict) throw new Error('invalid_root');
    return null;
  }
  if (value.protocol !== IMPORTED_THEME_STYLE_PROTOCOL) {
    if (strict) throw new Error('invalid_protocol');
    return null;
  }
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (!name || name.length > 64) {
    if (strict) throw new Error('invalid_name');
    return null;
  }
  const base = normalizeImportedThemeBase(value.base);
  if (!base) {
    if (strict) throw new Error('invalid_base');
    return null;
  }
  if (!isRecord(value.colors)) {
    if (strict) throw new Error('invalid_colors');
    return null;
  }
  const colors: Partial<Record<ImportedThemeColorKey, string>> = {};
  for (const [key, rawColor] of Object.entries(value.colors)) {
    if (!importedThemeColorKeys.has(key as ImportedThemeColorKey)) {
      if (strict) throw new Error('unknown_color');
      continue;
    }
    if (typeof rawColor !== 'string' || !isSafeThemeColor(rawColor)) {
      if (strict) throw new Error('invalid_color');
      continue;
    }
    colors[key as ImportedThemeColorKey] = rawColor.trim();
  }
  if (Object.keys(colors).length === 0) {
    if (strict) throw new Error('empty_colors');
    return null;
  }
  const persistedSourcePath = sourcePath.trim() || (
    typeof value.sourcePath === 'string' ? value.sourcePath.trim() : ''
  );
  return {
    protocol: IMPORTED_THEME_STYLE_PROTOCOL,
    name,
    base,
    colors,
    sourcePath: persistedSourcePath,
  };
}

export function importedThemeStyleVariables(
  style: ImportedThemeStyle | null | undefined,
) {
  if (!style) return {};
  return Object.fromEntries(
    Object.entries(style.colors).flatMap(([key, value]) => {
      const token = importedThemeColorTokens[key as ImportedThemeColorKey];
      return token && value ? [[token, value]] : [];
    }),
  ) as Record<`--${string}`, string>;
}

export function importedThemeBaseMode(base: ImportedThemeBase): ThemeMode {
  return base === 'light' ? 'bright' : base;
}

function normalizeImportedThemeBase(value: unknown): ImportedThemeBase | null {
  return value === 'light' || value === 'dark' || value === 'parchment'
    ? value
    : null;
}

function isSafeThemeColor(value: string) {
  const color = value.trim();
  if (!color || color.length > 96 || /[;{}]|url\s*\(|var\s*\(|expression/i.test(color)) {
    return false;
  }
  return (
    /^#[0-9a-f]{3,4}$/i.test(color) ||
    /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(color) ||
    /^(rgb|rgba|hsl|hsla)\([\d\s.,%/+\-]+\)$/i.test(color)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
