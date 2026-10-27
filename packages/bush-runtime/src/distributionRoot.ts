import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Workspace builds live under packages/bush-runtime; the npm distribution
 * bundles the same module under node_modules/@cardbush/bush-runtime. Assets
 * remain owned by the enclosing CardBush release in both layouts. */
export function runtimeDistributionRoot(moduleUrl = import.meta.url): string {
  const packageRoot = dirname(dirname(fileURLToPath(moduleUrl)));
  const parent = dirname(packageRoot);
  if (basename(parent) === '@cardbush' && basename(dirname(parent)) === 'node_modules') {
    return dirname(dirname(parent));
  }
  return dirname(parent);
}
