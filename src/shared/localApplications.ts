export type LocalApplication = { id: string; title: string; path: string; icon?: string; iconVersion?: 1 };

export function localApplicationPath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value)
    && /^(?:[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+|\/[^/])/i.test(value);
}

export function normalizeLocalApplications(value: unknown): LocalApplication[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>(), paths = new Set<string>();
  return value.flatMap((app): LocalApplication[] => {
    if (!app || typeof app.id !== 'string' || !/^local:[a-z0-9-]{1,80}$/i.test(app.id) || ids.has(app.id)
      || typeof app.title !== 'string' || !app.title.trim() || !localApplicationPath(app.path)) return [];
    const key = /^[a-z]:|^\\\\/i.test(app.path) ? app.path.replace(/\//g, '\\').toLowerCase() : app.path;
    if (paths.has(key)) return [];
    ids.add(app.id); paths.add(key);
    return [{ id: app.id, title: app.title.trim().slice(0, 80), path: app.path,
      ...(typeof app.icon === 'string' && app.icon.length <= 131072 && /^data:image\/png;base64,[a-z0-9+/]+=*$/i.test(app.icon) ? { icon: app.icon, ...(app.iconVersion === 1 ? { iconVersion: 1 as const } : {}) } : {}) }];
  }).slice(0, 100);
}
