import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { ModelRequest } from '@cardbush/bush-protocol';
import { remoteResponseSchema } from '@cardbush/bush-protocol';
import { z } from 'zod';
import sharp from 'sharp';

export async function normalizeWebImage(bytes: Buffer) {
  const decoder = sharp(bytes, { limitInputPixels: 16_000_000, failOn: 'warning' });
  const info = await decoder.metadata();
  if (!['jpeg', 'png', 'webp'].includes(info.format ?? '') || (info.pages ?? 1) !== 1) throw new Error('Only still PNG, JPEG and WebP images are supported.');
  return decoder.rotate().png().toBuffer();
}

export const WEB_BASE_TOOLS = ['read_file', 'inject_image_input', 'request_user_input_async', 'checkpoint_context', 'search_skills', 'run_skill'] as const;
export const WEB_IMAGE_TOOLS = ['seedream_capabilities', 'seedream_create_task', 'seedream_get_task', 'generation_wait_tasks', 'image_convert', 'image_stitch'] as const;
export const WEB_IMAGE_PREFIX = 'mcp__plugin_volcengine_images_images__';
export const WEB_REMOTE_TOOLS = ['list_subagent_options', 'subagent', 'tasks'] as const;
export function webToolAllowed(name: string) {
  return (WEB_BASE_TOOLS as readonly string[]).includes(name) || (WEB_REMOTE_TOOLS as readonly string[]).includes(name) || WEB_IMAGE_TOOLS.some(tool => name === WEB_IMAGE_PREFIX + tool);
}
export function webToolDefinition<T extends ModelRequest['tools'][number]>(tool: T): T {
  if (tool.name === 'list_subagent_options') return { ...tool, description: 'List only administrator-registered remote Agents authorized for this account. Use an exact returned id as subagent.target_agent. No local Agents, roles, auto-assembly, model or plugin synchronization is available.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } };
  if (tool.name !== 'subagent') return tool;
  return { ...tool, description: 'Asynchronously delegate to an authorized remote worker. For new work provide prompt and target_agent from list_subagent_options. Follow up with task_id and prompt, optionally delivery queue/insert; answer a pending interaction with task_id and response. Inspect pending questions/permissions with tasks. Never create local Agents or copy parent history, credentials, files or configuration. The worker retains its own model, tools and authority; human-required approvals cannot be granted by the parent model.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      prompt: { type: 'string', minLength: 1, maxLength: 100000, description: 'Self-contained assignment or message. Required unless response supplies the complete reply. No credentials or personal file paths.' },
      target_agent: { type: 'string', minLength: 1, description: 'Authorized remote Agent id; required for new work.' },
      task_id: { type: 'string', minLength: 1, description: 'Owned remote task id for a follow-up; do not combine with target_agent.' },
      delivery: { type: 'string', enum: ['queue', 'insert'], description: 'task_id and prompt only: queue a later run, or insert guidance into the exact active run. Do not combine with response.' },
      response: { ...z.toJSONSchema(remoteResponseSchema), description: 'task_id only: answer an observed question or submit an exact structured permission decision. Authority is validated on the worker, never supplied here.' },
    } } };
}
const inside = (root: string, path: string) => { const rel = relative(root, path); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\')); };

/** Immutable deployment ceiling, checked before plugin hooks and again after input rewriting.
 * It is deliberately independent of ordinary user permission grants. */
export async function webToolDenial(request: ModelRequest | undefined, name: string, value: unknown): Promise<string | undefined> {
  if (request?.metadata.toolExecutionPolicy !== 'web_restricted') return;
  if (!webToolAllowed(name)) return 'This tool is not available in this deployment.';
  // The provider adds this host-owned presentation field to every tool call.
  // Check business arguments at both gates, before hooks and after rewriting.
  const { _display_title: _displayTitle, ...input } = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  if (name === 'list_subagent_options' && Object.keys(input).length) return 'Only the authorized remote Agent list is available.';
  if (name === 'subagent') {
    const replying = input.response !== undefined;
    if (Object.keys(input).some(key => !['prompt', 'target_agent', 'task_id', 'delivery', 'response'].includes(key)) ||
        ((!replying || input.prompt !== undefined) && (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 100000)) ||
        Boolean(input.target_agent) === Boolean(input.task_id) ||
        (input.delivery !== undefined && (!input.task_id || !['queue', 'insert'].includes(String(input.delivery)) || replying)) ||
        (replying && (!input.task_id || !remoteResponseSchema.safeParse(input.response).success)) ||
        [input.target_agent, input.task_id].some(value => value !== undefined && (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value))))
      return 'Only authorized remote delegation or owned task messages/responses are allowed. Local Agents, configuration overrides and caller-supplied approval authority are forbidden.';
  }
  if (input.environment !== undefined && input.environment !== 'local') return 'Only the account-local environment is available.';
  const conversion = name === WEB_IMAGE_PREFIX + 'image_convert';
  const stitching = name === WEB_IMAGE_PREFIX + 'image_stitch';
  const imageOperation = conversion || stitching;
  if (name !== 'read_file' && name !== 'inject_image_input' && !imageOperation) return;
  const imageRequest = input.request as Record<string, unknown> | undefined;
  const candidates = stitching ? imageRequest?.source_paths : [conversion ? imageRequest?.source_path : input[name === 'read_file' ? 'path' : 'url']];
  if (!Array.isArray(candidates) || (stitching && (candidates.length < 2 || candidates.length > 64))) return 'Stitching requires 2 to 64 personal image paths.';
  const roots = request.metadata.webReadRoots;
  if (!Array.isArray(roots) || !roots.length || !roots.every(root => typeof root === 'string' && isAbsolute(root))) return 'The personal file boundary is unavailable.';
  try {
    const workspace = typeof request.metadata.workspaceDir === 'string' ? request.metadata.workspaceDir : '';
    // AgentService publishes the personal folder first; later roots contain read-only plugin skills.
    const canonicalRoots = await Promise.all((imageOperation ? roots.slice(0, 1) : roots).map(root => realpath(root as string)));
    for (const candidate of candidates) {
      if (typeof candidate !== 'string' || !candidate.trim() || /^(?:[a-z][a-z0-9+.-]*:\/\/|data:|\\\\)/i.test(candidate) || candidate.includes('\0')) return 'Only files in your personal folder are available.';
      if (imageOperation && !isAbsolute(candidate)) return 'An absolute personal image path is required.';
      if (!isAbsolute(candidate) && !workspace) return 'An account-local file path is required.';
      const path = await realpath(resolve(workspace, candidate));
      if (!canonicalRoots.some(root => inside(root, path))) return 'Access outside your personal folder is denied.';
      if (!(await stat(path)).isFile()) return 'Only regular personal files can be read.';
    }
  } catch { return 'The requested personal file is unavailable.'; }
}
