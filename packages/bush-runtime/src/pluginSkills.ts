import { readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { load, JSON_SCHEMA } from 'js-yaml';
import type { PluginCommand } from './pluginExtensions.js';

type ObjectValue = Record<string, unknown>;
export async function skillPluginIdentity(path: string): Promise<{ id: string; root: string } | undefined> {
  let directory = dirname(path);
  for (let depth = 0; depth < 32; depth++, directory = dirname(directory)) {
    for (const manifest of ['plugin.json', '.codex-plugin/plugin.json', '.claude-plugin/plugin.json', '.cardbush-marketplace.json']) {
      try {
        const value = JSON.parse((await readFile(join(directory, manifest), 'utf8')).replace(/^\uFEFF/, ''));
        const name = manifest === '.cardbush-marketplace.json' ? value.entry?.name : value.name;
        if (manifest === 'plugin.json' && !String(value.$schema).startsWith('https://agent-plugins.org/')) continue;
        if (/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name ?? '')) return { id: name, root: directory };
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    if (dirname(directory) === directory) break;
  }
  return undefined;
}
export function parseSkillMarkdown(content: string) {
  const normalized = content.replace(/^\uFEFF/, '');
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (/^---\r?\n/.test(normalized) && !match) throw new Error('Skill frontmatter is not closed.');
  return { metadata: match ? yamlObject(match[1]!) : {}, body: match ? normalized.slice(match[0].length) : normalized };
}
function yamlObject(text: string): ObjectValue {
  const value = load(text, { schema: JSON_SCHEMA });
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Skill metadata must be a mapping.');
  return value as ObjectValue;
}
function object(value: unknown): ObjectValue { return value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {}; }
export function skillFlag(value: unknown, fallback: boolean) {
  if (value === undefined) return fallback;
  if (/^(true|yes|on|1)$/i.test(String(value))) return true;
  if (/^(false|no|off|0)$/i.test(String(value))) return false;
  throw new Error('Skill invocation policies must be booleans.');
}
export function skillToolRules(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const texts = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(texts) || texts.some(item => typeof item !== 'string')) throw new Error('Skill tool rules must be strings.');
  return texts.flatMap(text => text.match(/[^,\s()]+(?:\([^)]*\))?/g) ?? []);
}
export async function readPluginSkill(path: string, pluginId = '', root = dirname(path)) {
  const { metadata, body } = parseSkillMarkdown(await readFile(path, 'utf8'));
  const name = String(metadata.name || basename(dirname(path)));
  if (!/^[A-Za-z0-9_-]+$/.test(name) || !body.trim()) throw new Error(`Invalid Skill ${name}.`);
  const sidecarPath = join(dirname(path), 'agents', 'openai.yaml');
  let sidecar: ObjectValue = {};
  try {
    const resolved = await realpath(sidecarPath), rel = relative(await realpath(dirname(path)), resolved);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Skill metadata escapes its directory.');
    sidecar = yamlObject(await readFile(resolved, 'utf8'));
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  for (const key of ['policy', 'interface', 'dependencies']) {
    if (sidecar[key] !== undefined && (!sidecar[key] || typeof sidecar[key] !== 'object' || Array.isArray(sidecar[key]))) throw new Error(`Skill ${key} must be a mapping.`);
  }
  const policy = object(sidecar.policy), presentation = object(sidecar.interface);
  const dependencies = object(sidecar.dependencies).tools ?? [];
  if (!Array.isArray(dependencies)) throw new Error('Skill tool dependencies must be an array.');
  const issues: string[] = [];
  for (const key of ['paths']) if (metadata[key] !== undefined) issues.push(`skills.${name}: ${key}`);
  if (metadata.hooks !== undefined && (!metadata.hooks || typeof metadata.hooks !== 'object' || Array.isArray(metadata.hooks))) issues.push(`skills.${name}: hooks must be a mapping`);
  if (metadata.background !== undefined && (typeof metadata.background !== 'boolean' || metadata.context !== 'fork')) issues.push(`skills.${name}: background requires context: fork and a boolean`);
  if (metadata.context !== undefined && metadata.context !== 'fork') issues.push(`skills.${name}: unsupported context`);
  if (metadata.agent !== undefined && metadata.context !== 'fork') issues.push(`skills.${name}: agent requires context: fork`);
  const disallowedTools = skillToolRules(metadata['disallowed-tools']);
  if (disallowedTools?.some(rule => /[()*]/.test(rule))) issues.push(`skills.${name}: scoped disallowed-tools`);
  const command: PluginCommand = { kind: 'skill', id: pluginId ? `${pluginId}:${name}` : name, pluginId, root, path, name,
    ...(metadata.context === 'fork' ? { background: skillFlag(metadata.background, true) } : {}),
    description: String(metadata.description || presentation.short_description || ''), prompt: body,
    argumentHint: String(metadata['argument-hint'] || ''), arguments: [],
    allowedTools: skillToolRules(metadata['allowed-tools']), disallowedTools,
    userInvocable: skillFlag(metadata['user-invocable'], true),
    disableModelInvocation: skillFlag(metadata['disable-model-invocation'], false) || !skillFlag(policy.allow_implicit_invocation, true),
    shell: metadata.shell === 'powershell' ? 'powershell' : 'bash',
    ...(metadata.context === 'fork' ? { context: 'fork' as const, agent: String(metadata.agent || 'general-purpose') } : {}),
  };
  if (metadata.shell !== undefined && !['bash', 'powershell'].includes(String(metadata.shell))) issues.push(`skills.${name}: unsupported shell`);
  return { command, metadata, presentation, dependencies: dependencies.map(object), issues };
}
