import { existsSync, watch, type FSWatcher } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ignoredCapabilityPath, pluginRuntimeSource } from './pluginRuntimeFingerprint';

async function configurationStamp(root: string) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = entries.filter(entry => entry.isFile() && /\.json$/i.test(entry.name));
  const stamps = await Promise.all(files.map(async file => {
    const info = await lstat(resolve(root, file.name), { bigint: true });
    return [file.name, String(info.ino), String(info.size), String(info.mtimeNs)];
  }));
  return JSON.stringify(stamps.sort(([a], [b]) => a.localeCompare(b)));
}

/** Directory watches survive atomic file replacements; missing roots are retried. */
export function watchCapabilityCatalog(roots: string[], onChange: () => void, configurationRoot?: string) {
  const paths = [...new Set(roots.map((root) => resolve(root)))];
  const config = configurationRoot && resolve(configurationRoot);
  const watchers = new Map<string, FSWatcher>();
  let closed = false;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let generation = 0, sourceChanged = false, previousConfig: string | undefined;
  const changed = (source = true) => {
    if (closed) return;
    const current = ++generation;
    sourceChanged ||= source;
    clearTimeout(debounce);
    debounce = setTimeout(async () => {
      // On Windows, acquiring a sibling config lock can report events for
      // unchanged JSON files. Refreshing their catalogs acquires the lock again.
      const stamp = config ? await configurationStamp(config).catch(() => undefined) : undefined;
      if (closed || current !== generation) return;
      const notify = sourceChanged || stamp !== previousConfig;
      previousConfig = stamp;
      sourceChanged = false;
      if (notify) onChange();
    }, 250);
    debounce.unref?.();
  };
  const attach = () => {
    for (const root of paths) {
      if (watchers.has(root) && !existsSync(root)) {
        watchers.get(root)?.close();
        watchers.delete(root);
        changed();
      }
      if (watchers.has(root)) continue;
      try {
        const watcher = watch(root, { recursive: true, persistent: false }, (_event, filename) => {
          const name = String(filename ?? '').replaceAll('\\', '/');
          if (root === config) {
            if (!name || /\.json$/i.test(name)) changed(false);
            return;
          }
          if (ignoredCapabilityPath(name)) return;
          // Directory events discover new packages; descriptors and Skill docs
          // update existing packages without watching generated runtime output.
          if (!name || /\.(json|md|svg|png|webp)$/i.test(name) || pluginRuntimeSource(name) || !/\.[^/]+$/.test(name)) changed();
        });
        watcher.on('error', () => {
          watcher.close();
          watchers.delete(root);
          changed();
        });
        watchers.set(root, watcher);
        changed();
      } catch { /* A not-yet-created package root is attached on the next pass. */ }
    }
  };
  attach();
  const retry = setInterval(attach, 1_000);
  retry.unref?.();
  return () => {
    closed = true;
    clearTimeout(debounce);
    clearInterval(retry);
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
  };
}
