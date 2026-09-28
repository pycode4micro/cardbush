import { open, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, isAbsolute } from 'node:path';
import { sourceMemoInputSchema, sourceMemoSchema, parseSourceMemoReference,
  type SourceEvidence, type SourceMemoResolution } from '@cardbush/bush-protocol';
import type { ToolRegistry } from './toolRegistry.js';
import type { ToolExecutionStore } from './toolExecutionStore.js';
import { authorizePath } from './workspaceAccessPolicy.js';
import type { ToolPermissionRequest } from './toolRegistry.js';

const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
export function sourceMemoReference(identity: { number: number; sessionId: string; turnId: string; toolCallId: string }): string {
  const guard = createHash('sha256').update(JSON.stringify([identity.sessionId, identity.turnId, identity.toolCallId])).digest('hex').slice(0, 16);
  return `cardbush-source:${identity.number}-${guard}`;
}
async function snapshot(input: { target: string; label?: string; locator?: SourceEvidence['locator'] }, signal?: AbortSignal): Promise<SourceEvidence> {
  if (/^https?:\/\//i.test(input.target)) {
    const url = new URL(input.target);
    if (url.username || url.password) throw new Error('Source URLs must not contain credentials.');
    return { ...input, target: url.href, kind: 'url', label: input.label || url.hostname };
  }
  if (!isAbsolute(input.target)) throw new Error('A Source target must be an absolute file path or an HTTP(S) URL.');
  signal?.throwIfAborted();
  const target = await realpath(input.target);
  const handle = await open(target, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error('Source evidence must be a file.');
    let excerpt: string | undefined;
    let sha256: string | undefined;
    // Bound memory and avoid loading large media merely to annotate a conclusion.
    if (before.size <= MAX_SNAPSHOT_BYTES) {
      const buffer = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < buffer.length) {
        signal?.throwIfAborted();
        const read = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (!read.bytesRead) break;
        offset += read.bytesRead;
      }
      sha256 = createHash('sha256').update(buffer.subarray(0, offset)).digest('hex');
      if (input.locator?.line) {
        const content = buffer.toString('utf8');
        if (content.includes('\0') || content.includes('\uFFFD')) throw new Error('Line locators require a UTF-8 text file.');
        const lines = content.split(/\r?\n/);
        if (input.locator.line > lines.length || (input.locator.endLine ?? input.locator.line) > lines.length) throw new Error('Source line is outside the file.');
        excerpt = lines.slice(input.locator.line - 1, Math.min(input.locator.endLine ?? input.locator.line + 3, input.locator.line + 19)).join('\n').slice(0, 1600);
      }
    } else if (input.locator?.line) throw new Error('Use a file reference without a line locator for files larger than 2 MiB.');
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('File changed while recording Source; retry after the edit finishes.');
    return { ...input, target, kind: 'file', label: input.label || basename(target),
      version: { size: after.size, mtimeMs: after.mtimeMs, ...(sha256 ? { sha256 } : {}) }, ...(excerpt !== undefined ? { excerpt } : {}) };
  } finally { await handle.close(); }
}

export async function resolveSourceMemo(store: ToolExecutionStore, reference: string): Promise<SourceMemoResolution> {
  const number = parseSourceMemoReference(reference);
  if (!number) return { status: 'unresolved', reason: 'invalid_reference' };
  const identity = store.getFileMemoReference(number);
  const record = identity && store.get(identity.sessionId, identity.turnId, identity.toolCallId);
  if (!record || record.toolCall.name !== 'remember_source' || record.outcome !== 'returned') return { status: 'unresolved', reason: 'reference_not_found' };
  const parsed = sourceMemoSchema.safeParse(record.result);
  if (!parsed.success || parsed.data.reference !== reference) return { status: 'unresolved', reason: 'reference_mismatch' };
  const evidenceStatus = await Promise.all(parsed.data.sources.map(async source => {
    if (source.kind === 'url') return 'link' as const;
    try {
      const file = await stat(source.target);
      if (!file.isFile()) return 'unavailable' as const;
      if (file.size !== source.version?.size || file.mtimeMs !== source.version.mtimeMs) return 'changed' as const;
      if (source.version.sha256) {
        const current = await snapshot({ target: source.target });
        if (current.version?.sha256 !== source.version.sha256) return 'changed' as const;
      }
      return 'available' as const;
    } catch { return 'unavailable' as const; }
  }));
  return { status: 'resolved', memo: parsed.data, evidenceStatus };
}

