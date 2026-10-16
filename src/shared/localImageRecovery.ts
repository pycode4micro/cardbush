import { mediaResourceUrl } from './localPaths';

// Negative results survive transcript remounts, but never retain image bytes.
const failures = new Map<string, number>();
const pending = new Map<string, Promise<string>>();
const lifetime = 60_000;
export function localImageUnavailable(path: string) {
  const key = mediaResourceUrl(path), until = failures.get(key);
  if (until && until > Date.now()) return true;
  failures.delete(key); return false;
}
export function retryLocalImage(path: string) { failures.delete(mediaResourceUrl(path)); }
export async function recoverLocalImage(path: string, read: (path: string) => Promise<string>): Promise<string> {
  const key = mediaResourceUrl(path);
  if (localImageUnavailable(path)) return '';
  const existing = pending.get(key);
  if (existing) return existing;
  const operation = Promise.resolve().then(() => read(path)).catch(() => '').then(source => {
    if (source.startsWith('data:image/')) { failures.delete(key); return source; }
    failures.delete(key); failures.set(key, Date.now() + lifetime);
    while (failures.size > 128) failures.delete(failures.keys().next().value!);
    return '';
  }).finally(() => { if (pending.get(key) === operation) pending.delete(key); });
  pending.set(key, operation);
  return operation;
}
