/** Web navigation only. Keep this separate from the stricter OAuth URL policy. */
export function checkedExternalWebUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192) throw new Error('Provide an absolute HTTP(S) webpage URL.');
  const text = value.trim();
  if (/[\u0000-\u0020\u007f]/u.test(text) || !/^https?:\/\//i.test(text)) throw new Error('Provide an absolute HTTP(S) webpage URL.');
  const url = new URL(text);
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error('Webpage URLs must use HTTP(S) without embedded credentials.');
  }
  return url.href;
}
