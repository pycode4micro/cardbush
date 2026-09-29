import type { ToolDisplay } from './tool.js';

export function normalizeToolDisplayTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const title = value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
  return title ? Array.from(title).slice(0, 80).join('') : undefined;
}

/** Accept old text titles and JSON-encoded locale maps without showing JSON in the UI. */
export function normalizeToolDisplay(value: unknown): ToolDisplay | undefined {
  for (let depth = 0; depth < 2 && typeof value === 'string'; depth++) {
    const text = value.trim();
    if (!/^[\[{\"]/.test(text)) break;
    if (text.length > 16_384) return undefined;
    try { value = JSON.parse(text); } catch { return undefined; }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const titles = value as Record<string, unknown>;
    const zh = normalizeToolDisplayTitle(titles.zh), en = normalizeToolDisplayTitle(titles.en);
    if (zh || en) return { title: en || zh!, titles: { ...(zh ? { zh } : {}), ...(en ? { en } : {}) } };
    return undefined;
  }
  if (typeof value !== 'string' || /^[\[{\"]/.test(value.trim())) return undefined;
  const title = normalizeToolDisplayTitle(value);
  return title ? { title } : undefined;
}
