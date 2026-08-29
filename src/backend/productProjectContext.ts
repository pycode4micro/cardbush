const storageKey = 'cardbush_product_project_context_v1';

export interface ProductProjectContext {
  projectDir: string;
  userPrompt: string;
}

interface StoredProjectContext {
  projectDir: string;
  userPrompt: string;
}

export function readProductProjectContext(projectDir: string): ProductProjectContext {
  const normalized = projectDir.trim();
  if (!normalized) return { projectDir: '', userPrompt: '' };
  const context = readAll()[identity(normalized)];
  return context ?? { projectDir: normalized, userPrompt: '' };
}

export function saveProductProjectContext(input: ProductProjectContext): ProductProjectContext {
  const projectDir = input.projectDir.trim();
  if (!projectDir) throw new Error('Project directory is empty.');
  const context = { projectDir, userPrompt: input.userPrompt };
  const stored = readAll();
  stored[identity(projectDir)] = context;
  window.localStorage.setItem(storageKey, JSON.stringify(stored));
  return context;
}

function readAll(): Record<string, StoredProjectContext> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey) ?? '{}') as unknown;
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).flatMap(([key, value]) => {
      if (value == null || typeof value !== 'object' || Array.isArray(value)) return [];
      const record = value as Record<string, unknown>;
      const projectDir = typeof record.projectDir === 'string' ? record.projectDir.trim() : '';
      const userPrompt = typeof record.userPrompt === 'string' ? record.userPrompt : '';
      return projectDir ? [[key, { projectDir, userPrompt }]] : [];
    }));
  } catch {
    return {};
  }
}

function identity(projectDir: string): string {
  return projectDir.replace(/[\\/]+$/, '').normalize('NFKC').toLocaleLowerCase();
}
