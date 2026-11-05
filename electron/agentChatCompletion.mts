import { catalogSkills, resolveResourceMentions, resourceMention, resourceMentionTargets } from './composerResourceCatalog.js';
import { posix, win32 } from 'node:path';
import { uiText } from '@cardbush/platform/i18n';
import { CLI_UI_LANGUAGE } from './agentChatWebhooks.mjs';
import type { AgentHttpClient } from './agentHttpClient.mjs';
import type { WorkspaceDirectoryPage } from './workspaceFiles.js';
import { chatShellCommand } from './agentChatShell.mjs';

export type ChatChoice = { value: string; description?: string; label?: string };
export type ChatInputOptions = { chat?: boolean; choices?: ChatChoice[]; details?: string[]; transient?: boolean;
  picker?: { title: string; selected?: string; cancelValue: string; cancelLabel?: 'back' | 'cancel' | 'deny' | 'exit' } };
export type ChatSuggestion = ChatChoice & { cursor?: number };
export type ChatSuggestions = { start: number; end: number; items: ChatSuggestion[]; notice?: string; submitOnEnter?: boolean };
export type ChatSuggestionSource = (line: string, cursor: number, signal: AbortSignal) => Promise<ChatSuggestions | undefined>;
type Model = { id: string; modelName: string };
type Skill = { name: string; path: string; description?: string; invocationMode?: string };
type Command = { id: string; kind?: string; path?: string; name?: string; description?: string; argumentHint?: string };
type Catalog = { skills: Skill[]; pluginCommands: Command[]; plugins?: {id: string; name: string; manifestPath: string}[] };
type Context = { sessionId: string; workspace?: string; platform: string; models: Model[] };
export const chatExitCommands = ['/exit', '/quit'] as const;
export const isChatExitCommand = (text: string) => chatExitCommands.some(command => command === text.trim());
const commands: ChatChoice[] = [
  { value: '/model ', label: '/model', description: 'Select model and reasoning effort' },
  { value: '/settings', description: 'View and reload shared App settings' },
  { value: '/browser ', label: '/browser', description: 'Browser status, setup and bounded connection recovery' },
  { value: '/habit ', label: '/habit', description: 'Show or set user habit memory: on / off / status' },
  { value: '/prediction ', label: '/prediction', description: 'Show or set next-step predictions: on / off / status' },
  { value: '/session ', label: '/session', description: 'Choose or switch a saved session' },
  { value: '/plan', description: 'Show the current task plan' },
  { value: '/tools ', label: '/tools', description: 'Inspect tools and results; --turn N for an earlier turn' },
  { value: '/artifact ', label: '/artifact', description: 'Browse and open files from this turn' },
  { value: '/source ', label: '/source', description: 'Inspect source explanations and evidence' },
  { value: '/logs', description: 'Show the diagnostic log path' },
  { value: '/help', description: 'Show command help' },
  { value: '/new', description: 'Start a new session' },
  { value: '/steer ', label: '/steer', description: 'Guide the running task immediately (Ctrl+Enter)' },
  { value: '/shell ', label: '/shell', description: 'Open a local shell, or run /shell COMMAND / !COMMAND' },
  { value: '/skill ', label: '/skill', description: uiText(CLI_UI_LANGUAGE)('composer.viewAndChooseSkillsEnabledForThis') },
  { value: '/plugin ', label: '/plugin', description: uiText(CLI_UI_LANGUAGE)('composer.choosePluginReference') },
  ...chatExitCommands.map(value => ({ value, description: 'Exit and show the resume command' })),
];
const safe = (value: string) => !/[\x00-\x1f\x7f-\x9f]/.test(value);
const commandId = (value: string) => /^[A-Za-z0-9_.-]+(?::[A-Za-z0-9_-]+)?$/.test(value);
const matches = (item: ChatChoice, query: string) => `${item.value} ${item.label ?? ''}`.toLowerCase().includes(query.toLowerCase());
const matchesInOrder = (value: string, query: string) => {
  let next = 0;
  for (const character of query) {
    const index = value.indexOf(character, next);
    if (index < 0) return false;
    next = index + character.length;
  }
  return true;
};

/** A replacement range, rather than an appended suffix, also works when editing
 * the middle of a draft. Completion never submits or performs the command. */
export function applyChatSuggestion(line: string, suggestions: ChatSuggestions, index = 0) {
  const item = suggestions.items[index];
  if (!item || !safe(item.value)) return undefined;
  const suffix = line.slice(suggestions.end);
  const value = item.value.endsWith(' ') && /^\s/.test(suffix) ? item.value.slice(0, -1) : item.value;
  return { line: line.slice(0, suggestions.start) + value + suffix,
    cursor: suggestions.start + Math.min(item.cursor ?? value.length, value.length) };
}

