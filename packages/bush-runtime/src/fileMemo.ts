import { realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { FILE_MEMO_PROTOCOL, fileMemoInputSchema, fileMemoMarkdown, fileMemoReference, fileMemoSchema, parseFileMemoReference,
  type FileMemo, type FileMemoResolution, type ToolExecutionRecord } from '@cardbush/bush-protocol';
import type { ToolRegistry } from './toolRegistry.js';
import type { ToolExecutionStore } from './toolExecutionStore.js';

export const FILE_MEMO_WRITE_TOOL = 'remember_file';
export interface FileMemoScope { sessionId?: string; turnId?: string; fileName?: string }
const identityPath = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
type MemoEntry = { record: ToolExecutionRecord; memo: FileMemo; fileNumber: number };

// File IDs remain local to each conversation. Link numbers use the host's durable
// locator index so copied links and inherited child context keep the same target.
function memoEntries(store: ToolExecutionStore, sessionId: string): MemoEntry[] {
  const files = new Map<string, number>();
  const entries: MemoEntry[] = [];
  for (const record of store.listByTool(sessionId, FILE_MEMO_WRITE_TOOL)) {
    if (record.outcome !== 'returned') continue;
    const parsed = fileMemoSchema.safeParse(record.result);
    if (!parsed.success) continue;
    const memo = parsed.data;
    const path = identityPath(memo.file.path);
    if (!files.has(path)) files.set(path, files.size + 1);
    entries.push({ record, memo, fileNumber: files.get(path)! });
  }
  return entries;
}

function publicMemo(store: ToolExecutionStore, entry: MemoEntry): FileMemo {
  const number = store.reserveFileMemoReference({ sessionId: entry.record.sessionId, turnId: entry.record.turnId, toolCallId: entry.record.toolCall.id });
  const reference = fileMemoReference({ number });
  return { ...entry.memo, id: `file_${entry.fileNumber}`, reference, markdown: fileMemoMarkdown(entry.memo.file.name, reference) };
}

/** Only recover a small transcription error in a legacy call ID, never a nearby short number. */
function nearCallId(left: string, right: string): boolean {
  if (Math.abs(left.length - right.length) > 2 || Math.min(left.length, right.length) < 12 || Math.max(left.length, right.length) > 256) return false;
  let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 1; i <= left.length; i++) {
    const next = [i];
    for (let j = 1; j <= right.length; j++) next[j] = Math.min(next[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1));
    if (Math.min(...next) > 2) return false;
    previous = next;
  }
  return previous[right.length]! <= 2;
}

export async function resolveFileMemo(store: ToolExecutionStore, reference: string, scope: FileMemoScope = {}): Promise<FileMemoResolution> {
  const identity = parseFileMemoReference(reference);
  if (!identity) return { status: 'unresolved', reason: 'invalid_reference' };
  const locator = 'number' in identity ? store.getFileMemoReference(identity.number) : identity;
  if (!locator) return { status: 'unresolved', reason: 'reference_not_found' };
  const sessionId = locator.sessionId;
  const entries = memoEntries(store, sessionId);
  let entry = entries.find(item => item.record.turnId === locator.turnId && item.record.toolCall.id === locator.toolCallId);
  let recovered = false;
  if (!entry && !('number' in identity) && scope.sessionId === sessionId && scope.turnId === identity.turnId && scope.fileName
      && !store.get(sessionId, identity.turnId, identity.toolCallId)) {
    const candidates = entries.filter(item => item.record.turnId === identity.turnId && item.memo.file.name === scope.fileName
      && nearCallId(identity.toolCallId, item.record.toolCall.id));
    if (candidates.length > 1) return { status: 'unresolved', reason: 'ambiguous_reference' };
    entry = candidates[0];
    recovered = Boolean(entry);
  }
  if (!entry) return { status: 'unresolved', reason: 'reference_not_found' };
  const recordedReference = entry.memo.reference;
  const memo = publicMemo(store, entry);
  if (recordedReference !== fileMemoReference({ sessionId, turnId: entry.record.turnId, toolCallId: entry.record.toolCall.id })
      && recordedReference !== memo.reference) {
    return { status: 'unresolved', reason: 'reference_mismatch' };
  }
  if (scope.fileName && scope.fileName !== entry.memo.file.name) return { status: 'unresolved', reason: 'reference_mismatch' };
  try {
    const current = await stat(memo.file.path);
    return { memo, ...(recovered ? { recovered } : {}), status: !current.isFile() ? 'unavailable' :
      current.size === memo.file.size && current.mtimeMs === memo.file.mtimeMs ? 'available' : 'changed' };
  } catch { return { memo, status: 'unavailable' }; }
}

