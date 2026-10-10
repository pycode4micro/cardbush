import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { ModelRequest } from '@cardbush/bush-protocol';
import sharp from 'sharp';

export async function normalizeWebImage(bytes: Buffer) {
  const decoder = sharp(bytes, { limitInputPixels: 16_000_000, failOn: 'warning' });
  const info = await decoder.metadata();
  if (!['jpeg', 'png', 'webp'].includes(info.format ?? '') || (info.pages ?? 1) !== 1) throw new Error('Only still PNG, JPEG and WebP images are supported.');
  return decoder.rotate().png().toBuffer();
}

export const WEB_BASE_TOOLS = ['read_file', 'inject_image_input', 'solution_selection', 'checkpoint_context', 'search_skills', 'run_skill'] as const;
export const WEB_IMAGE_TOOLS = ['seedream_capabilities', 'seedream_create_task', 'seedream_get_task', 'generation_wait_tasks'] as const;
export const WEB_IMAGE_PREFIX = 'mcp__plugin_volcengine_images_images__';
export function webToolAllowed(name: string) {
  return (WEB_BASE_TOOLS as readonly string[]).includes(name) || WEB_IMAGE_TOOLS.some(tool => name === WEB_IMAGE_PREFIX + tool);
}
const inside = (root: string, path: string) => { const rel = relative(root, path); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\')); };

/** Immutable deployment ceiling, checked before plugin hooks and again after input rewriting.
 * It is deliberately independent of ordinary user permission grants. */
export async function webToolDenial(request: ModelRequest | undefined, name: string, value: unknown): Promise<string | undefined> {
  if (request?.metadata.toolExecutionPolicy !== 'web_restricted') return;
  if (!webToolAllowed(name)) return 'This tool is not available in this deployment.';
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  if (input.environment !== undefined && input.environment !== 'local') return 'Only the account-local environment is available.';
  if (name !== 'read_file' && name !== 'inject_image_input') return;
  const candidate = input[name === 'read_file' ? 'path' : 'url'];
  if (typeof candidate !== 'string' || !candidate.trim() || /^(?:[a-z][a-z0-9+.-]*:\/\/|data:|\\\\)/i.test(candidate) || candidate.includes('\0')) return 'Only files in your personal folder are available.';
  const roots = request.metadata.webReadRoots;
  if (!Array.isArray(roots) || !roots.length || !roots.every(root => typeof root === 'string' && isAbsolute(root))) return 'The personal file boundary is unavailable.';
  try {
    const workspace = typeof request.metadata.workspaceDir === 'string' ? request.metadata.workspaceDir : '';
    if (!isAbsolute(candidate) && !workspace) return 'An account-local file path is required.';
    const path = await realpath(resolve(workspace, candidate));
    const canonicalRoots = await Promise.all(roots.map(root => realpath(root as string)));
    if (!canonicalRoots.some(root => inside(root, path))) return 'Access outside your personal folder is denied.';
    if (!(await stat(path)).isFile()) return 'Only regular personal files can be read.';
  } catch { return 'The requested personal file is unavailable.'; }
}