export function choiceSuggestions(line: string, cursor: number, choices: ChatChoice[]): ChatSuggestions | undefined {
  if (!choices.length) return;
  const start = line.length - line.trimStart().length;
  const query = line.slice(start, cursor);
  // A displayed numeric choice must win over a digit occurring in a model UUID.
  const exact = choices.filter(choice => choice.value === query || /^\d+$/.test(query) && choice.label?.startsWith(query + '.'));
  return { start, end: line.length, submitOnEnter: true, items: exact.length ? exact : choices.filter(choice => matches(choice, query)) };
}

export function commandSuggestions(line: string, cursor: number, models: Model[], extra: ChatChoice[] = []): ChatSuggestions | undefined {
  const before = line.slice(0, cursor);
  const browser = /^(\s*\/browser\s+)(.*)$/.exec(before);
  if (browser) return { start: browser[1].length, end: line.length, submitOnEnter: true,
    items: [{ value: 'status', description: 'List this Runtime’s browser connections' },
      { value: 'retry', description: 'Retry the host connector after automatic recovery has stopped' },
      { value: 'pair chrome', description: 'Chrome code for manual connection or remote Agent pairing' },
      { value: 'pair edge', description: 'Edge code for manual connection or remote Agent pairing' },
      { value: 'default ', description: 'Set the default paired connection ID' },
      { value: 'revoke ', description: 'Remove one paired connection ID' }].filter(item => item.value.startsWith(browser[2])) };
  const memory = /^(\s*\/(?:habit|prediction)\s+)([^\s]*)$/.exec(before);
  if (memory) return { start: memory[1].length, end: cursor + (/^\S*/.exec(line.slice(cursor))?.[0].length ?? 0), submitOnEnter: true,
    items: [{ value: 'status', description: 'Show the current session setting' }, { value: 'on', description: 'Enable for this session' },
      { value: 'off', description: 'Disable for this session' }].filter(item => item.value.startsWith(memory[2])) };
  const model = /^(\s*\/model\s+)([^\s]*)$/.exec(before);
  if (model) return { start: model[1].length, end: cursor + (/^\S*/.exec(line.slice(cursor))?.[0].length ?? 0), submitOnEnter: true,
    items: models.map(item => ({ value: item.id, label: item.modelName, description: item.id })).filter(item => matches(item, model[2])) };
  const slash = /^(\s*)\/([^\s/]*)$/.exec(before);
  if (!slash) return;
  const unique = new Map(commands.map(item => [item.value.trim(), item]));
  unique.set('/webhook', { value: '/webhook', description: uiText(CLI_UI_LANGUAGE)('cliWebhook.description') });
  for (const item of extra) if (!unique.has(item.value.trim())) unique.set(item.value.trim(), item);
  const prefix = `/${slash[2]}`.toLowerCase();
  // Exact names and consecutive prefixes win. Only fall back to ordered fuzzy
  // matching when no prefix exists; descriptions never affect command matching.
  const candidates = [...unique.values()];
  const prefixes = candidates.filter(item => item.value.toLowerCase().startsWith(prefix));
  const items = prefixes.length ? prefixes : candidates.filter(item => matchesInOrder(item.value.trim().toLowerCase(), prefix));
  items.sort((a, b) => Number(b.value.trim().toLowerCase() === prefix) - Number(a.value.trim().toLowerCase() === prefix));
  return { start: slash[1].length, end: cursor + (/^\S*/.exec(line.slice(cursor))?.[0].length ?? 0),
    items, submitOnEnter: true };
}

