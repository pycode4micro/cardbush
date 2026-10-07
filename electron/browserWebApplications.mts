import type { WebContents } from 'electron';
import { websiteApplication, type WebApplicationInfo } from '@cardbush/bush-protocol';

// This function runs in an isolated guest world. It reads metadata with the
// website's normal fetch/CORS policy, without exposing a desktop bridge.
const readManifest = `(async () => {
  const icon = document.querySelector('link[rel~="icon"]')?.href;
  const link = document.querySelector('link[rel~="manifest"]');
  if (!link || !['http:', 'https:'].includes(new URL(link.href).protocol)) return { icon };
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(link.href, { credentials: link.crossOrigin === 'use-credentials' ? 'include' : 'same-origin', signal: controller.signal });
    if (!response.ok || !response.body) return { icon };
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let bytes = 0, content = '';
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 262_144) { await reader.cancel(); return { icon }; }
        content += decoder.decode(chunk.value, { stream: true });
      }
      content += decoder.decode();
    } finally { reader.releaseLock(); }
    return { icon, manifestUrl: response.url, manifest: JSON.parse(content) };
  } catch { return { icon }; }
  finally { clearTimeout(timer); }
})()`;

export async function readWebsiteApplication(guest: WebContents, expectedUrl: string): Promise<WebApplicationInfo> {
  const url = guest.getURL(), title = guest.getTitle(), fallback = websiteApplication(url, title);
  if (!fallback || url !== expectedUrl) throw Error('网页已变化，请重新选择安装。Page changed; choose Install again.');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const metadata = await Promise.race([
      guest.executeJavaScriptInIsolatedWorld(1012, [{ code: readManifest }]).catch(() => ({})),
      new Promise<unknown>(resolve => { timer = setTimeout(() => resolve({}), 3500); }),
    ]);
    if (guest.isDestroyed() || guest.getURL() !== url) throw Error('网页已变化，请重新选择安装。Page changed; choose Install again.');
    return websiteApplication(url, title, metadata) ?? fallback;
  } finally { clearTimeout(timer); }
}
