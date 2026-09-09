import { readFile, readdir, lstat, realpath } from 'node:fs/promises';
import { basename, extname, join, resolve, relative, isAbsolute } from 'node:path';
import { load as yaml, JSON_SCHEMA } from 'js-yaml';
import type { PluginAgent, PluginHook, PluginHookEvent, PluginCommand } from '@cardbush/bush-runtime' with { 'resolution-mode': 'import' };
import type { PluginMarketPreview } from './pluginMarketplaceTypes';

type Json = Record<string, unknown>;
const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const hookEvents = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SubagentStart', 'SubagentStop']);

/** Read original declarations at both preview and runtime; no executable content runs during inspection. */
export async function readPluginExtensions(root: string, manifest: Json) {
  const pluginId = String(manifest.name);
  const hooks: PluginHook[] = [], agents: PluginAgent[] = [], commands: PluginCommand[] = [], issues: PluginMarketPreview['issues'] = [], notes: string[] = [];
  const addIssue = (detail: string) => issues.push({ code: 'extension', detail });
  const hookSources: unknown[] = manifest.hooks === undefined ? [] : Array.isArray(manifest.hooks) ? [...manifest.hooks] : [manifest.hooks];
  const defaultHooks = './hooks/hooks.json';
  if (await exists(join(root, defaultHooks)) && !hookSources.some(value => typeof value === 'string' && resolve(root, value) === join(root, defaultHooks))) hookSources.unshift(defaultHooks);
  for (const source of hookSources) {
    const config = typeof source === 'string' ? object(JSON.parse(await readFile(await pluginChild(root, source), 'utf8'))) : object(source);
    for (const [event, raw] of Object.entries(object(config.hooks ?? config))) {
      if (!Array.isArray(raw)) { addIssue(`hooks.${event}: invalid event configuration`); continue; }
      for (const group of raw) {
        const row = object(group), matcher = typeof row.matcher === 'string' ? row.matcher : '';
        if (matcher.length > 256 || Object.keys(row).some(key => !['matcher', 'hooks'].includes(key))) { addIssue(`hooks.${event}: unsupported matcher options`); continue; }
        if (!Array.isArray(row.hooks)) { addIssue(`hooks.${event}: missing handlers`); continue; }
        try { if (matcher) new RegExp(matcher); } catch { addIssue(`hooks.${event}: invalid matcher`); continue; }
        for (const candidate of row.hooks) {
          const hook = object(candidate);
          if (!hookEvents.has(event) || hook.type !== 'command') { addIssue(`hooks.${event}: ${String(hook.type)} handler`); continue; }
          const unsupported = Object.keys(hook).filter(key => !['type', 'command', 'args', 'shell', 'timeout', 'statusMessage', 'once'].includes(key) && hook[key] !== false);
          if (unsupported.length) { addIssue(`hooks.${event}: ${unsupported.join(', ')}`); continue; }
          if (typeof hook.command !== 'string' || !hook.command.trim()) { addIssue(`hooks.${event}: missing command`); continue; }
          if (hook.shell && !['bash', 'powershell', 'cmd'].includes(String(hook.shell))) { addIssue(`hooks.${event}: unsupported shell`); continue; }
          if (hook.args !== undefined && (!Array.isArray(hook.args) || hook.args.some(arg => typeof arg !== 'string'))) { addIssue(`hooks.${event}: invalid args`); continue; }
          const timeout = hook.timeout === undefined ? 30 : Number(hook.timeout);
          if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 600) { addIssue(`hooks.${event}: timeout must be 0–600 seconds`); continue; }
          hooks.push({ id: `${pluginId}:${event}:${hooks.length}`, pluginId, root, event: event as PluginHookEvent, matcher,
            command: hook.command, ...(hook.args !== undefined ? { args: hook.args as string[] } : {}),
            ...(hook.shell ? { shell: hook.shell as PluginHook['shell'] } : {}), timeout, once: hook.once === true });
        }
      }
    }
  }
  const paths = manifest.agents === undefined ? await exists(join(root, 'agents')) ? ['./agents'] : [] : strings(manifest.agents);
  for (const path of paths) {
    const target = await pluginChild(root, path);
    const files = (await lstat(target)).isDirectory() ? await markdownFiles(target) : [target];
    for (const file of files) {
      const { metadata, body } = parsePluginMarkdown(await readFile(file, 'utf8'));
      const name = typeof metadata.name === 'string' && metadata.name.trim() ? metadata.name.trim() : basename(file, extname(file));
      if (!/^[a-zA-Z0-9_-]+$/.test(name) || !body.trim()) { addIssue(`agents.${name}: invalid name or empty prompt`); continue; }
      const unsupported = ['hooks', 'skills', 'memory', 'isolation', 'mcpServers', 'permissionMode'].filter(key => metadata[key] !== undefined);
      if (metadata.background === true) unsupported.push('background');
      if (unsupported.length) { addIssue(`agents.${name}: ${unsupported.join(', ')}`); continue; }
      const toolList = (value: unknown) => value === undefined ? undefined : strings(value).flatMap(item => item.split(',')).map(item => item.trim()).filter(Boolean);
      const tools = toolList(metadata.tools), disallowedTools = toolList(metadata.disallowedTools);
      if ([...tools ?? [], ...disallowedTools ?? []].some(tool => /[()*]/.test(tool))) { addIssue(`agents.${name}: scoped tool rules`); continue; }
      const maxTurns = metadata.maxTurns === undefined ? undefined : Number(metadata.maxTurns);
      if (maxTurns !== undefined && (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 100)) { addIssue(`agents.${name}: invalid maxTurns`); continue; }
      if (metadata.model && metadata.model !== 'inherit') notes.push(`Agent ${name}: model inherits CardBush's child Agent configuration (${String(metadata.model)} is a Claude model alias).`);
      if (metadata.effort) notes.push(`Agent ${name}: reasoning effort inherits the current session.`);
      agents.push({ id: `${pluginId}:${name}`, pluginId, root, name, description: String(metadata.description ?? ''), prompt: body, tools, disallowedTools, maxTurns });
    }
  }
  if (new Set(agents.map(agent => agent.id)).size !== agents.length) addIssue('agents: duplicate names');
  const commandPaths = manifest.commands === undefined ? await exists(join(root, 'commands')) ? ['./commands'] : [] : strings(manifest.commands);
  for (const path of commandPaths) {
    const target = await pluginChild(root, path);
    const files = (await lstat(target)).isDirectory() ? await markdownFiles(target) : [target];
    for (const file of files) {
      const { metadata, body } = parsePluginMarkdown(await readFile(file, 'utf8'));
      const name = basename(file, extname(file));
      if (!/^[a-zA-Z0-9_-]+$/.test(name) || !body.trim()) { addIssue(`commands.${name}: invalid name or empty prompt`); continue; }
      const unsupported = ['context', 'agent', 'hooks', 'background'].filter(key => metadata[key] !== undefined);
      if (unsupported.length) { addIssue(`commands.${name}: ${unsupported.join(', ')}`); continue; }
      if (metadata.shell && !['bash', 'powershell'].includes(String(metadata.shell))) { addIssue(`commands.${name}: unsupported shell`); continue; }
      const argumentNames = metadata.arguments === undefined ? [] : strings(metadata.arguments).flatMap(value => value.split(/\s+/)).filter(Boolean);
      if (argumentNames.some(value => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value))) { addIssue(`commands.${name}: invalid argument names`); continue; }
      if (argumentNames.some(value => /^(ARGUMENTS|HOME|PATH|CODEX_HOME|CLAUDE_.*|CARDBUSH_.*|CODEX_PLUGIN_ROOT)$/i.test(value))) { addIssue(`commands.${name}: reserved argument names`); continue; }
      const allowedTools = metadata['allowed-tools'] === undefined ? undefined : toolRules(metadata['allowed-tools']);
      const disallowedTools = metadata['disallowed-tools'] === undefined ? undefined : toolRules(metadata['disallowed-tools']);
      if (disallowedTools?.some(value => /[()*]/.test(value))) { addIssue(`commands.${name}: scoped disallowed-tools`); continue; }
      if (metadata.model && metadata.model !== 'inherit') notes.push(`Command ${name}: model inherits the current CardBush session (${String(metadata.model)} is not selected automatically).`);
      if (allowedTools?.length) notes.push(`Command ${name}: declared tool preapprovals remain subject to CardBush permissions.`);
      commands.push({ id: `${pluginId}:${name}`, pluginId, root, path: file, name,
        description: String(metadata.description ?? body.trim().split(/\r?\n/)[0]).slice(0, 1536), prompt: body,
        argumentHint: String(metadata['argument-hint'] ?? ''), arguments: argumentNames, allowedTools, disallowedTools,
        userInvocable: flag(metadata['user-invocable'], true), disableModelInvocation: flag(metadata['disable-model-invocation'], false),
        shell: metadata.shell === 'powershell' ? 'powershell' : 'bash' });
    }
  }
  if (new Set(commands.map(command => command.id)).size !== commands.length) addIssue('commands: duplicate names');
  if (hooks.length > 100 || agents.length > 100 || commands.length > 100) addIssue('Plugin exceeds 100 Hooks, Agents or Commands.');
  return { hooks, agents, commands, issues, notes };
}