type PathToken = { start: number; end: number; path: string; mention: boolean; quote: string };
function pathToken(line: string, cursor: number): PathToken | undefined {
  const before = line.slice(0, cursor);
  const match = /(?:^|\s)(@?)(?:"([^"\n]*)|'([^'\n]*)|([^\s"'`]*))$/.exec(before);
  if (!match) return;
  const mention = match[1] === '@', quote = match[2] !== undefined ? '"' : match[3] !== undefined ? "'" : '';
  const path = match[2] ?? match[3] ?? match[4];
  if (!mention && (!path || !/^(?:\.{1,2}[\\/]|[A-Za-z]:[\\/]|\/)|[\\/]/.test(path))) return;
  if (/^\w+:\/\//.test(path)) return;
  const length = Number(mention) + Number(Boolean(quote)) + path.length;
  const after = line.slice(cursor);
  const tail = quote ? after.indexOf(quote) : -1;
  return { start: cursor - length, end: quote && tail >= 0 ? cursor + tail + 1 : cursor + (/^[^\s"'`]*/.exec(after)?.[0].length ?? 0), path, mention, quote };
}

/** Uses the same read-only catalog and protected directory API as the App.
 * Neither hints nor Tab invoke a Skill, read file contents or grant permissions. */
export class AgentChatCompletion {
  #context: Context;
  #lifetime = new AbortController();
  #cache = new Map<string, { until: number; value: Promise<unknown> }>();
  constructor(readonly client: Pick<AgentHttpClient, 'call'>, context: Context) { this.#context = context; }
  update(context: Context) {
    this.#lifetime.abort(); this.#lifetime = new AbortController(); this.#cache.clear(); this.#context = context;
  }
  close() { this.#lifetime.abort(); this.#cache.clear(); }
  #cached<T>(key: string, load: (signal: AbortSignal) => Promise<T>, ttl = 3000): Promise<T> {
    const previous = this.#cache.get(key);
    if (previous && previous.until > Date.now()) return previous.value as Promise<T>;
    if (this.#cache.size >= 32) this.#cache.delete(this.#cache.keys().next().value!);
    const record = { until: Date.now() + ttl, value: load(AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(2000)])) };
    this.#cache.set(key, record);
    void record.value.catch(() => { if (this.#cache.get(key) === record) this.#cache.delete(key); });
    return record.value;
  }
  #catalog() { return this.#cached('catalog', signal => this.client.call('conversation.catalog', { includePlugins: true }, signal) as Promise<Catalog>, 30_000); }
  #paths() { return this.#context.platform === 'win32' ? win32 : posix; }
  #inside(path: string) {
    const root = this.#context.workspace;
    if (!root) return false;
    const paths = this.#paths(), relative = paths.relative(root, path);
    return !paths.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + paths.sep);
  }
  async #directory(directoryPath: string) {
    const sessionId = this.#context.sessionId;
    return this.#cached('directory:' + directoryPath, async signal => {
      const entries: WorkspaceDirectoryPage['entries'] = []; let offset: number | undefined;
      do {
        const page = await this.client.call('files.list', { sessionId, directoryPath, offset }, signal) as WorkspaceDirectoryPage;
        entries.push(...page.entries); const previous = offset; offset = page.nextOffset;
        if (offset !== undefined && offset <= (previous ?? -1)) break;
      } while (offset !== undefined && entries.length < 2000);
      return { entries, truncated: offset !== undefined };
    });
  }
  #resources(catalog: Catalog) {
    const items = catalogSkills(catalog.skills, catalog.pluginCommands)
      .filter(({ id, path, skill }) => commandId(id) && safe(path ?? '') && !['model', 'disabled'].includes(skill?.invocationMode ?? ''))
      .map(({ id, path, skill, command }) => ({ id, kind: 'skill', value: resourceMention(id, path), label: '@' + id, description: skill?.description || command?.description }));
    for (const plugin of catalog.plugins ?? []) {
      if (commandId(plugin.id) && safe(plugin.manifestPath)) items.push({id: plugin.id, kind: 'plugin', value: resourceMention(plugin.id, plugin.manifestPath), label: '@' + plugin.id, description: plugin.name});
    }
    return items;
  }
  async resourceSuggestions(query: string, kind: 'skill' | 'plugin' | undefined, signal: AbortSignal): Promise<ChatChoice[]> {
    const items = this.#resources(await this.#catalog());
    signal.throwIfAborted();
    const targets = resourceMentionTargets(items);
    const search = query.trim().toLowerCase();
    return items.filter(item => (!kind || item.kind === kind) &&
      (item.id.toLowerCase().includes(search) || item.description?.toLowerCase().includes(search)))
      .sort((a, b) => Number(b.id.toLowerCase().startsWith(search)) - Number(a.id.toLowerCase().startsWith(search)))
      .map(item => ({ ...item, value: (targets.get(item.id) === item.value ? item.label : item.value) + ' ' }));
  }
  #extra(catalog: Catalog): ChatChoice[] {
    return catalog.pluginCommands.filter(item => item.kind !== 'skill' && commandId(item.id))
      .map(item => ({ value: `/${item.id} `, label: `/${item.id}`, description: [item.description, item.argumentHint].filter(Boolean).join(' · ') }));
  }
  suggest: ChatSuggestionSource = async (line, cursor, signal) => {
    signal.throwIfAborted();
    const before = line.slice(0, cursor);
    const list = /^(\s*)\/(skill|plugin)[ \t]+([^\s]*)$/.exec(before);
    if (list) return { start: list[1].length, end: cursor + (/^\S*/.exec(line.slice(cursor))?.[0].length ?? 0),
      items: await this.resourceSuggestions(list[3], list[2] === 'skill' ? 'skill' : 'plugin', signal) };
    const command = commandSuggestions(line, cursor, this.#context.models);
    if (command) {
      if (/^\s*\/(?:model|habit|prediction)\s+/.test(line.slice(0, cursor))) return command;
      try { const catalog = await this.#catalog(); signal.throwIfAborted(); return commandSuggestions(line, cursor, this.#context.models, this.#extra(catalog)); }
      catch { signal.throwIfAborted(); return { ...command, notice: 'Skill catalog unavailable; built-in commands still work' }; }
    }
    // Shell input belongs to this computer, even when the Agent is remote.
    // Native shell completion must never substitute Agent workspace paths.
    if (chatShellCommand(line) !== undefined) return;
    const token = pathToken(line, cursor);
    if (!token) return;
    const references = token.mention && !token.quote && /^[\p{L}\p{N}_.:-]*$/u.test(token.path)
      ? await this.resourceSuggestions(token.path, undefined, signal).catch(() => { signal.throwIfAborted(); return []; }) : [];
    const empty = { start: token.start, end: token.end, items: references };
    if (!this.#context.workspace) return references.length ? empty : { ...empty, notice: 'This session has no browsable workspace' };
    const paths = this.#paths(), input = token.path.replaceAll('\\', paths.sep);
    const separator = Math.max(input.lastIndexOf('/'), input.lastIndexOf(paths.sep));
    const parent = separator >= 0 ? input.slice(0, separator + 1) : '';
    const name = input.slice(separator + 1);
    const directory = paths.resolve(this.#context.workspace, parent || '.');
    if (!this.#inside(directory)) return { ...empty, notice: 'Completion is limited to this session workspace' };
    try {
      const page = await this.#directory(directory); signal.throwIfAborted();
      const insensitive = this.#context.platform === 'win32';
      const prefix = (value: string) => insensitive ? value.toLowerCase() : value;
      const items = page.entries.filter(entry => safe(entry.name) && !/["']/.test(entry.name) && prefix(entry.name).startsWith(prefix(name))).map(entry => {
        const path = parent.replaceAll('\\', '/') + entry.name + (entry.kind === 'folder' ? '/' : '');
        const resourceHasName = references.some(item => item.label === '@' + path || item.label?.endsWith(':' + path));
        const quote = token.quote || (/\s/.test(path) || resourceHasName ? '"' : '');
        const value = (token.mention ? '@' : '') + quote + path + quote + (entry.kind === 'file' ? ' ' : '');
        return { value, label: entry.name + (entry.kind === 'folder' ? '/' : ''), description: entry.kind === 'folder' ? 'Folder' : 'File',
          cursor: value.length - (entry.kind === 'folder' && quote ? 1 : 0) };
      });
      return { ...empty, items: [...references, ...items], ...(page.truncated ? { notice: 'Showing the first 2,000 entries; enter a subfolder to narrow the search' } : {}) };
    } catch { signal.throwIfAborted(); return { ...empty, notice: 'Cannot read this folder; keep typing or try again later' }; }
  };
  async prepare(text: string, signal: AbortSignal) {
    let content = text;
    if (/(?:^|\s)@[\w.-]/.test(text)) {
      const catalog = await this.#catalog().catch(() => undefined);
      signal.throwIfAborted();
      if (catalog) content = resolveResourceMentions(text, this.#resources(catalog));
    }
    const files = new Set<string>();
    let fence = ''; const paths = this.#paths();
    if (this.#context.workspace) for (const line of content.split(/\r?\n/)) {
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (marker && (!fence || marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim())) { fence = fence ? '' : marker[1]; continue; }
      if (fence) continue;
      // Consume code spans first. Emails and ordinary paths are not attachments.
      for (const match of line.matchAll(/(`+).*?\1|(?:^|\s)@(?:"([^"\n]+)"|'([^'\n]+)'|([^\s`"'，。；：！？、（）【】]+))/g)) {
        if (match[1]) continue;
        const source = match[2] ?? match[3] ?? match[4];
        const path = paths.resolve(this.#context.workspace, source.replaceAll('\\', paths.sep));
        if (!this.#inside(path)) continue;
        const page = await this.#directory(paths.dirname(path)).catch(() => undefined); signal.throwIfAborted();
        const entry = page?.entries.find(entry => paths.relative(entry.path, path) === '');
        if (entry?.kind === 'file') files.add(entry.path);
      }
    }
    return { text: content, ...(files.size ? { files: [...files] } : {}),
      ...(content !== text ? { userMessageMetadata: { composerReferenceContent: text } } : {}) };
  }
}
