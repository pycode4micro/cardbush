const storageKey = 'cardbush.browser_site_icons.v1';
const listeners = new Set<() => void>();
let stored: string | null = null;
let icons = new Map<string, string>();

function siteOrigin(address: string): string {
  try {
    const url = new URL(address);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.origin : '';
  } catch { return ''; }
}

export function browserIconUrl(input: unknown): string {
  if (typeof input !== 'string' || input.length > 32_768) return '';
  if (/^data:image\/(?:png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon);base64,[a-z\d+/=]+$/i.test(input)) return input;
  if (input.length > 4096) return '';
  try {
    const url = new URL(input);
    return siteOrigin(input) ? url.href : '';
  } catch { return ''; }
}

function readIcons() {
  try {
    const raw = localStorage.getItem(storageKey) ?? '';
    if (raw === stored) return;
    stored = raw;
    const values: unknown = JSON.parse(raw || '[]');
    icons = new Map(Array.isArray(values) ? values.slice(-128).flatMap(item => {
      const origin = Array.isArray(item) && typeof item[0] === 'string' ? siteOrigin(item[0]) : '';
      const icon = origin ? browserIconUrl(item[1]) : '';
      return origin && icon ? [[origin, icon] as [string, string]] : [];
    }) : []);
  } catch { /* Icons are optional metadata; storage must never block browsing. */ }
}

export function browserSiteIcon(address: string): string {
  const origin = siteOrigin(address);
  if (!origin) return '';
  readIcons();
  return icons.get(origin) || `${origin}/favicon.ico`;
}

export function defaultBrowserSiteIcon(address: string): string {
  const origin = siteOrigin(address);
  return origin ? `${origin}/favicon.ico` : '';
}

export function rememberBrowserSiteIcon(address: string, candidate: unknown) {
  const origin = siteOrigin(address), icon = browserIconUrl(candidate);
  if (!origin || !icon) return;
  readIcons();
  if (icons.get(origin) === icon) return;
  icons.delete(origin);
  icons.set(origin, icon);
  // Bound both record count and embedded image metadata; never cache page content.
  let entries = [...icons];
  while (entries.length > 128 || JSON.stringify(entries).length > 262_144) entries.shift();
  icons = new Map(entries);
  try { const raw = JSON.stringify(entries); localStorage.setItem(storageKey, raw); stored = raw; } catch { /* Keep the in-memory icon. */ }
  for (const listener of listeners) listener();
}

const storageChanged = (event: StorageEvent) => {
  if (!event.key || event.key === storageKey) for (const listener of listeners) listener();
};
export function subscribeBrowserSiteIcons(listener: () => void) {
  if (!listeners.size) window.addEventListener('storage', storageChanged);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.removeEventListener('storage', storageChanged);
  };
}
