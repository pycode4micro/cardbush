/** Adapt local runtime references to authenticated web downloads, never file:// or external image requests. */
export function personalFilePath(source: string): string | null {
  let path = source;
  if (/^file:\/\//i.test(path)) {
    try {
      const url = new URL(path);
      if (url.hostname && url.hostname !== 'localhost') return null;
      path = url.pathname;
    } catch { return null; }
  }
  try { path = decodeURIComponent(path); } catch { return null; }
  // POSIX permits a leading double slash; model-authored Markdown may preserve it.
  path = path.replace(/^\/\/(?=data\/workspaces\/)/, '/');
  if (!path.startsWith('/data/workspaces/') || /[\\\u0000?#:]/.test(path)) return null;
  if (path.split('/').some(part => part === '..' || part === '.')) return null;
  return path;
}