export function registerSourceMemoTools(registry: ToolRegistry, store: ToolExecutionStore): void {
  const manifest = { effect_kind: 'observation' as const, operation: 'source_memo', risk: 'low' as const,
    owner: 'runtime', dispatch_scope: 'parent_session' as const, mutating: false };
  registry.register({
    definition: { name: 'remember_source', description: 'Prewrite a supplemental rationale for a worthwhile final-answer claim, change or review finding. Attach up to 8 actual supporting absolute file paths or HTTP(S) links; omit sources for your own design judgment (displayed as Agent explanation). These are your notes, not independently verified conclusions. Optional locator: line/endLine, page, object or normalized image region. The host captures file version and a small text excerpt for line locators; links are not fetched or verified. Use the exact returned Markdown marker beside the relevant prose; keep the final answer self-contained without copying the note into its summary. Do not replace ordinary file, image, download or web links, annotate every sentence, invent evidence, or store secrets. Each note is immutable; create a new one for a new conclusion. Use read_source_memos to retrieve previous markers. Source off means do not create or add these annotations for that turn.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['explanation'], properties: {
        explanation: { type: 'string', minLength: 1, maxLength: 600,
          description: 'Brief natural prose explaining why the change is needed, how evidence supports the claim, or why this approach was chosen. Add a concrete cause, constraint, consequence or tradeoff beyond the final-answer summary; do not recap edits or passing tests. Distinguish necessary properties from optional implementations. State uncertainty; never invent reasons or present a design choice as uniquely necessary. Skip the annotation if it adds no information. No fixed headings or template.' },
        sources: { type: 'array', maxItems: 8,
          description: 'Evidence supporting the rationale. Prefer locations that establish the relevant cause or constraint, rather than merely listing changed files.', items: {
          type: 'object', additionalProperties: false, required: ['target'], properties: {
            target: { type: 'string' }, label: { type: 'string', maxLength: 160 }, locator: { type: 'object', additionalProperties: false, properties: {
              line: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 }, page: { type: 'integer', minimum: 1 }, object: { type: 'string', maxLength: 160 },
              region: { type: 'object', additionalProperties: false, required: ['x', 'y', 'width', 'height'], properties: { x: { type: 'number', minimum: 0, maximum: 1 }, y: { type: 'number', minimum: 0, maximum: 1 }, width: { type: 'number', exclusiveMinimum: 0, maximum: 1 }, height: { type: 'number', exclusiveMinimum: 0, maximum: 1 } } },
            } },
          },
        } },
      } } }, manifest, parallelSafe: false, executionChannel: 'runtime:file_memo',
    decodeInput: value => sourceMemoInputSchema.parse(value),
    authorize: async context => {
      let request: ToolPermissionRequest | undefined;
      for (const source of context.input.sources) {
        if (/^https?:\/\//i.test(source.target)) continue;
        if (!isAbsolute(source.target)) throw new Error('Source file paths must be absolute.');
        const decision = await authorizePath('read')({ ...context, input: { path: source.target } });
        if (decision.kind === 'ask') request = request ? { ...request,
          targets: [...request.targets, ...decision.request.targets], capabilityIds: [...request.capabilityIds, ...decision.request.capabilityIds] } : decision.request;
      }
      return request ? { kind: 'ask', request } : { kind: 'allow' };
    },
    renderModelResult: value => {
      const memo = sourceMemoSchema.parse(value);
      return JSON.stringify({ markdown: memo.markdown, explanation: memo.explanation,
        sources: memo.sources.map(({ target, locator }) => ({ target, ...(locator ? { locator } : {}) })) });
    },
    execute: async context => {
      const sources: SourceEvidence[] = [];
      for (const source of context.input.sources) sources.push(await snapshot(source, context.signal));
      context.signal?.throwIfAborted();
      const number = store.reserveFileMemoReference({ sessionId: context.sessionId, turnId: context.turnId, toolCallId: context.toolCall.id });
      // The locator number is host-local. Guard it with the immutable execution
      // identity so a copied remote link can never resolve to an unrelated note.
      const reference = sourceMemoReference({ number, sessionId: context.sessionId, turnId: context.turnId, toolCallId: context.toolCall.id });
      return sourceMemoSchema.parse({ protocol: 'bush.source_memo.v1', reference, markdown: `[${number}](${reference})`,
        explanation: context.input.explanation, sources, createdAt: new Date().toISOString() });
    },
  });
  registry.register<{ offset: number }>({
    definition: { name: 'read_source_memos', description: 'Retrieve this conversation’s immutable Source notes and exact Markdown markers, 10 per page. Use offset for more. File delivery memos remain available through read_file_memos.',
      inputSchema: { type: 'object', additionalProperties: false, properties: { offset: { type: 'integer', minimum: 0 } } } },
    manifest, parallelSafe: false, executionChannel: 'runtime:file_memo',
    decodeInput: value => {
      const input = value as { offset?: number };
      if (!input || Object.keys(input).some(key => key !== 'offset') || (input.offset !== undefined && (!Number.isSafeInteger(input.offset) || input.offset < 0))) throw new Error('Use a nonnegative offset.');
      return { offset: input.offset ?? 0 };
    },
    execute: async context => {
      const memos = store.listByTool(context.sessionId, 'remember_source').filter(record => record.outcome === 'returned')
        .flatMap(record => { const memo = sourceMemoSchema.safeParse(record.result); return memo.success ? [memo.data] : []; });
      return { memos: memos.slice(context.input.offset, context.input.offset + 10), total: memos.length,
        ...(context.input.offset + 10 < memos.length ? { next_offset: context.input.offset + 10 } : {}) };
    },
  });
}
