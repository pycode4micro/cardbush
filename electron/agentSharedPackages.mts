import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { z } from 'zod';
import { safePackagePath } from './pluginPackagePaths.js';

// Only legacy validation/recovery remains; plugin transfer and package creation are retired.
export const sharedPackageLimits = { packages: 512 };
export const sharedDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const sharedPackagePathSchema = z.string().refine(value => {
  try { return /^(plugins|skills)\/[^/]+$/.test(value) && safePackagePath(value) === value; } catch { return false; }
}, 'Invalid shared package path');
export const sharedPackageReferenceSchema = z.object({ path: sharedPackagePathSchema, pluginId: z.string().max(200).optional(),
  digest: sharedDigestSchema.optional(), issue: z.string().max(1000).optional(),
}).strict().refine(value => Boolean(value.digest) !== Boolean(value.issue), 'A package needs a digest or an issue');
export const sharedHash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** Generated environments are rebuilt by the plugin's target-platform launcher.
 * Do not use .gitignore: published dist/, models and other runtime assets may be ignored by Git. */
export function ignoredSharedPackagePath(path: string) {
  return /(^|\/)(\.git|\.venv|venv|\.tools|\.python|node_modules|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.tox|\.cache|\.gpu-cache|\.uv|\.npm)(\/|$)/i.test(path) ||
    /(^|\/)(\.DS_Store|\.runtime-ready\.json)$|\.(pyc|pyo)$/i.test(path);
}

const fileStamp = (info: Awaited<ReturnType<typeof lstat>>) => [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs, info.mode].join(':');
// Bounded, disposable cache for unchanged settings and legacy recovery fingerprints.
const fingerprintCache = new Map<string, { stamp: string; digest: string }>();
export async function sharedFileFingerprint(full: string) {
  const stamp = fileStamp(await lstat(full));
  const previous = fingerprintCache.get(full);
  if (previous?.stamp === stamp) return previous.digest;
  const digest = sharedHash(await stableRead({ full, stamp }));
  fingerprintCache.delete(full); fingerprintCache.set(full, { stamp, digest });
  while (fingerprintCache.size > 20_000) fingerprintCache.delete(fingerprintCache.keys().next().value!);
  return digest;
}
async function stableRead(file: { full: string; stamp: string }) {
  const data = await readFile(file.full);
  if (fileStamp(await lstat(file.full)) !== file.stamp) throw new Error('配置文件正在更新，请稍后重试 / configuration file changed during synchronization');
  return data;
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
/** Compatibility is declared by the package and checked against the host, never inferred from SSH. */
export function sharedPluginCompatibility(manifest: Record<string, unknown>, _config: unknown, platform: string, capabilities: Record<string, unknown>, capabilityIssue?: (name: string) => string | undefined) {
  const runtime = record(record(manifest.cardbush).runtime);
  if (Array.isArray(runtime.platforms) && !runtime.platforms.includes(platform)) return `此插件声明支持 ${runtime.platforms.join(', ')}，当前平台为 ${platform}；不代表主机无法配置桌面 / plugin platform mismatch`;
  // The service's desktop flags describe its optional built-in control backend,
  // not a plugin's own desktop/browser transport or the machine's display.
  const missing = Array.isArray(runtime.requires) ? runtime.requires.filter(value => typeof value === 'string' &&
    !['desktop', 'computerUse', 'browserUi'].includes(value) && capabilities[value] !== true) : [];
  if (missing.length) return [...new Set(missing.map(name => capabilityIssue?.(name) || `${name} 当前未就绪，可检查并配置后重试 / required host capability not ready`))].join('; ');
  // Interpreter paths and dependencies belong to the target Agent. Only the
  // package's explicit requirements can disable it during installation.
  return undefined;
}
