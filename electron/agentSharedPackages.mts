import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { z } from 'zod';
import { safePackagePath } from './pluginPackagePaths.js';

export const sharedPackageLimits = { fileBytes: 16 * 1024 * 1024, bytes: 64 * 1024 * 1024, files: 2000, packages: 512 };
export const sharedDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const sharedFileSchema = z.object({ path: z.string().min(1), data: z.string(), mode: z.number().int().min(0).max(0o777) }).strict();
export const sharedPackageSchema = z.object({ files: z.array(sharedFileSchema).max(sharedPackageLimits.files) }).strict();
export const sharedPackagePathSchema = z.string().refine(value => {
  try { return /^(plugins|skills)\/[^/]+$/.test(value) && safePackagePath(value) === value; } catch { return false; }
}, 'Invalid shared package path');
export const sharedPackageReferenceSchema = z.object({ path: sharedPackagePathSchema, pluginId: z.string().max(200).optional(),
  digest: sharedDigestSchema.optional(), issue: z.string().max(1000).optional(),
}).strict().refine(value => Boolean(value.digest) !== Boolean(value.issue), 'A package needs a digest or an issue');
export type SharedPackageReference = z.infer<typeof sharedPackageReferenceSchema>;
export type SharedPackageArchive = { digest: string; data: Buffer };
export const sharedHash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** Generated environments are rebuilt by the plugin's target-platform launcher.
 * Do not use .gitignore: published dist/, models and other runtime assets may be ignored by Git. */
export function ignoredSharedPackagePath(path: string) {
  return /(^|\/)(\.git|\.venv|venv|\.tools|\.python|node_modules|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.tox|\.cache|\.uv|\.npm)(\/|$)/i.test(path) ||
    /(^|\/)(\.DS_Store|\.runtime-ready\.json)$|\.(pyc|pyo)$/i.test(path);
}

export class SharedPackageError extends Error {}
type FileRecord = { path: string; full: string; stamp: string; mode: number; size: number };
const fileStamp = (info: Awaited<ReturnType<typeof lstat>>) => [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs, info.mode].join(':');
export async function sharedPackageFiles(root: string): Promise<FileRecord[]> {
  const files: FileRecord[] = [];
  let bytes = 0;
  async function walk(path: string) {
    const full = path ? join(root, path) : root;
    const info = await lstat(full);
    if (info.isSymbolicLink()) throw new SharedPackageError(`${path || '.'}: 链接不属于独立文件包 / linked file is not portable`);
    if (info.isDirectory()) {
      for (const name of (await readdir(full)).sort()) {
        const child = path ? path + '/' + name : name;
        if (!ignoredSharedPackagePath(child)) await walk(child);
      }
    } else if (info.isFile()) {
      safePackagePath(path);
      if (info.size > sharedPackageLimits.fileBytes) throw new SharedPackageError(`${path}: ${(info.size / 1024 / 1024).toFixed(1)} MiB，超过单文件 16 MiB / exceeds file limit`);
      bytes += info.size;
      if (bytes > sharedPackageLimits.bytes || files.length >= sharedPackageLimits.files) throw new SharedPackageError(`${path}: 插件包超过 64 MiB / 2000 文件 / package exceeds limit`);
      files.push({ path, full, stamp: fileStamp(info), mode: info.mode & 0o777, size: info.size });
    }
  }
  await walk('');
  return files;
}

// Bounded, disposable caches. Content changes invalidate by file identity and timestamps;
// configuration-only updates neither reread nor recompress unchanged binary resources.
const archiveCache = new Map<string, { signature: string; archive: SharedPackageArchive }>();
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
async function stableRead(file: Pick<FileRecord, 'full' | 'stamp'>) {
  const data = await readFile(file.full);
  if (fileStamp(await lstat(file.full)) !== file.stamp) throw new SharedPackageError('插件正在更新，请稍后重试 / package changed during synchronization');
  return data;
}
export async function sharedPackageFingerprint(root: string) {
  try {
    const files = await sharedPackageFiles(root);
    const digest = createHash('sha256');
    for (const file of files) digest.update(JSON.stringify([file.path, file.mode, await sharedFileFingerprint(file.full)]));
    return digest.digest('hex');
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'; throw error; }
}
export async function packSharedPackage(root: string): Promise<SharedPackageArchive> {
  const files = await sharedPackageFiles(root);
  const signature = sharedHash(JSON.stringify(files.map(file => [file.path, file.stamp])));
  const cached = archiveCache.get(root);
  if (cached?.signature === signature) return cached.archive;
  const packed = [];
  for (const file of files) packed.push({ path: file.path, mode: file.mode, data: (await stableRead(file)).toString('base64') });
  const data = gzipSync(JSON.stringify({ files: packed }));
  if (data.length > sharedPackageLimits.bytes) throw new SharedPackageError('压缩包超过 64 MiB / archive exceeds limit');
  const archive = { digest: sharedHash(data), data };
  archiveCache.delete(root); archiveCache.set(root, { signature, archive });
  let bytes = [...archiveCache.values()].reduce((sum, item) => sum + item.archive.data.length, 0);
  while (archiveCache.size > 128 || bytes > 128 * 1024 * 1024) {
    const key = archiveCache.keys().next().value!;
    bytes -= archiveCache.get(key)!.archive.data.length; archiveCache.delete(key);
  }
  return archive;
}

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
/** Compatibility is declared by the package and checked against the host, never inferred from SSH. */
export function sharedPluginCompatibility(manifest: Record<string, unknown>, config: unknown, platform: string, capabilities: Record<string, unknown>) {
  const runtime = record(record(manifest.cardbush).runtime);
  if (Array.isArray(runtime.platforms) && !runtime.platforms.includes(platform)) return `需要 ${runtime.platforms.join(', ')} / unsupported Agent platform: ${platform}`;
  const missing = Array.isArray(runtime.requires) ? runtime.requires.filter(value => typeof value === 'string' && capabilities[value] !== true) : [];
  if (missing.length) return `Agent 未提供 ${missing.join(', ')} 能力 / required host capability unavailable`;
  const policies = record(record(config).mcp_servers);
  for (const [name, declaration] of Object.entries(record(manifest.mcpServers))) {
    const policy = record(policies[name]);
    if (policy.enabled === false) continue;
    const server = { ...record(declaration), ...record(policy.connection) };
    if (server.url || server.type && server.type !== 'stdio') continue;
    const command = String(server.command ?? '');
    const args = Array.isArray(server.args) ? server.args.map(String) : [];
    if (platform !== 'win32' && (/(?:^|[\\/])(powershell(?:\.exe)?|cmd(?:\.exe)?)$/i.test(command) || /\.exe$/i.test(command) ||
        [command, ...args, String(server.cwd ?? '')].some(value => /^[A-Za-z]:[\\/]|^\\\\/.test(value)))) return `MCP ${name} 使用 Windows 启动命令或路径，需要目标平台启动方式 / Windows-only launcher`;
  }
  return undefined;
}