function toolRules(value: unknown): string[] {
  return strings(value).flatMap(text => text.match(/[^,\s()]+(?:\([^)]*\))?/g) ?? []);
}
function flag(value: unknown, fallback: boolean) {
  if (value === undefined) return fallback;
  if (/^(true|yes|on|1)$/i.test(String(value))) return true;
  if (/^(false|no|off|0)$/i.test(String(value))) return false;
  throw new Error('Command invocation flags must be booleans.');
}

export function parsePluginMarkdown(content: string): { metadata: Json; body: string } {
  const match = content.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return match ? { metadata: object(yaml(match[1], { schema: JSON_SCHEMA })), body: content.replace(/^\uFEFF/, '').slice(match[0].length) } : { metadata: {}, body: content };
}
export async function pluginChild(root: string, value: string) {
  if (isAbsolute(value)) throw new Error('Plugin component paths must be relative.');
  const file = resolve(root, value), rel = relative(await realpath(root), await realpath(file));
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Plugin component path escapes its root.');
  return file;
}
export async function markdownFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const item of await readdir(root, { withFileTypes: true })) {
    if (item.isSymbolicLink()) throw new Error('Plugin components cannot contain symbolic links.');
    if (item.isDirectory()) result.push(...await markdownFiles(join(root, item.name)));
    else if (item.name.endsWith('.md')) result.push(join(root, item.name));
    if (result.length > 100) throw new Error('Plugin contains too many component files.');
  }
  return result;
}
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) return value;
  throw new Error('Plugin component paths and tool names must be strings.');
}
async function exists(file: string) { return Boolean(await lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; })); }
