import { createHash } from 'node:crypto';
import { sourceMemoSchema, parseSourceMemoIdentity, parseSourceMemoReference,
  type SourceEvidence, type SourceMemo, type SourceMemoResolution, type SourceReferencesRequest, type SourceReferences } from '@cardbush/bush-protocol';
import { memoMarkdownLinks } from './memoMarkdownLinks.js';
import type { FileMemoLocator, ToolExecutionStore } from './toolExecutionStore.js';
import { readMemoFile } from './memoFileAccess.js';
import type { RemoteWorkspaceBridge } from './workspaceTools.js';

const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
/** Bind display shorthand only from notes created or explicitly read in this turn.
 * Never infer a guarded identity from the display number alone or read evidence files. */
export function resolveSourceReferences(store: ToolExecutionStore, input: SourceReferencesRequest): SourceReferences {
  const requested = new Set(input.numbers), found = new Map<number, Set<string>>();
  for (const memo of observedSourceMemos(store, input)) {
    const number = parseSourceMemoReference(memo.reference)!;
    if (!requested.has(number)) continue;
    const references = found.get(number) ?? new Set<string>();
    references.add(memo.reference); found.set(number, references);
  }
  return [...requested].flatMap(number => {
    const references = found.get(number);
    return references?.size === 1 ? [{ number, reference: [...references][0]! }] : [];
  });
}

function observedSourceMemos(store: ToolExecutionStore, scope: { sessionId: string; turnId: string }): SourceMemo[] {
  const readReferences = new Set<string>();
  for (const record of store.listByTool(scope.sessionId, 'read_source_memos', scope.turnId)) {
    if (record.outcome !== 'returned') continue;
    const memos = (record.result as { memos?: unknown[] } | null)?.memos;
    if (Array.isArray(memos)) for (const value of memos) {
      const memo = sourceMemoSchema.safeParse(value);
      if (memo.success) readReferences.add(memo.data.reference);
    }
  }
  const memos: SourceMemo[] = [];
  for (const record of store.listByTool(scope.sessionId, 'remember_source')) {
    if (record.outcome !== 'returned') continue;
    const memo = sourceMemoSchema.safeParse(record.result);
    if (!memo.success || (record.turnId !== scope.turnId && !readReferences.has(memo.data.reference))) continue;
    const parsed = parseSourceMemoIdentity(memo.data.reference)!;
    const identity = store.getFileMemoReference(parsed.locator);
    // Forked tool history keeps the original guarded link, not a new identity.
    if (!identity || identity.turnId !== record.turnId || identity.toolCallId !== record.toolCall.id || memo.data.reference !== sourceMemoReference(identity)) continue;
    memos.push(memo.data);
  }
  return memos;
}

/** Validate immutable identity without fetching evidence or repairing guards. */
function sourceMemoFact(store: ToolExecutionStore, reference: string):
  { status: 'resolved'; memo: SourceMemo } | Extract<SourceMemoResolution, { status: 'unresolved' }> {
  const parsedReference = parseSourceMemoIdentity(reference);
  if (!parsedReference) return { status: 'unresolved', reason: 'invalid_reference' };
  const identity = store.getFileMemoReference(parsedReference.locator);
  const record = identity && store.get(identity.sessionId, identity.turnId, identity.toolCallId);
  if (!record || record.toolCall.name !== 'remember_source' || record.outcome !== 'returned') return { status: 'unresolved', reason: 'reference_not_found' };
  const parsed = sourceMemoSchema.safeParse(record.result);
  if (!parsed.success || parsed.data.reference !== reference || sourceMemoReference(identity!) !== reference) return { status: 'unresolved', reason: 'reference_mismatch' };
  return { status: 'resolved', memo: parsed.data };
}

export function validateSourceMemoLinks(store: ToolExecutionStore, content: string, scope: { sessionId: string; turnId: string }) {
  const invalid: Array<{ reference: string; reason: string }> = [];
  for (const reference of new Set(memoMarkdownLinks(content, 'cardbush-source').map(link => link.reference))) {
    const result = sourceMemoFact(store, reference);
    if (result.status === 'unresolved') invalid.push({ reference, reason: result.reason });
    if (invalid.length >= 10) break;
  }
  return { invalid, links: invalid.length ? observedSourceMemos(store, scope).slice(-10).map(modelSourceMemo) : [] };
}

function modelSourceMemo(memo: SourceMemo) {
  return { markdown: `[${parseSourceMemoReference(memo.reference)!}]`, explanation: memo.explanation,
    sources: memo.sources.map(({ target, locator }) => ({ target, ...(locator ? { locator } : {}) })) };
}
export function sourceMemoReference(identity: FileMemoLocator): string {
  const guard = createHash('sha256').update(JSON.stringify([identity.sessionId, identity.turnId, identity.toolCallId])).digest('hex').slice(0, 16);
  return identity.sourceNumber === undefined ? `cardbush-source:${identity.number}-${guard}`
    : `cardbush-source:v2:${identity.sourceNumber}:${identity.number}-${guard}`;
}
async function snapshot(input: { target: string; label?: string; locator?: SourceEvidence['locator'] }, signal?: AbortSignal, remote?: RemoteWorkspaceBridge): Promise<SourceEvidence> {
  if (/^https?:\/\//i.test(input.target)) {
    const url = new URL(input.target);
    if (url.username || url.password) throw new Error('Source URLs must not contain credentials.');
    return { ...input, target: url.href, kind: 'url', label: input.label || url.hostname };
  }
  const file = await readMemoFile(input.target, MAX_SNAPSHOT_BYTES, remote, signal);
  let excerpt: string | undefined;
  if (input.locator?.line) {
    if (!file.content) throw Error('Use a file reference without a line locator for files larger than 2 MiB.');
    const content = file.content.toString('utf8');
    if (content.includes('\0') || content.includes('\uFFFD')) throw Error('Line locators require a UTF-8 text file.');
    const lines = content.split(/\r?\n/);
    if (input.locator.line > lines.length || (input.locator.endLine ?? input.locator.line) > lines.length) throw Error('Source line is outside the file.');
    excerpt = lines.slice(input.locator.line - 1, Math.min(input.locator.endLine ?? input.locator.line + 3, input.locator.line + 19)).join('\n').slice(0, 1600);
  }
  return { ...input, target: file.path, kind: 'file', label: input.label || file.name,
    version: { size: file.size, mtimeMs: file.mtimeMs, ...(file.content ? { sha256: createHash('sha256').update(file.content).digest('hex') } : {}) },
    ...(excerpt !== undefined ? { excerpt } : {}) };
}

export async function resolveSourceMemo(store: ToolExecutionStore, reference: string, remote?: RemoteWorkspaceBridge): Promise<SourceMemoResolution> {
  const fact = sourceMemoFact(store, reference);
  if (fact.status === 'unresolved') return fact;
  const evidenceStatus = await Promise.all(fact.memo.sources.map(async source => {
    if (source.kind === 'url') return 'link' as const;
    try {
      const file = await readMemoFile(source.target, 0, remote);
      if (file.size !== source.version?.size || file.mtimeMs !== source.version.mtimeMs) return 'changed' as const;
      if (source.version.sha256) {
        const current = await snapshot({ target: source.target }, undefined, remote);
        if (current.version?.sha256 !== source.version.sha256) return 'changed' as const;
      }
      return 'available' as const;
    } catch { return 'unavailable' as const; }
  }));
  return { status: 'resolved', memo: fact.memo, evidenceStatus };
}
