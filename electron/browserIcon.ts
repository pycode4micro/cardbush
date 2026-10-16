import { browserWebUrl } from './browserImport';

/** Read only a bounded image. The renderer decodes and rasterizes it before caching. */
export async function readBrowserIcon(input: unknown, fetcher: typeof fetch): Promise<string> {
  const url = browserWebUrl(input);
  if (!url) return '';
  const response = await fetcher(url, { signal: AbortSignal.timeout(5000), credentials: 'omit' });
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
