import fs from 'node:fs';
import path from 'node:path';

export interface ProjectRootStatus {
  rootPath: string;
  resolvedPath: string;
  exists: boolean;
}

export function inspectProjectRoots(rootPaths: string[]): ProjectRootStatus[] {
  const seen = new Set<string>();
  const results: ProjectRootStatus[] = [];

  for (const value of rootPaths) {
    const rootPath = String(value ?? '').trim();
    if (!rootPath) {
      continue;
    }

    const resolvedPath = path.resolve(rootPath);
    const key = resolvedPath.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    let exists = false;
    try {
      exists = fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isDirectory();
    } catch {
      exists = false;
    }

    results.push({ rootPath, resolvedPath, exists });
  }

  return results;
}
