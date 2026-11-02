import { browserWebUrl } from './browserImport';

/** Read only a bounded image. The renderer decodes and rasterizes it before caching. */
export async function readBrowserIcon(input: unknown, fetcher: typeof fetch, signal?: AbortSignal): Promise<string> {
  const url = browserWebUrl(input);
  if (!url) return '';
  const timeout = AbortSignal.timeout(5000);
  const response = await fetcher(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, credentials: 'omit' });
  const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
  const limit = 262_144;
  if (!response.ok || !response.body || !/^image\/(?:png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon|svg\+xml)$/.test(type)
    || Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel(); return '';
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > limit) { await reader.cancel(); return ''; }
      chunks.push(value);
    }
    return size ? `data:${type};base64,${Buffer.concat(chunks).toString('base64')}` : '';
  } finally { reader.releaseLock(); }
}

const decodeAttribute = (text: string) => text.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (raw, code: string) => {
  if (code[0] !== '#') return ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' } as Record<string, string>)[code.toLowerCase()] ?? raw;
  const value = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
  return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : raw;
});

/** Parse inert metadata only; never mount HTML, run scripts or fetch a manifest. */
export function browserPageIcons(html: string, page: string): string[] {
  const head = html.split(/<\/head\s*>/i)[0].replace(/<!--[\s\S]*?(?:-->|$)|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  let base = page, baseSeen = false;
  const icons: Array<{ href: string; touch: boolean }> = [];
  for (const [tag] of head.matchAll(/<(?:base|link)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
    const attributes = new Map<string, string>();
    for (const match of tag.matchAll(/\s([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      const name = match[1].toLowerCase();
      if (!attributes.has(name)) attributes.set(name, decodeAttribute(match[2] ?? match[3] ?? match[4]));
    }
    const href = attributes.get('href'); if (!href) continue;
    try {
      const target = browserWebUrl(new URL(href, base).href); if (!target) continue;
      if (/^<base\b/i.test(tag)) { if (!baseSeen) { base = target; baseSeen = true; } continue; }
      const rel = (attributes.get('rel') ?? '').toLowerCase().split(/\s+/);
      if (rel.includes('icon')) icons.push({ href: target, touch: false });
      else if (rel.some(value => value === 'apple-touch-icon' || value === 'apple-touch-icon-precomposed')) icons.push({ href: target, touch: true });
    } catch { /* An invalid metadata URL does not hide other candidates. */ }
  }
  return [...new Set(icons.sort((a, b) => Number(a.touch) - Number(b.touch)).map(icon => icon.href))].slice(0, 4);
}

/** Fallback for sites without /favicon.ico. Read only the public homepage head;
 * private link paths/query strings, cookies and page scripts are never used. */
export async function readBrowserSiteIcon(input: unknown, fetcher: typeof fetch): Promise<string> {
  const url = browserWebUrl(input); if (!url) return '';
  const homepage = new URL(url).origin + '/', signal = AbortSignal.timeout(8000);
  const response = await fetcher(homepage, { signal, credentials: 'omit', headers: { accept: 'text/html,application/xhtml+xml' } });
  const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (!response.ok || !response.body || !['text/html', 'application/xhtml+xml'].includes(type ?? '')) {
    await response.body?.cancel(); return '';
  }
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let html = '', size = 0;
  try {
    while (size < 262_144) {
      const { done, value } = await reader.read(); if (done) break;
      const part = value.subarray(0, 262_144 - size); size += part.length;
      html += decoder.decode(part, { stream: true });
      if (/<\/head\s*>/i.test(html)) break;
    }
    html += decoder.decode();
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const page = browserWebUrl(response.url) ?? homepage;
  for (const candidate of browserPageIcons(html, page)) {
    if (signal.aborted) break;
    try { const image = await readBrowserIcon(candidate, fetcher, signal); if (image) return image; }
    catch { /* Try another declared icon within the same total deadline. */ }
  }
  return '';
}
