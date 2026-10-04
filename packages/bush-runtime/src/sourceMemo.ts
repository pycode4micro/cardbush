import { createHash } from 'node:crypto';
import { sourceMemoInputSchema, sourceMemoSchema, parseSourceMemoIdentity, parseSourceMemoReference,
  type SourceEvidence, type SourceMemoResolution, type SourceReferencesRequest, type SourceReferences } from '@cardbush/bush-protocol';
import type { ToolRegistry } from './toolRegistry.js';
import type { FileMemoLocator, ToolExecutionStore } from './toolExecutionStore.js';
import { authorizeMemoFile, readMemoFile } from './memoFileAccess.js';
import type { RemoteWorkspaceBridge } from './workspaceTools.js';
import type { ToolPermissionRequest } from './toolRegistry.js';

const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
/** Repair display shorthand only from successful notes in this conversation/turn.
 * Never infer a guarded identity from the display number alone or read evidence files. */
export function resolveSourceReferences(store: ToolExecutionStore, input: SourceReferencesRequest): SourceReferences {
  const requested = new Set(input.numbers), found = new Map<number, Set<string>>();
  for (const record of store.listByTool(input.sessionId, 'remember_source', input.turnId)) {
    if (record.outcome !== 'returned') continue;
    const memo = sourceMemoSchema.safeParse(record.result);
    if (!memo.success) continue;
    const parsed = parseSourceMemoIdentity(memo.data.reference)!;
    if (!requested.has(parsed.number)) continue;
    const identity = store.getFileMemoReference(parsed.locator);
    // Forked tool history keeps the original guarded link, not a new identity.
    if (!identity || identity.turnId !== record.turnId || identity.toolCallId !== record.toolCall.id || memo.data.reference !== sourceMemoReference(identity)) continue;
    const references = found.get(parsed.number) ?? new Set<string>();
    references.add(memo.data.reference); found.set(parsed.number, references);
  }
  return [...requested].flatMap(number => {
    const references = found.get(number);
    return references?.size === 1 ? [{ number, reference: [...references][0]! }] : [];
  });
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
  const parsedReference = parseSourceMemoIdentity(reference);
  if (!parsedReference) return { status: 'unresolved', reason: 'invalid_reference' };
  const identity = store.getFileMemoReference(parsedReference.locator);
  const record = identity && store.get(identity.sessionId, identity.turnId, identity.toolCallId);
  if (!record || record.toolCall.name !== 'remember_source' || record.outcome !== 'returned') return { status: 'unresolved', reason: 'reference_not_found' };
  const parsed = sourceMemoSchema.safeParse(record.result);
  if (!parsed.success || parsed.data.reference !== reference) return { status: 'unresolved', reason: 'reference_mismatch' };
  const evidenceStatus = await Promise.all(parsed.data.sources.map(async source => {
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
  return { status: 'resolved', memo: parsed.data, evidenceStatus };
}

export function registerSourceMemoTools(registry: ToolRegistry, store: ToolExecutionStore, remote?: RemoteWorkspaceBridge): void {
  const manifest = { effect_kind: 'observation' as const, operation: 'source_memo', risk: 'low' as const,
    owner: 'runtime', dispatch_scope: 'parent_session' as const, mutating: false };
  registry.register({
    definition: { name: 'remember_source', description: 'Prewrite a supplemental rationale for a worthwhile final-answer claim, change or review finding. Attach up to 8 actual supporting absolute local file paths, ssh://saved-connection-id/absolute/file paths for remote evidence, or HTTP(S) links; omit sources for your own design judgment (displayed as Agent explanation). These are your notes, not independently verified conclusions. Optional locator: line/endLine, page, object or normalized image region. The host captures file version and a small text excerpt for line locators; links are not fetched or verified. Use the exact returned Markdown marker beside the relevant prose; keep the final answer self-contained without copying the note into its summary. Do not replace ordinary file, image, download or web links, annotate every sentence, invent evidence, or store secrets. Each note is immutable; create a new one for a new conclusion. Use read_source_memos to retrieve previous markers. Source off means do not create or add these annotations for that turn.',
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
        const decision = await authorizeMemoFile({ ...context, input: { path: source.target } }, remote);
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
      for (const source of context.input.sources) sources.push(await snapshot(source, context.signal, remote));
      context.signal?.throwIfAborted();
      const identity = store.reserveSourceMemoReference({ sessionId: context.sessionId, turnId: context.turnId, toolCallId: context.toolCall.id });
      // The display number is conversation-local; the host locator and immutable
      // execution guard keep copied links from resolving to unrelated notes.
      const reference = sourceMemoReference(identity), number = parseSourceMemoReference(reference)!;
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
