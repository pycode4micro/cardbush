import { execFile } from 'node:child_process';
import { mkdtemp, open, rm, rmdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, posix, win32 } from 'node:path';
import { promisify } from 'node:util';
import {
  GET_RUNTIME_TOOL_EXECUTION_COMMAND, LIST_RUNTIME_TURN_TOOL_EXECUTIONS_COMMAND,
  RESOLVE_FILE_MEMO_COMMAND, RESOLVE_SOURCE_MEMO_COMMAND, RESOLVE_SOURCE_REFERENCES_COMMAND,
  fileMemoResolutionSchema, parseFileMemoReference, parseSourceMemoReference,
  sourceMemoResolutionSchema, sourceReferencesSchema, type ToolExecutionRecord, type ToolExecutionSummary,
} from '@cardbush/bush-protocol';
import type { AgentHttpClient } from './agentHttpClient.mjs';
import type { ChatChoice, ChatSuggestions } from './agentChatCompletion.mjs';
import { chatLinkTarget, type ChatReferenceRenderer, type ChatLinkTarget } from './agentChatLinks.mjs';
import { ChatMarkdown, terminalText } from './agentChatPresentation.mjs';

type Scope = { sessionId: string; turnId?: string; workspace?: string; platform: string; local: boolean; hyperlinks: boolean };
type Artifact = { id: number; label: string; target: string; kind: 'file' | 'url' | 'memo'; line?: number; column?: number };
type ReferenceIO = { status(text: string): void; restoreDraft(text: string): void };
type OpenArtifact = (path: string, kind: 'file' | 'url') => Promise<void>;
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const clean = (value: unknown) => typeof value === 'string' ? terminalText(value).replace(/[\n\t]/g, ' ').trim() : '';

/** A view of the active/latest turn, never a second execution engine. Artifact
 * discovery, file transfer and source resolution use the same host APIs as GUI. */
