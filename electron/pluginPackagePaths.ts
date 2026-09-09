import { resolve, relative, isAbsolute } from 'node:path';

export function safePackagePath(value: string): string {
  const path = value.replace(/^\.\//, '').replace(/\/$/, '');
  if (!path || path.split('/').some(part => !part || part === '.' || part === '..' || /[<>:"\\|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) throw new Error('Plugin path must stay inside the marketplace root.');
  return path;
}
export function withinPackage(root: string, value: string) {
  const target = resolve(root, safePackagePath(value)), rel = relative(resolve(root), target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Plugin path escapes its source root.');
  return target;
}
