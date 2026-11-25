import { readMemoFile } from './memoFileAccess.js';
import { memoMarkdownLinks } from './memoMarkdownLinks.js';
import type { RemoteWorkspaceBridge } from './workspaceTools.js';
import { fileMemoMarkdown, fileMemoSchema, parseFileMemoReference,
  type FileMemo, type FileMemoResolution, type ToolExecutionRecord } from '@cardbush/bush-protocol';
import type { ToolExecutionStore } from './toolExecutionStore.js';

const FILE_MEMO_WRITE_TOOL = 'remember_file';
export interface FileMemoScope {
  sessionId?: string; turnId?: string;
  /** Optional hint for legacy call-ID typo recovery only; never part of a valid link's identity. */
  fileName?: string;
}
const identityPath = (path: string) => !path.startsWith('ssh:') && process.platform === 'win32' ? path.toLowerCase() : path;
type MemoEntry = { record: ToolExecutionRecord; memo: FileMemo };

// File IDs remain local to each conversation. Link numbers use the host's durable
// locator index so copied links and inherited child context keep the same target.
function memoEntries(store: ToolExecutionStore, sessionId: string): MemoEntry[] {
  const entries: MemoEntry[] = [];
  for (const record of store.listByTool(sessionId, FILE_MEMO_WRITE_TOOL)) {
    if (record.outcome !== 'returned') continue;
    const parsed = fileMemoSchema.safeParse(record.result);
    if (!parsed.success) continue;
    entries.push({ record, memo: parsed.data });
  }
  return entries;
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

export async function resolveFileMemo(store: ToolExecutionStore, reference: string, scope: FileMemoScope = {}, remote?: RemoteWorkspaceBridge): Promise<FileMemoResolution> {
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
  const recorded = parseFileMemoReference(entry.memo.reference);
  const stored = recorded && ('number' in recorded ? store.getFileMemoReference(recorded.number) : recorded);
  if (stored?.sessionId !== sessionId || stored.turnId !== entry.record.turnId || stored.toolCallId !== entry.record.toolCall.id) {
    return { status: 'unresolved', reason: 'reference_mismatch' };
  }
  const memo = { ...entry.memo, markdown: fileMemoMarkdown(entry.memo.file.name, entry.memo.reference) };
  try {
    const current = await readMemoFile(memo.file.path, 0, remote);
    return { memo, ...(recovered ? { recovered } : {}),
      currentVersion: { size: current.size, mtimeMs: current.mtimeMs },
      status: current.size === memo.file.size && current.mtimeMs === memo.file.mtimeMs ? 'available' : 'changed' };
  } catch { return { memo, status: 'unavailable' }; }
}

/** Check actual Markdown destinations, excluding examples in code. Does not rewrite model history. */
export async function validateFileMemoLinks(store: ToolExecutionStore, content: string, scope: Required<Pick<FileMemoScope, 'sessionId' | 'turnId'>>, remote?: RemoteWorkspaceBridge) {
  if (!content.includes('cardbush-memo:')) return { invalid: [], links: [] };
  const links = memoMarkdownLinks(content, 'cardbush-memo');
  const invalid: Array<{ reference: string; reason: string }> = [];
  const seen = new Set<string>();
  for (const { reference } of links) {
    if (seen.has(reference)) continue;
    seen.add(reference);
    // New deliveries must be exact; the conservative legacy repair is for already-saved messages.
    const result = await resolveFileMemo(store, reference, { sessionId: scope.sessionId }, remote);
    if (result.status === 'unresolved' || result.status === 'unavailable') invalid.push({ reference, reason: result.status === 'unresolved' ? result.reason : 'file_unavailable' });
    if (invalid.length >= 10) break;
  }
  const latest = new Map<string, MemoEntry>();
  if (invalid.length) for (const entry of memoEntries(store, scope.sessionId)) latest.set(identityPath(entry.memo.file.path), entry);
  const availableLinks: string[] = [];
  for (const entry of [...latest.values()].slice(-10)) {
    const result = await resolveFileMemo(store, entry.memo.reference, {}, remote);
    if (result.status === 'available' || result.status === 'changed') availableLinks.push(result.memo.markdown!);
  }
  return { invalid, links: availableLinks };
}
