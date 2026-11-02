import { browserIconUrl, cachedBrowserSiteIcon, rememberBrowserSiteIconImage } from './browserSiteIcons';

const pending = new Map<string, Promise<void>>();
const failed = new Map<string, { key: string; until: number }>();
export const isCachedBrowserIcon = (icon: string) => icon.startsWith('data:image/');

/** Web links and installed apps share small offline PNGs and in-flight reads. */
export function cacheBrowserSiteIcon(address: string, candidates: string[]): Promise<void> {
  const readIcon = window.cardbushDesktop?.browser?.readIcon;
  if (!readIcon || cachedBrowserSiteIcon(address)) return Promise.resolve();
  let origin: string;
  try {
    const url = new URL(address);
    if (!browserIconUrl(address)) return Promise.resolve();
    origin = url.origin;
  } catch { return Promise.resolve(); }
  const existing = pending.get(origin); if (existing) return existing;
  const urls = [...new Set(candidates)].filter(value => /^https?:/.test(browserIconUrl(value))).slice(0, 4);
  const key = JSON.stringify(urls), previous = failed.get(origin);
  if (previous?.key === key && previous.until > Date.now()) return Promise.resolve();
  const task = (async () => {
    const attempts = [...urls.map(url => ({ url, discover: false })), { url: origin + '/', discover: true }];
    for (const { url, discover } of attempts) {
      try {
        const data = await readIcon(url, discover ? { discover: true } : undefined);
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
        if (png) { failed.delete(origin); rememberBrowserSiteIconImage(address, png); return; }
      } catch { /* Try the next native/browser favicon candidate. */ }
    }
    // Repeated citations and menu remounts must not repeatedly fetch a dead site.
    failed.delete(origin); failed.set(origin, { key, until: Date.now() + 60_000 });
    while (failed.size > 128) failed.delete(failed.keys().next().value!);
  })();
  pending.set(origin, task);
  return task.finally(() => pending.delete(origin));
}
