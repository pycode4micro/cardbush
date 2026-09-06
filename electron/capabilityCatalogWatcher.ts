import { existsSync, watch, type FSWatcher } from 'node:fs';
import { resolve } from 'node:path';

/** Directory watches survive atomic file replacements; missing roots are retried. */
export function watchCapabilityCatalog(roots: string[], onChange: () => void) {
  const paths = [...new Set(roots.map((root) => resolve(root)))];
  const watchers = new Map<string, FSWatcher>();
  let closed = false;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const changed = () => {
    if (closed) return;
    clearTimeout(debounce);
    debounce = setTimeout(() => { if (!closed) onChange(); }, 250);
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
          if (/(^|\/)(node_modules|\.git|__pycache__|logs|cache)(\/|$)/i.test(name)) return;
          // Directory events discover new packages; descriptors and Skill docs
          // update existing packages without watching generated runtime output.
          if (!name || /\.(json|md|svg|png|webp)$/i.test(name) || !/\.[^/]+$/.test(name)) changed();
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