export function registerFileMemoTools(registry: ToolRegistry, store: ToolExecutionStore): void {
  const manifest = { effect_kind: 'observation' as const, operation: 'file_memo', risk: 'low' as const,
    owner: 'runtime', dispatch_scope: 'parent_session' as const, mutating: false };
  registry.register({
    definition: { name: FILE_MEMO_WRITE_TOOL,
      description: 'Record or update a concise file memo in this conversation: an existing absolute file path, one short purpose and at most 3 short observations. These are your notes, not host-verified conclusions. No execution logs, dialogue summaries or long tool output. Copy the returned markdown directly when delivering a file, or use its reference verbatim in an image. References use simple stable numbers such as cardbush-memo:1, issued by the host and valid across parent/child conversations. Never construct a link from the file ID or a tool-call ID. Each revision keeps its original note and reference; the file remains at its original path. Use read_file_memos to retrieve links again.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['path', 'purpose'], properties: {
        path: { type: 'string', minLength: 1, maxLength: 32768 }, purpose: { type: 'string', minLength: 1, maxLength: 120, pattern: '^[^\\r\\n]+$' },
        points: { type: 'array', maxItems: 3, items: { type: 'string', minLength: 1, maxLength: 160, pattern: '^[^\\r\\n]+$' } },
      } } },
    manifest, parallelSafe: false, executionChannel: 'runtime:file_memo',
    decodeInput: value => fileMemoInputSchema.parse(value),
    execute: async context => {
      if (!isAbsolute(context.input.path)) throw new Error('File memo path must be absolute.');
      context.signal?.throwIfAborted();
      const path = await realpath(context.input.path);
      const file = await stat(path);
      if (!file.isFile()) throw new Error('File memos reference files, not folders.');
      context.signal?.throwIfAborted();
      const entries = memoEntries(store, context.sessionId);
      const existing = entries.find(entry => identityPath(entry.memo.file.path) === identityPath(path));
      const fileNumber = existing?.fileNumber ?? new Set(entries.map(entry => entry.fileNumber)).size + 1;
      const reference = fileMemoReference({ number: store.reserveFileMemoReference({ sessionId: context.sessionId, turnId: context.turnId, toolCallId: context.toolCall.id }) });
      return fileMemoSchema.parse({ protocol: FILE_MEMO_PROTOCOL, id: `file_${fileNumber}`, reference,
        markdown: fileMemoMarkdown(basename(path), reference),
        file: { path, name: basename(path), size: file.size, mtimeMs: file.mtimeMs },
        note: { purpose: context.input.purpose, points: context.input.points },
      });
    },
  });
  registry.register<{ id?: string; offset: number }>({
    definition: { name: 'read_file_memos', description: 'Read this conversation\'s concise file memos by file ID (file_1, file_2, etc.), or list up to 10 entries per offset page. Returns the latest note and ready-to-use markdown link for each file, not execution history. An individual read checks whether the referenced file is available or changed. Older file IDs are still accepted.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', pattern: '^file_(?:[1-9]\\d{0,8}|[a-f0-9]{32})$' }, offset: { type: 'integer', minimum: 0, default: 0 },
      } } },
    manifest, parallelSafe: false, executionChannel: 'runtime:file_memo',
    decodeInput: value => {
      const input = value as Record<string, unknown>;
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['id', 'offset'].includes(k)) ||
        (input.id !== undefined && (typeof input.id !== 'string' || !/^file_(?:[1-9]\d{0,8}|[a-f0-9]{32})$/.test(input.id))) ||
        (input.offset !== undefined && (!Number.isSafeInteger(input.offset) || Number(input.offset) < 0))) throw new Error('Use an optional file ID and nonnegative offset.');
      return { id: input.id as string | undefined, offset: Number(input.offset) || 0 };
    },
    execute: async context => {
      const entries = memoEntries(store, context.sessionId);
      const latest = new Map<number, MemoEntry>();
      for (const entry of entries) latest.set(entry.fileNumber, entry);
      if (context.input.id) {
        const matching = entries.find(entry => entry.memo.id === context.input.id || `file_${entry.fileNumber}` === context.input.id);
        const entry = matching && latest.get(matching.fileNumber);
        if (!entry) throw new Error('File memo was not found in this conversation.');
        return resolveFileMemo(store, publicMemo(store, entry).reference, { sessionId: context.sessionId });
      }
      const memos = [...latest.values()].map(entry => publicMemo(store, entry));
      const end = context.input.offset + 10;
      return { memos: memos.slice(context.input.offset, end), total: memos.length, ...(end < memos.length ? { next_offset: end } : {}) };
    },
  });
}

