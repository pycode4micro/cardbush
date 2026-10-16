import { browserIconUrl, cachedBrowserSiteIcon, rememberBrowserSiteIconImage } from './browserSiteIcons';

const pending = new Map<string, Promise<void>>();
export const isCachedBrowserIcon = (icon: string) => icon.startsWith('data:image/');

/** Installed apps reuse the browser icon store, with small offline PNGs. */
export function cacheBrowserSiteIcon(address: string, candidates: string[]): Promise<void> {
  const readIcon = window.cardbushDesktop?.browser?.readIcon;
  if (!readIcon || cachedBrowserSiteIcon(address)) return Promise.resolve();
  let origin: string;
  try { origin = new URL(address).origin; } catch { return Promise.resolve(); }
  const existing = pending.get(origin); if (existing) return existing;
  const task = (async () => {
    for (const candidate of [...new Set(candidates)].filter(value => /^https?:/.test(browserIconUrl(value))).slice(0, 4)) {
      try {
        const data = await readIcon(candidate);
        if (data.length > 360_000 || !/^data:image\/(?:png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon|svg\+xml);base64,[a-z\d+/=]+$/i.test(data)) continue;
        const image = new Image(); image.src = data;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([image.decode(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('Icon decode timed out')), 3000); })]); }
        finally { clearTimeout(timer); }
        if (!image.naturalWidth || !image.naturalHeight) continue;
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 48;
        const context = canvas.getContext('2d'); if (!context) return;
        const scale = Math.min(48 / image.naturalWidth, 48 / image.naturalHeight), width = image.naturalWidth * scale, height = image.naturalHeight * scale;
        context.drawImage(image, (48 - width) / 2, (48 - height) / 2, width, height);
        const png = browserIconUrl(canvas.toDataURL('image/png'));
        if (png) { rememberBrowserSiteIconImage(address, png); return; }
      } catch { /* Try the next native/browser favicon candidate. */ }
    }
  })();
  pending.set(origin, task);
  return task.finally(() => pending.delete(origin));
}
