import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pluginChild, readPluginExtensions } from './pluginExtensions';

type Json = Record<string, unknown>;
export type PluginFormat = 'agent-plugins' | 'openai' | 'claude';
const pluginSchema = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const mcpSchema = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
const componentKeys = ['skills', 'mcpServers', 'hooks', 'agents', 'commands', 'lspServers', 'dependencies', 'apps', 'userConfig', 'channels', 'experimental', 'themes', 'monitors', 'workflows', 'outputStyles'];

/** One read model for preview, installation and execution. Never rewrites the package. */
export async function resolvePluginManifest(root: string) {
  const portable = await jsonIfPresent(join(root, 'plugin.json'));
  if (portable?.$schema && String(portable.$schema).startsWith('https://agent-plugins.org/') && portable.$schema !== pluginSchema) {
    throw new Error(`Unsupported Agent Plugins schema: ${portable.$schema}`);
  }
  const recognized = portable?.$schema === pluginSchema;
  const receipt = await jsonIfPresent(join(root, '.cardbush-marketplace.json'));
  const entry = object(receipt?.entry);
  const inline = object(portable?.extensions)['com.openai'];
  // An inline OpenAI object completely replaces the compatibility overlay.
  const native = recognized && isObject(inline) ? null : await jsonIfPresent(join(root, '.codex-plugin', 'plugin.json'));
  const claude = recognized || native ? null : await jsonIfPresent(join(root, '.claude-plugin', 'plugin.json'));
  const entryOnly = !recognized && !native && !claude && entry.strict === false && typeof entry.name === 'string';
  if (!recognized && !native && !claude && !entryOnly) throw Object.assign(new Error('No supported plugin.json, .codex-plugin/plugin.json or .claude-plugin/plugin.json was found.'), { code: 'ENOENT' });
  const format: PluginFormat = recognized ? 'agent-plugins' : native ? 'openai' : 'claude';
  const manifestPath = recognized ? join(root, 'plugin.json') : native ? join(root, '.codex-plugin', 'plugin.json')
    : claude ? join(root, '.claude-plugin', 'plugin.json') : join(root, '.cardbush-marketplace.json');
  const overlay = recognized ? object(isObject(inline) ? inline : native) : native ?? claude ?? { name: entry.name };
  const manifest: Json = recognized ? { ...portable, interface: overlay.interface, hooks: overlay.hooks, apps: overlay.apps }
    : { ...overlay };
  const issues: Array<{ code: string; detail: string }> = [];
  if (format === 'claude') {
    for (const key of componentKeys) {
      if (entry[key] !== undefined && manifest[key] === undefined) manifest[key] = entry[key];
      else if (entry[key] !== undefined && JSON.stringify(entry[key]) !== JSON.stringify(manifest[key])) issues.push({ code: 'conflicting', detail: key });
    }
    manifest.version ||= entry.version;
    manifest.description ||= entry.description;
    manifest.author ||= entry.author;
    manifest.interface = { ...object(manifest.interface), category: entry.category || 'Other' };
  }
  manifest.version ||= '0.0.0';
  if (recognized) {
    // Portable components have fixed locations. Overlays cannot add or replace them.
    manifest.skills = await exists(join(root, 'skills')) ? ['./skills'] : [];
    manifest.mcpServers = await exists(join(root, 'mcp.json')) ? ['./mcp.json'] : [];
    manifest.agents = [];
    manifest.commands = [];
  } else {
    if (manifest.skills === undefined && await exists(join(root, 'skills'))) manifest.skills = './skills';
    if (manifest.mcpServers === undefined && await exists(join(root, '.mcp.json'))) manifest.mcpServers = './.mcp.json';
    if (manifest.commands === undefined && await exists(join(root, 'commands'))) manifest.commands = './commands';
  }
  const skillPaths = paths(manifest.skills);
  if (format === 'claude' && await exists(join(root, 'skills')) && !skillPaths.includes('./skills')) skillPaths.unshift('./skills');
  if (format === 'claude' && !skillPaths.length && await exists(join(root, 'SKILL.md'))) skillPaths.push('./');
  const skillRoots: string[] = [];
  const { readPluginSkill } = await import('@cardbush/bush-runtime');
  const skills: Awaited<ReturnType<typeof readPluginSkill>>[] = [];
  const skillNames = new Set<string>();
  for (const path of skillPaths) {
    const directory = await pluginChild(root, path);
    if (!(await stat(directory)).isDirectory()) throw new Error(`Plugin Skill directory is missing: ${path}`);
    if (skillRoots.includes(directory)) continue;
    const packages = await exists(join(directory, 'SKILL.md')) ? [directory] :
      (await readdir(directory, { withFileTypes: true })).filter(item => item.isDirectory()).map(item => join(directory, item.name));
    for (const pkg of packages) {
      if (!await exists(join(pkg, 'SKILL.md'))) continue;
      const name = basename(pkg).toLowerCase();
      if (skillNames.has(name)) throw new Error('Multiple Skill roots contain the same Skill folder name.');
      skillNames.add(name);
      const skill = await readPluginSkill(join(pkg, 'SKILL.md'), String(manifest.name), root);
      skills.push(skill);
      issues.push(...skill.issues.map(detail => ({ code: 'extension', detail })));
    }
    skillRoots.push(directory);
  }
  const configured = manifest.mcpServers;
  const sources = configured === undefined ? [] : Array.isArray(configured) ? [...configured] : [configured];
  if (format === 'claude' && await exists(join(root, '.mcp.json')) && !sources.includes('./.mcp.json') && !sources.includes('.mcp.json')) sources.unshift('./.mcp.json');
  const servers: Json = {};
  for (const source of sources) {
    const config = typeof source === 'string' ? await readJson(await pluginChild(root, source)) : object(source);
    if (recognized && config.$schema !== mcpSchema) throw new Error('Portable mcp.json must declare the supported Agent Plugins MCP schema.');
    for (const [name, candidate] of Object.entries(object(config.mcpServers ?? config))) {
      if (name === '$schema') continue;
      if (name in servers) throw new Error('Multiple MCP configs use the same server name.');
      if (!isObject(candidate)) throw new Error(`Invalid MCP server: ${name}`);
      if (recognized && !['stdio', 'streamable-http'].includes(String(candidate.type))) throw new Error(`Unsupported portable MCP transport: ${candidate.type}`);
      servers[name] = { ...candidate, ...(candidate.type === 'streamable-http' ? { type: 'streamable_http' } : {}) };
    }
  }
  for (const skill of skills) {
    const dependencies: string[] = [];
    for (const dependency of skill.dependencies) {
      const name = String(dependency.value ?? '');
      if (dependency.type !== 'mcp' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) {
        issues.push({ code: 'extension', detail: `skills.${skill.command.name}: unsupported tool dependency` }); continue;
      }
      dependencies.push(`plugin_${String(manifest.name).replace(/\./g, '_')}_${name}`);
      if (servers[name]) {
        if (dependency.url && object(servers[name]).url !== dependency.url) issues.push({ code: 'conflicting', detail: `skills.${skill.command.name}: MCP dependency ${name}` });
        continue;
      }
      if (!['streamable_http', 'streamable-http', 'http', 'sse'].includes(String(dependency.transport)) || !/^https?:\/\//.test(String(dependency.url))) {
        issues.push({ code: 'extension', detail: `skills.${skill.command.name}: configure MCP dependency ${name}` }); continue;
      }
      servers[name] = { type: dependency.transport === 'streamable-http' ? 'streamable_http' : dependency.transport, url: dependency.url, required: false };
    }
    skill.command.dependencyServers = [...new Set(dependencies)];
  }
  manifest.mcpServers = servers;
  const registeredApps: Record<string, { id: string; required: boolean }> = {};
  if (manifest.apps) {
    const config = typeof manifest.apps === 'string' ? await readJson(await pluginChild(root, manifest.apps)) : object(manifest.apps);
    for (const [name, value] of Object.entries(object(config.apps ?? config))) {
      const app = object(value);
      if (typeof app.id !== 'string' || !app.id.trim() || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) throw new Error(`Invalid registered MCP app mapping: ${name}`);
      // An OpenAI registration and a bundled transport may describe the same service.
      // Preserve both declarations; the host selects one connection for this alias.
      registeredApps[name] = { id: app.id, required: app.required === true };
    }
  }
  const extensions = await readPluginExtensions(root, manifest, { format });
  for (const skill of skills) {
    if (skill.metadata.hooks && typeof skill.metadata.hooks === 'object' && !Array.isArray(skill.metadata.hooks)) {
      const local = await readPluginExtensions(root, { name: manifest.name, hooks: skill.metadata.hooks }, { format, hooksOnly: true, scope: { kind: 'skill', id: skill.command.id } });
      extensions.hooks.push(...local.hooks); extensions.issues.push(...local.issues); extensions.notes.push(...local.notes);
    }
    if (skill.metadata.model && skill.metadata.model !== 'inherit') extensions.notes.push(`Skill ${skill.command.name}: model inherits the current CardBush model configuration.`);
    if (skill.metadata.effort) extensions.notes.push(`Skill ${skill.command.name}: reasoning effort inherits the current session.`);
  }
  const invocationIds = [...skills.map(skill => skill.command.id), ...extensions.commands.map(command => command.id)];
  if (new Set(invocationIds).size !== invocationIds.length) issues.push({ code: 'conflicting', detail: 'Skills / Commands: duplicate invocation names' });
  for (const agent of extensions.agents) {
    if (!agent.skills?.length) continue;
    agent.skills = agent.skills.map(reference => {
      const skill = skills.find(skill => skill.command.name === reference.name || skill.command.id === reference.name);
      if (!skill) { issues.push({ code: 'extension', detail: `agents.${agent.name}: missing Skill ${reference.name}` }); return reference; }
      if (skill.command.disableModelInvocation) issues.push({ code: 'extension', detail: `agents.${agent.name}: Skill ${reference.name} forbids model invocation` });
      if (skill.command.context || /!`|^```!/m.test(skill.command.prompt)) issues.push({ code: 'extension', detail: `agents.${agent.name}: preloaded Skill ${reference.name} requires invocation` });
      return { name: skill.command.id, path: skill.command.path, prompt: skill.command.prompt, dependencyServers: skill.command.dependencyServers };
    });
  }
  issues.push(...extensions.issues);
  const unsupported = componentKeys.filter(key => !['skills', 'mcpServers', 'hooks', 'agents', 'commands', 'apps', 'lspServers'].includes(key) && manifest[key]);
  if (manifest.lspServers || await exists(join(root, '.lsp.json'))) extensions.notes.push('LSP 已跳过：CardBush 不运行语言服务；其余兼容组件仍可安装。 / LSP is skipped; other compatible components remain available.');
  if (format === 'claude') {
    for (const directory of ['monitors', 'themes', 'workflows', 'output-styles']) if (await exists(join(root, directory))) unsupported.push(directory);
  }
  if (unsupported.length) issues.push({ code: 'components', detail: unsupported.join(', ') });
  const authentication = object(entry.policy).authentication === 'ON_INSTALL' ? 'ON_INSTALL' as const : 'ON_USE' as const;
  return { root, manifestPath, manifest, format, skillRoots, registeredApps, authentication, extensions: { ...extensions, issues, skills: skills.map(skill => skill.command) }, issues, notes: extensions.notes };
}

export type ResolvedPluginManifest = Awaited<ReturnType<typeof resolvePluginManifest>>;
export function pluginRootForManifest(path: string) {
  const parent = dirname(path);
  return ['.codex-plugin', '.claude-plugin'].includes(basename(parent)) ? dirname(parent) : parent;
}
function paths(value: unknown): string[] {
  if (value === undefined) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) return value;
  throw new Error('Plugin Skill paths must be strings.');
}
function isObject(value: unknown): value is Json { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function object(value: unknown): Json { return isObject(value) ? value : {}; }
async function readJson(file: string): Promise<Json> {
  const value = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
  if (!isObject(value)) throw new Error(`Invalid plugin JSON object: ${file}`);
  return value;
}
async function jsonIfPresent(file: string) { try { return await readJson(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } }
async function exists(file: string) { return Boolean(await stat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; })); }
