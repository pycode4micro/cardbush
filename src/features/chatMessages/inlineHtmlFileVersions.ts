import { useEffect, useState } from 'react';

type Entry = { path: string; version?: string; listeners: Set<(version: string) => void> };
const entries = new Map<string, Entry>();
let timer: ReturnType<typeof setInterval> | undefined;
let checking = false;
const identity = (path: string) => /^[a-z]:[\\/]|^\\\\/i.test(path) ? path.replaceAll('\\', '/').toLowerCase() : path;

// One bounded metadata pass for visible previews, including duplicate references.
// Do not reload on a missing/empty file during an editor's atomic replacement.
async function refresh() {
  const inspect = window.cardbushDesktop?.inspectAttachments;
  if (checking || !inspect || document.visibilityState === 'hidden') return;
  checking = true;
  try {
    const pending = [...entries.entries()];
    for (let offset = 0; offset < pending.length; offset += 32) {
      const batch = pending.slice(offset, offset + 32);
      const files = await inspect(batch.map(([, entry]) => entry.path));
      for (const file of files) {
        if (file.kind !== 'file' || !file.size || !Number.isFinite(file.mtimeMs)) continue;
        const key = identity(file.path);
        const entry = entries.get(key);
        if (!entry || !batch.some(([id, original]) => id === key && original === entry)) continue;
        const version = JSON.stringify([file.size, file.mtimeMs]);
        if (entry.version === version) continue;
        entry.version = version;
        for (const listener of entry.listeners) listener(version);
      }
    }
  } catch { /* A transient metadata error must not remove a working chart. */ }
  finally { checking = false; }
}

export function useInlineHtmlFileVersion(path: string, active: boolean, hint?: string) {
  const [observed, setObserved] = useState<{ path: string; version: string }>();
  useEffect(() => {
    if (!active || !window.cardbushDesktop?.inspectAttachments) return;
    const key = identity(path);
    const entry = entries.get(key) ?? { path, listeners: new Set<(version: string) => void>() };
    entries.set(key, entry);
    const listener = (version: string) => setObserved({ path, version });
    entry.listeners.add(listener);
    if (entry.version) listener(entry.version);
    if (!timer) {
      timer = setInterval(() => void refresh(), 2000);
      window.addEventListener('focus', refresh);
      document.addEventListener('visibilitychange', refresh);
    }
    void refresh();
    return () => {
      entry.listeners.delete(listener);
      if (!entry.listeners.size) entries.delete(key);
      if (!entries.size) {
        clearInterval(timer); timer = undefined;
        window.removeEventListener('focus', refresh);
        document.removeEventListener('visibilitychange', refresh);
      }
    };
  }, [path, active]);
  // Old desktop bridges can still use the memo's supplied version.
  return observed?.path === path ? observed.version : hint;
}
