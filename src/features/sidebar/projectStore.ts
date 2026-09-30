import { basename, samePath } from '../../shared/localPaths';
import { type ProjectItem } from '../../types';

export function readProjectItems(): ProjectItem[] {
  const raw = window.localStorage.getItem('cardbush_projects');
  if (!raw?.trim()) {
    return [];
  }
  try {
    const decoded: unknown = JSON.parse(raw);
    if (!Array.isArray(decoded)) {
      return [];
    }
    const result: ProjectItem[] = [];
    for (const item of decoded) {
      const value = item != null && typeof item === 'object'
        ? (item as Record<string, unknown>)
        : {};
      const rootPath = String(value.rootPath ?? '').trim();
      const id = String(value.id ?? '').trim() || stableProjectId(rootPath);
      if (
        !rootPath ||
        result.some((project) => project.id === id || samePath(project.rootPath, rootPath))
      ) {
        continue;
      }
      const changedCount = Number(value.changedCount);
      result.push({
        id,
        title: String(value.title ?? '').trim() || basename(rootPath),
        rootPath,
        missing: Boolean(value.missing),
        pinned: Boolean(value.pinned),
        archived: Boolean(value.archived),
        branch: String(value.branch ?? '').trim(),
        changedCount: Number.isFinite(changedCount) ? changedCount : 0,
      });
    }
    return result;
  } catch {
    return [];
  }
}

export function persistProjectItems(value: ProjectItem[]) {
  window.localStorage.setItem('cardbush_projects', JSON.stringify(value));
}

export function stableProjectId(rootPath: string) {
  return `project-${rootPath.startsWith('ssh://') ? rootPath : rootPath.replaceAll('\\', '/').toLowerCase()}`;
}