/** Check actual Markdown destinations, excluding examples in code. Does not rewrite model history. */
export async function validateFileMemoLinks(store: ToolExecutionStore, content: string, scope: Required<Pick<FileMemoScope, 'sessionId' | 'turnId'>>) {
  if (!content.includes('cardbush-memo:')) return { invalid: [], links: [] };
  const prose = content.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$/gm, match => ' '.repeat(match.length))
    .replace(/(`+)[^`]*?\1/g, match => ' '.repeat(match.length));
  const links = [...prose.matchAll(/\[((?:\\.|[^\]\\\r\n])*)\]\(\s*<?(cardbush-memo:[^\s<>)]*)>?\s*(?:["'][^\r\n]*?["']\s*)?\)|<((?:cardbush-memo:)[^\s<>]+)>|^\s*\[[^\]\r\n]+\]:\s*<?(cardbush-memo:[^\s<>]+)>?/gm)];
  const invalid: Array<{ reference: string; reason: string }> = [];
  const seen = new Set<string>();
  for (const match of links) {
    const reference = match[2] ?? match[3] ?? match[4]!;
    if (seen.has(reference)) continue;
    seen.add(reference);
    // New deliveries must be exact; the conservative legacy repair is for already-saved messages.
    const label = match[1]?.replace(/\\([\\\[\]])/g, '$1').trim();
    const fileName = label && /^[^\\/\r\n]+\.[a-z0-9]{1,12}$/i.test(label) ? label : undefined;
    const result = await resolveFileMemo(store, reference, { sessionId: scope.sessionId, fileName });
    if (result.status === 'unresolved' || result.status === 'unavailable') invalid.push({ reference, reason: result.status === 'unresolved' ? result.reason : 'file_unavailable' });
    if (invalid.length >= 10) break;
  }
  const latest = new Map<number, MemoEntry>();
  if (invalid.length) for (const entry of memoEntries(store, scope.sessionId)) latest.set(entry.fileNumber, entry);
  const availableLinks: string[] = [];
  for (const entry of [...latest.values()].slice(-10)) {
    const memo = publicMemo(store, entry);
    const result = await resolveFileMemo(store, memo.reference);
    if (result.status === 'available' || result.status === 'changed') availableLinks.push(memo.markdown!);
  }
  return { invalid, links: availableLinks };
}
