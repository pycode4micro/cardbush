import { readFile, readdir, lstat, realpath } from 'node:fs/promises';
import { basename, extname, join, resolve, relative, isAbsolute } from 'node:path';
import { load as yaml, JSON_SCHEMA } from 'js-yaml';
import type { PluginAgent, PluginHook, PluginHookEvent, PluginCommand } from '@cardbush/bush-runtime' with { 'resolution-mode': 'import' };
import type { PluginMarketPreview } from './pluginMarketplaceTypes';
import type { PluginFormat } from './pluginManifest';
import { createHash } from 'node:crypto';

type Json = Record<string, unknown>;
const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const hookEvents = new Set(['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'PreCompact', 'PostCompact', 'Stop', 'Interrupt', 'SubagentStart', 'SubagentStop']);

/** Read original declarations at both preview and runtime; no executable content runs during inspection. */
export async function readPluginExtensions(root: string, manifest: Json, options: { format?: PluginFormat; scope?: PluginHook['scope']; hooksOnly?: boolean } = {}) {
  const pluginId = String(manifest.name);
  const hooks: PluginHook[] = [], agents: PluginAgent[] = [], commands: PluginCommand[] = [], issues: PluginMarketPreview['issues'] = [], notes: string[] = [];
  const addIssue = (detail: string) => issues.push({ code: 'extension', detail });
  if (options.scope && manifest.hooks !== undefined && (!manifest.hooks || typeof manifest.hooks !== 'object' || Array.isArray(manifest.hooks))) {
    addIssue(`${options.scope.id}: hooks must be an event mapping`); return { hooks, agents, commands, issues, notes };
  }
  const hookSources: unknown[] = manifest.hooks === undefined ? [] : Array.isArray(manifest.hooks) ? [...manifest.hooks] : [manifest.hooks];
  const defaultHooks = './hooks/hooks.json';
  if (!options.scope && (manifest.hooks === undefined || options.format === 'claude') && await exists(join(root, defaultHooks)) && !hookSources.some(value => typeof value === 'string' && resolve(root, value) === join(root, defaultHooks))) hookSources.unshift(defaultHooks);
  for (const source of hookSources) {
    const config = typeof source === 'string' ? object(JSON.parse(await readFile(await pluginChild(root, source), 'utf8'))) : object(source);
    for (const [event, raw] of Object.entries(object(config.hooks ?? config))) {
      if (!Array.isArray(raw)) { addIssue(`hooks.${event}: invalid event configuration`); continue; }
      for (const group of raw) {
        const row = object(group), matcher = typeof row.matcher === 'string' ? row.matcher : '';
        if (matcher.length > 256 || Object.keys(row).some(key => !['matcher', 'hooks'].includes(key))) { addIssue(`hooks.${event}: unsupported matcher options`); continue; }
        if (!Array.isArray(row.hooks)) { addIssue(`hooks.${event}: missing handlers`); continue; }
        try { if (matcher && matcher !== '*' && !['Stop', 'Interrupt', 'UserPromptSubmit'].includes(event)) new RegExp(matcher); } catch { addIssue(`hooks.${event}: invalid matcher`); continue; }
        for (const candidate of row.hooks) {
          const hook = object(candidate);
          if (!hookEvents.has(event) || !['command', 'mcp_tool', 'prompt', 'agent', ...(options.format === 'claude' ? ['http'] : [])].includes(String(hook.type))) { addIssue(`hooks.${event}: ${String(hook.type)} handler`); continue; }
          const modelHook = hook.type === 'prompt' || hook.type === 'agent';
          const skipped = modelHook && options.format !== 'claude';
          const unsupported = Object.keys(hook).filter(key => !['type', 'command', 'commandWindows', 'args', 'shell', 'timeout', 'statusMessage', 'once', 'async', 'additionalContextLimit', 'server', 'tool', 'input', 'prompt', 'model', 'continueOnBlock', 'url', 'headers', 'allowedEnvVars'].includes(key) && hook[key] !== false);
          if (unsupported.length) { addIssue(`hooks.${event}: ${unsupported.join(', ')}`); continue; }
          if (modelHook && !skipped && (!['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'Stop', 'SubagentStop', 'PermissionRequest'].includes(event) || typeof hook.prompt !== 'string' || !hook.prompt.trim() || hook.prompt.length > 32000 || hook.async === true)) { addIssue(`hooks.${event}: invalid model hook`); continue; }
          if (hook.continueOnBlock !== undefined && (hook.type !== 'prompt' || typeof hook.continueOnBlock !== 'boolean')) { addIssue(`hooks.${event}: invalid continueOnBlock`); continue; }
          if (hook.type === 'http') {
            let url: URL; try { url = new URL(String(hook.url)); } catch { addIssue(`hooks.${event}: invalid HTTP URL`); continue; }
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || hook.async === true || (hook.headers !== undefined && (!hook.headers || typeof hook.headers !== 'object' || Array.isArray(hook.headers))) || Object.values(object(hook.headers)).some(value => typeof value !== 'string') || (hook.allowedEnvVars !== undefined && (!Array.isArray(hook.allowedEnvVars) || hook.allowedEnvVars.some(value => typeof value !== 'string' || !/^[A-Za-z_]\w*$/.test(value))))) { addIssue(`hooks.${event}: invalid HTTP hook configuration`); continue; }
          }
          if (hook.type === 'command' && (typeof hook.command !== 'string' || !hook.command.trim())) { addIssue(`hooks.${event}: missing command`); continue; }
          if (hook.type === 'mcp_tool' && (!String(hook.server ?? '').trim() || !String(hook.tool ?? '').trim() || (hook.input !== undefined && (!hook.input || typeof hook.input !== 'object' || Array.isArray(hook.input))))) { addIssue(`hooks.${event}: invalid MCP handler`); continue; }
          if (hook.type === 'mcp_tool' && (hook.async === true || event === 'SessionEnd')) { addIssue(`hooks.${event}: MCP hooks must be synchronous and cannot run at SessionEnd`); continue; }
          if (hook.async !== undefined && typeof hook.async !== 'boolean') { addIssue(`hooks.${event}: async must be a boolean`); continue; }
          if (hook.commandWindows !== undefined && typeof hook.commandWindows !== 'string') { addIssue(`hooks.${event}: invalid Windows command`); continue; }
          if (hook.additionalContextLimit !== undefined && (!Number.isInteger(hook.additionalContextLimit) || Number(hook.additionalContextLimit) < 0)) { addIssue(`hooks.${event}: invalid additionalContextLimit`); continue; }
          if (hook.shell && !['bash', 'powershell', 'cmd'].includes(String(hook.shell))) { addIssue(`hooks.${event}: unsupported shell`); continue; }
          if (hook.args !== undefined && (!Array.isArray(hook.args) || hook.args.some(arg => typeof arg !== 'string'))) { addIssue(`hooks.${event}: invalid args`); continue; }
          const ending = event === 'SessionEnd' || event === 'Interrupt';
          const timeout = hook.timeout === undefined ? ending ? 1 : modelHook && !skipped ? hook.type === 'agent' ? 60 : 30 : 600 : Number(hook.timeout);
          if (!Number.isFinite(timeout) || timeout <= 0 || (ending && (timeout < 1 || timeout > 3))) { addIssue(`hooks.${event}: invalid timeout${ending ? ' (1–3 seconds)' : ''}`); continue; }
          const definition = { event, matcher, handler: hook, ...(options.scope ? { scope: options.scope } : {}) };
          const definitionHash = createHash('sha256').update(JSON.stringify(stableJson({ root: resolve(root), ...definition }))).digest('hex');
          if (skipped) notes.push(`Hook ${event}: ${hook.type} handlers are parsed but skipped, matching OpenAI.`);
          if (hook.type === 'agent' && !skipped) notes.push(`Hook ${event}: CardBush agent handlers use read_file / search_file_content only; write, terminal and delegation tools are unavailable.`);
          if (modelHook && !skipped && hook.model && hook.model !== 'inherit') notes.push(`Hook ${event}: model ${String(hook.model)} uses CardBush's current model binding.`);
          hooks.push({ id: `${pluginId}:${event}:${hooks.length}`, pluginId, root, dialect: options.format === 'claude' ? 'claude' : 'openai', event: event as PluginHookEvent, matcher,
            ...(options.scope ? { scope: options.scope, id: `${options.scope.kind}:${options.scope.id}:${event}:${hooks.length}`, ...(options.scope.kind === 'agent' && event === 'Stop' ? { event: 'SubagentStop' as const } : {}) } : {}),
            type: hook.type as PluginHook['type'], command: typeof hook.command === 'string' ? hook.command : '',
            ...(modelHook ? { prompt: String(hook.prompt ?? ''), model: String(hook.model ?? 'inherit'), continueOnBlock: hook.continueOnBlock === true } : {}),
            ...(hook.type === 'http' ? { url: String(hook.url), headers: object(hook.headers) as Record<string, string>, allowedEnvVars: hook.allowedEnvVars as string[] | undefined } : {}),
            ...(hook.commandWindows !== undefined ? { commandWindows: hook.commandWindows as string } : {}),
            ...(hook.type === 'mcp_tool' ? { server: String(hook.server), tool: String(hook.tool), input: object(hook.input) } : {}),
            async: hook.async === true && event !== 'SessionEnd', statusMessage: typeof hook.statusMessage === 'string' ? hook.statusMessage : undefined,
            additionalContextLimit: hook.additionalContextLimit as number | undefined, definition, definitionHash,
            ...(hook.args !== undefined ? { args: hook.args as string[] } : {}),
            ...(hook.shell ? { shell: hook.shell as PluginHook['shell'] } : {}), timeout, once: hook.once === true });
        }
      }
    }
  }
  if (options.hooksOnly) return { hooks, agents, commands, issues, notes };
  const paths = manifest.agents === undefined ? await exists(join(root, 'agents')) ? ['./agents'] : [] : strings(manifest.agents);
  for (const path of paths) {
    const target = await pluginChild(root, path);
    const files = (await lstat(target)).isDirectory() ? await markdownFiles(target) : [target];
    for (const file of files) {
      const { metadata, body } = parsePluginMarkdown(await readFile(file, 'utf8'));
      const name = typeof metadata.name === 'string' && metadata.name.trim() ? metadata.name.trim() : basename(file, extname(file));
      if (!/^[a-zA-Z0-9_-]+$/.test(name) || !body.trim()) { addIssue(`agents.${name}: invalid name or empty prompt`); continue; }
      if (metadata.memory !== undefined && !['user', 'project', 'local'].includes(String(metadata.memory))) { addIssue(`agents.${name}: invalid memory scope`); continue; }
      if (metadata.isolation !== undefined && metadata.isolation !== 'worktree') { addIssue(`agents.${name}: invalid isolation`); continue; }
      if (metadata.background !== undefined && typeof metadata.background !== 'boolean') { addIssue(`agents.${name}: background must be boolean`); continue; }
      if (metadata.permissionMode !== undefined && !['default', 'acceptEdits', 'dontAsk', 'bypassPermissions', 'plan'].includes(String(metadata.permissionMode))) { addIssue(`agents.${name}: invalid permissionMode`); continue; }
      if (metadata.mcpServers !== undefined && (!Array.isArray(metadata.mcpServers) || metadata.mcpServers.some(item => typeof item !== 'string' && (!item || typeof item !== 'object' || Array.isArray(item) || Object.values(item).some(value => !value || typeof value !== 'object' || Array.isArray(value)))))) { addIssue(`agents.${name}: invalid mcpServers`); continue; }
      const toolList = (value: unknown) => value === undefined ? undefined : strings(value).flatMap(item => item.split(',')).map(item => item.trim()).filter(Boolean);
      const tools = toolList(metadata.tools), disallowedTools = toolList(metadata.disallowedTools);
      if (tools?.some(tool => /^LSP$/i.test(tool))) { addIssue(`agents.${name}: requires LSP, which CardBush does not run`); continue; }
      if ([...tools ?? [], ...disallowedTools ?? []].some(tool => /[()*]/.test(tool) && !/^mcp__[\w.-]+(?:__\*)?$|^mcp__\*$/.test(tool))) { addIssue(`agents.${name}: scoped tool rules`); continue; }
      const maxTurns = metadata.maxTurns === undefined ? undefined : Number(metadata.maxTurns);
      if (maxTurns !== undefined && (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 100)) { addIssue(`agents.${name}: invalid maxTurns`); continue; }
      if (metadata.model && metadata.model !== 'inherit') notes.push(`Agent ${name}: model inherits CardBush's child Agent configuration (${String(metadata.model)} is a Claude model alias).`);
      if (metadata.effort) notes.push(`Agent ${name}: reasoning effort inherits the current session.`);
      if (metadata.hooks !== undefined) {
        const local = await readPluginExtensions(root, { name: pluginId, hooks: metadata.hooks }, { ...options, hooksOnly: true, scope: { kind: 'agent', id: `${pluginId}:${name}` } });
        hooks.push(...local.hooks); issues.push(...local.issues); notes.push(...local.notes);
      }
      const definitionHash = createHash('sha256').update(JSON.stringify(stableJson({ root: resolve(root), agent: name, metadata, body }))).digest('hex');
      agents.push({ id: `${pluginId}:${name}`, pluginId, root, name, description: String(metadata.description ?? ''), prompt: body, tools, disallowedTools, maxTurns,
        definitionHash, memory: metadata.memory as PluginAgent['memory'], isolation: metadata.isolation as PluginAgent['isolation'], background: metadata.background as boolean | undefined,
        permissionMode: metadata.permissionMode as PluginAgent['permissionMode'], mcpServers: metadata.mcpServers as PluginAgent['mcpServers'],
        ...(metadata.skills !== undefined ? { skills: strings(metadata.skills).map(name => ({ name, path: '', prompt: '' })) } : {}) });
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
      const unsupported: string[] = [];
      if (metadata.background !== undefined && (typeof metadata.background !== 'boolean' || metadata.context !== 'fork')) unsupported.push('background requires context: fork and a boolean');
      if (metadata.context !== undefined && metadata.context !== 'fork') unsupported.push('context');
      if (metadata.agent !== undefined && metadata.context !== 'fork') unsupported.push('agent requires context: fork');
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
      if (metadata.hooks !== undefined) {
        const local = await readPluginExtensions(root, { name: pluginId, hooks: metadata.hooks }, { ...options, hooksOnly: true, scope: { kind: 'skill', id: `${pluginId}:${name}` } });
        hooks.push(...local.hooks); issues.push(...local.issues); notes.push(...local.notes);
      }
      commands.push({ id: `${pluginId}:${name}`, pluginId, root, path: file, name,
        description: String(metadata.description ?? body.trim().split(/\r?\n/)[0]).slice(0, 1536), prompt: body,
        argumentHint: String(metadata['argument-hint'] ?? ''), arguments: argumentNames, allowedTools, disallowedTools,
        userInvocable: flag(metadata['user-invocable'], true), disableModelInvocation: flag(metadata['disable-model-invocation'], false),
        shell: metadata.shell === 'powershell' ? 'powershell' : 'bash',
        ...(metadata.context === 'fork' ? { context: 'fork', agent: String(metadata.agent || 'general-purpose'), background: metadata.background !== false } : {}) });
    }
  }
  if (new Set(commands.map(command => command.id)).size !== commands.length) addIssue('commands: duplicate names');
  if (hooks.length > 100 || agents.length > 100 || commands.length > 100) addIssue('Plugin exceeds 100 Hooks, Agents or Commands.');
  return { hooks, agents, commands, issues, notes };
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stableJson(item)]));
  return value;
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