export class AgentChatReferences implements ChatReferenceRenderer {
  #scope?: Scope;
  #artifacts: Artifact[] = [];
  #sources = new Map<number, string | undefined>();
  #loadedTools = new Set<string>();
  constructor(readonly client: Pick<AgentHttpClient, 'call'>, readonly io: ReferenceIO,
    readonly opener: OpenArtifact = openChatArtifact) {}
  setScope(scope: Scope) {
    if (this.#scope?.sessionId !== scope.sessionId || this.#scope?.turnId !== scope.turnId) {
      this.#artifacts = []; this.#sources.clear(); this.#loadedTools.clear();
    }
    this.#scope = scope;
  }
  source = (number: number) => { if (this.#sources.size < 32 && !this.#sources.has(number)) this.#sources.set(number, undefined); };
  #add(label: string, target: string, kind: Artifact['kind'], location?: Pick<ChatLinkTarget, 'line' | 'column'>) {
    const key = (value: string) => this.#scope?.platform === 'win32' && kind === 'file' ? value.replaceAll('\\', '/').toLowerCase() : value;
    const found = this.#artifacts.find(item => item.kind === kind && key(item.target) === key(target));
    if (found) return found;
    if (this.#artifacts.length >= 256) return;
    const item = { id: this.#artifacts.length + 1, label: clean(label) || clean(target), target, kind,
      ...(location?.line ? { line: location.line } : {}), ...(location?.column ? { column: location.column } : {}) };
    this.#artifacts.push(item); return item;
  }
  link = (label: string, target: string) => {
    const scope = this.#scope;
    if (!scope) return;
    const number = parseSourceMemoReference(target);
    if (number !== undefined) { this.source(number); if (this.#sources.has(number)) this.#sources.set(number, target); return { text: `[${number}]` }; }
    if (parseFileMemoReference(target)) {
      const item = this.#add(label, target, 'memo');
      return { text: `${label}${item ? ` [file ${item.id}]` : ''}` };
    }
    const parsed = chatLinkTarget(target, scope.workspace, scope.platform);
    if (!parsed) return /^cardbush-|^(?:javascript|data|command|vscode):/i.test(target) ? { text: `${label} (reference unavailable)` } : undefined;
    if (parsed.kind === 'url') return scope.hyperlinks ? { text: label, href: parsed.href } : undefined;
    const item = this.#add(label, parsed.target, 'file', parsed);
    return { text: `${label}${parsed.line && !label.includes(':' + parsed.line) ? `:${parsed.line}` : ''}${scope.local && scope.hyperlinks ? '' : item ? ` [file ${item.id}]` : ''}`,
      ...(scope.local && scope.hyperlinks ? { href: parsed.href } : {}) };
  };
  choices(kind: 'artifact' | 'source'): ChatChoice[] {
    return kind === 'artifact' ? this.#artifacts.map(item => ({ value: String(item.id), label: `${item.id}. ${item.label}`, description: item.kind === 'memo' ? 'File reference' : clean(item.target) }))
      : [...this.#sources.keys()].sort((a, b) => a - b).map(number => ({ value: String(number), label: `${number}. Source ${number}`, description: 'Explanation and supporting evidence' }));
  }
  suggest(line: string, cursor: number): ChatSuggestions | undefined {
    const match = /^(\s*\/(artifact|source)\s+)([^\n]*)$/.exec(line.slice(0, cursor));
    if (!match) return;
    const query = match[3].trim().toLowerCase(), all = this.choices(match[2] as 'artifact' | 'source');
    // Keep the complete numbered list after Tab fills a selection, so another
    // Tab can cycle it without inventing a second input/approval controller.
    const exact = all.some(item => item.value === query);
    return { start: match[1].length, end: line.length, submitOnEnter: true, items: exact ? all : all.filter(item => `${item.value} ${item.label} ${item.description}`.toLowerCase().includes(query)),
      notice: all.length ? 'Tab choose · ↑/↓ select · Enter open · Esc cancel' : 'No items loaded; press Enter to refresh this turn' };
  }
  async #command(kind: string, payload: Record<string, unknown>, signal: AbortSignal) {
    return this.client.call('runtime.command', { kind, payload }, signal);
  }
  #scan(text: string) {
    const markdown = new ChatMarkdown(() => {}, false, () => 80, this);
    markdown.write(text); markdown.end();
  }
  #collect(result: unknown) {
    const native = record(result), value = record(record(native.mcp).name && native.result ? native.result : native);
    const structured = record(value.structuredContent);
    const memo = fileMemoResolutionSchema.safeParse({ memo: value, status: 'available' });
    if (memo.success && memo.data.status !== 'unresolved') this.link(memo.data.memo.file.name, memo.data.memo.reference);
    const declared = [...list(value.artifacts), ...list(structured.artifacts)];
    for (const block of list(value.content).map(record)) {
      const audience = record(block.annotations).audience;
      if (Array.isArray(audience) && !audience.includes('user')) continue;
      if (block.type === 'resource_link') declared.push(block);
      if (block.type === 'resource') declared.push(block.resource);
    }
    for (const item of declared) {
      const data = record(item), target = typeof item === 'string' ? item : data.path ?? data.url ?? data.uri ?? data.image_url ?? data.imageUrl;
      if (typeof target !== 'string') continue;
      const parsed = chatLinkTarget(target, this.#scope?.workspace, this.#scope?.platform);
      if (parsed) this.#add(clean(data.name ?? data.filename) || (this.#scope?.platform === 'win32' ? win32 : posix).basename(parsed.target), parsed.target, parsed.kind, parsed);
    }
  }
  async refresh(signal: AbortSignal, files = true) {
    const scope = this.#scope;
    if (!scope?.turnId) return;
    const identity = { sessionId: scope.sessionId, turnId: scope.turnId };
    {
      const events = await this.#command('runtime.list_turn_events', identity, signal);
      if (this.#scope !== scope) return;
      for (const event of list(events).map(record)) {
        if (event.sessionId !== scope.sessionId || event.turnId !== scope.turnId) continue;
        if (event.kind === 'assistant_segment_completed') { const content = record(event.payload).content; if (typeof content === 'string') this.#scan(content); }
      }
      // Live replies also pass through the same renderer. Refresh on command to
      // pick up completed/revised segments and restored turns without reprinting.
    }
    if (!files) return;
    const summaries = await this.#command(LIST_RUNTIME_TURN_TOOL_EXECUTIONS_COMMAND, { ...identity, detail: 'summary' }, signal) as ToolExecutionSummary[];
    if (this.#scope !== scope) return;
    for (const summary of summaries) {
      if (summary.sessionId !== scope.sessionId || summary.turnId !== scope.turnId) continue;
      for (const change of summary.workspaceChanges ?? []) if (change.status !== 'deleted') this.link((scope.platform === 'win32' ? win32 : posix).basename(change.path), change.path);
      const id = summary.toolCall.id;
      if (!summary.resultAvailable || summary.outcome !== 'returned' || summary.resultError || this.#loadedTools.has(id)) continue;
      const execution = await this.#command(GET_RUNTIME_TOOL_EXECUTION_COMMAND, { ...identity, toolCallId: id }, signal) as ToolExecutionRecord | null;
      if (this.#scope !== scope) return;
      if (execution?.sessionId === scope.sessionId && execution.turnId === scope.turnId && execution.toolCall.id === id && !execution.resultError) {
        this.#collect(execution.result); this.#loadedTools.add(id);
      }
    }
  }
  async handle(kind: 'artifact' | 'source', argument: string, signal: AbortSignal) {
    const scope = this.#scope;
    if (!scope?.turnId) { this.io.status('No turn to inspect yet.\n'); return; }
    const request = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    if (!argument.trim()) {
      await this.refresh(request, kind === 'artifact');
      const choices = this.choices(kind);
      if (!choices.length) { this.io.status(kind === 'artifact' ? 'No files in this turn yet.\n' : 'No source references in this turn yet.\n'); return; }
      this.io.status(`\n${kind === 'artifact' ? 'Files from this turn' : 'Sources from this turn'}\n` + choices.map(item => `  ${item.label}${kind === 'artifact' ? `  ${item.description}` : ''}`).join('\n') + '\nTab chooses; Enter opens. Esc cancels.\n');
      this.io.restoreDraft(`/${kind} `); return;
    }
    if (!/^[1-9]\d{0,8}$/.test(argument.trim())) { this.io.status(`Use /${kind} to list this turn's items, then select a number.\n`); return; }
    const number = Number(argument.trim());
    if (kind === 'source') { await this.#showSource(number, request); return; }
    let item = this.#artifacts.find(item => item.id === number);
    if (!item) { await this.refresh(request); item = this.#artifacts.find(item => item.id === number); }
    if (!item) { this.io.status('File selection not found. Use /artifact to refresh.\n'); return; }
    let target = item.target;
    if (item.kind === 'memo') {
      const identity = parseFileMemoReference(item.target);
      const result = fileMemoResolutionSchema.parse(await this.#command(RESOLVE_FILE_MEMO_COMMAND, {
        sessionId: scope.sessionId, turnId: scope.turnId, reference: item.target,
        ...(identity && !('number' in identity) ? { fileName: item.label } : {}),
      }, request));
      if (result.status === 'unresolved' || result.status === 'unavailable') throw new Error('File reference is unavailable. Ask the Agent to refresh it.');
      target = result.memo.file.path;
      if (result.status === 'changed') this.io.status('File changed since the reference was recorded; opening its current version.\n');
    }
    const parsed = chatLinkTarget(target, scope.workspace, scope.platform);
    if (!parsed) throw new Error('This reference is not a file or web URL.');
    const path = parsed.kind === 'file' && !scope.local ? await downloadChatArtifact(this.client, scope.sessionId, parsed.target, request) : parsed.target;
    try { await this.opener(path, parsed.kind); }
    catch (error) { throw new Error(`Cannot open ${clean(path)}: ${error instanceof Error ? error.message : 'No file viewer is available'}`); }
    this.io.status(`${parsed.kind === 'file' && !scope.local ? 'Opened downloaded copy' : 'Opened'}: ${clean(item.label)}${item.line ? ` (reference: line ${item.line}${item.column ? `, column ${item.column}` : ''})` : ''}\n${clean(path)}\n`);
  }
  async #showSource(number: number, signal: AbortSignal) {
    const scope = this.#scope!;
    if (!this.#sources.has(number)) await this.refresh(signal, false);
    let reference = this.#sources.get(number);
    if (!reference) {
      const values = sourceReferencesSchema.parse(await this.#command(RESOLVE_SOURCE_REFERENCES_COMMAND, { sessionId: scope.sessionId, turnId: scope.turnId, numbers: [number] }, signal));
      reference = values.find(value => value.number === number)?.reference;
    }
    if (!reference) { this.io.status(`Source ${number} is unavailable in this turn.\n`); return; }
    const result = sourceMemoResolutionSchema.parse(await this.#command(RESOLVE_SOURCE_MEMO_COMMAND, { reference }, signal));
    if (result.status !== 'resolved' || result.memo.reference !== reference) { this.io.status(`Source ${number} is unavailable.\n`); return; }
    this.#sources.set(number, reference);
    this.io.status(`\nSource ${number} · Why this conclusion\n${result.memo.explanation}\n`);
    result.memo.sources.forEach((source, index) => {
      const parsed = chatLinkTarget(source.target, scope.workspace, scope.platform);
      const file = parsed?.kind === 'file' ? this.#add(source.label ?? (scope.platform === 'win32' ? win32 : posix).basename(parsed.target), parsed.target, 'file', source.locator) : undefined;
      const location = [source.locator?.line ? `line ${source.locator.line}${source.locator.endLine ? `–${source.locator.endLine}` : ''}` : '', source.locator?.page ? `page ${source.locator.page}` : '', source.locator?.object].filter(Boolean).join(' · ');
      this.io.status(`\n  ${source.label ?? source.target}${location ? ` · ${location}` : ''} · ${result.evidenceStatus[index] ?? 'unavailable'}${file ? ` · /artifact ${file.id}` : ''}\n  ${source.target}\n`);
      if (source.excerpt) this.io.status(source.excerpt.split('\n').map(line => `  │ ${line}`).join('\n') + '\n');
    });
    if (!result.memo.sources.length) this.io.status('Agent judgment · No supporting materials attached.\n');
  }
}

/** Only an explicit Enter on /artifact opens anything. No model text or Tab
 * completion executes a command, and arguments never pass through a shell. */
export async function openChatArtifact(target: string, kind: 'file' | 'url') {
  if (kind === 'url' && chatLinkTarget(target)?.kind !== 'url') throw new Error('Invalid web URL.');
  if (kind === 'file' && !(await stat(target)).isFile()) throw new Error('This artifact is not a file.');
  const text = kind === 'file' && /\.(?:md|txt|json|ya?ml|toml|ini|log|ts|tsx|js|jsx|mjs|cjs|py|ps1|sh|bat|cmd|css|sql|xml|rs|go|java|c|cpp|h)$/i.test(target);
  const executable = kind === 'file' && /\.(?:exe|com|msi|msix|appx|lnk|url|vbs|vbe|wsf|scr|pif|jar|app|desktop|appimage)$/i.test(target);
  if (process.platform === 'win32') {
    // Pass the path as data in the environment, not interpolated PowerShell.
    const script = "$ErrorActionPreference = 'Stop'; $p = $env:CARDBUSH_ARTIFACT_TARGET; if ($env:CARDBUSH_ARTIFACT_TEXT -eq '1') { Start-Process notepad.exe -ArgumentList ('\"' + $p + '\"') } elseif ($env:CARDBUSH_ARTIFACT_REVEAL -eq '1') { Start-Process explorer.exe -ArgumentList ('/select,\"' + $p + '\"') } else { Start-Process -FilePath $p }";
    await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 10_000, env: { ...process.env, CARDBUSH_ARTIFACT_TARGET: target, CARDBUSH_ARTIFACT_TEXT: text ? '1' : '0', CARDBUSH_ARTIFACT_REVEAL: executable ? '1' : '0' } });
  } else {
    const path = executable ? posix.dirname(target) : target;
    await promisify(execFile)(process.platform === 'darwin' ? 'open' : 'xdg-open', process.platform === 'darwin' ? [...(text ? ['-t'] : []), '--', path] : [path], { timeout: 10_000 });
  }
}

export async function downloadChatArtifact(client: Pick<AgentHttpClient, 'call'>, sessionId: string, path: string, signal: AbortSignal) {
  const directory = await mkdtemp(join(tmpdir(), 'cardbush-artifact-'));
  let output: Awaited<ReturnType<typeof open>> | undefined, destination = '', offset = 0, size: number | undefined;
  try {
    while (true) {
      const data = record(await client.call('files.read', { sessionId, path, offset }, signal));
      if (typeof data.name !== 'string' || !data.name.trim() || /[\\/\x00-\x1f<>:"|?*]/.test(data.name) || ['.', '..'].includes(data.name) ||
        !Number.isSafeInteger(data.size) || Number(data.size) < 0 || Number(data.size) > 64 * 1024 * 1024 ||
        data.offset !== offset || typeof data.content !== 'string' || data.content.length > 710000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data.content) || typeof data.done !== 'boolean') throw new Error('Invalid file transfer response.');
      if (size !== undefined && data.size !== size) throw new Error('File changed during transfer.');
      if (destination && basename(destination) !== data.name) throw new Error('File name changed during transfer.');
      size = Number(data.size);
      const bytes = Buffer.from(data.content, 'base64');
      if (bytes.length > 512 * 1024 || !data.done && !bytes.length || offset + bytes.length > size) throw new Error('Invalid file transfer chunk.');
      if (!output) { destination = join(directory, basename(data.name)); output = await open(destination, 'wx', 0o600); }
      await output.writeFile(bytes); offset += bytes.length;
      if (data.done) { if (offset !== size) throw new Error('Incomplete file transfer.'); break; }
    }
    await output.close(); return destination;
  } catch (error) { await output?.close(); if (destination) await rm(destination, { force: true }); await rmdir(directory); throw error; }
}
