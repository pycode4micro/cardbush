import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { FILE_MEMO_PROTOCOL, fileMemoInputSchema, fileMemoReference, fileMemoSchema, parseFileMemoReference,
  type FileMemo, type FileMemoResolution } from '@cardbush/bush-protocol';
import type { ToolRegistry } from './toolRegistry.js';
import type { ToolExecutionStore } from './toolExecutionStore.js';

export const FILE_MEMO_WRITE_TOOL = 'remember_file';
export async function resolveFileMemo(store: ToolExecutionStore, reference: string): Promise<FileMemoResolution> {
  const identity = parseFileMemoReference(reference);
  if (!identity) throw new Error('Invalid file memo reference.');
  const record = store.get(identity.sessionId, identity.turnId, identity.toolCallId);
  if (record?.toolCall.name !== FILE_MEMO_WRITE_TOOL || record.outcome !== 'returned') throw new Error('File memo reference is unavailable.');
  const memo = fileMemoSchema.parse(record.result);
  if (memo.reference !== reference) throw new Error('File memo reference does not match its record.');
  try {
    const current = await stat(memo.file.path);
    return { memo, status: !current.isFile() ? 'unavailable' :
      current.size === memo.file.size && current.mtimeMs === memo.file.mtimeMs ? 'available' : 'changed' };
  } catch { return { memo, status: 'unavailable' }; }
}

export function registerFileMemoTools(registry: ToolRegistry, store: ToolExecutionStore): void {
  const manifest = { effect_kind: 'observation' as const, operation: 'file_memo', risk: 'low' as const,
    owner: 'runtime', dispatch_scope: 'parent_session' as const, mutating: false };
  registry.register({
    definition: { name: FILE_MEMO_WRITE_TOOL,
      description: 'Record or update a concise file memo in this conversation: an existing absolute file path, one short purpose and at most 3 short observations. These are your notes, not host-verified conclusions. No execution logs, dialogue summaries or long tool output. The returned reference can be used verbatim in Markdown links or images. Older references keep their original memo; the file itself remains at its original path.',
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
      const identityPath = process.platform === 'win32' ? path.toLowerCase() : path;
      return fileMemoSchema.parse({ protocol: FILE_MEMO_PROTOCOL,
        id: 'file_' + createHash('sha256').update(JSON.stringify([context.sessionId, identityPath])).digest('hex').slice(0, 32),
        reference: fileMemoReference({ sessionId: context.sessionId, turnId: context.turnId, toolCallId: context.toolCall.id }),
        file: { path, name: basename(path), size: file.size, mtimeMs: file.mtimeMs },
        note: { purpose: context.input.purpose, points: context.input.points },
      });
    },
  });
  registry.register<{ id?: string; offset: number }>({
    definition: { name: 'read_file_memos', description: 'Read this conversation\'s concise file memos by file ID, or list up to 10 entries per offset page. Returns the latest note per file and its reference, not execution history. An individual read also checks whether the referenced file is available or changed.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', pattern: '^file_[a-f0-9]{32}$' }, offset: { type: 'integer', minimum: 0, default: 0 },
      } } },
    manifest, parallelSafe: true,
    decodeInput: value => {
      const input = value as Record<string, unknown>;
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['id', 'offset'].includes(k)) ||
        (input.id !== undefined && (typeof input.id !== 'string' || !/^file_[a-f0-9]{32}$/.test(input.id))) ||
        (input.offset !== undefined && (!Number.isSafeInteger(input.offset) || Number(input.offset) < 0))) throw new Error('Use an optional file ID and nonnegative offset.');
      return { id: input.id as string | undefined, offset: Number(input.offset) || 0 };
    },
    execute: async context => {
      const latest = new Map<string, FileMemo>();
      for (const record of store.listByTool(context.sessionId, FILE_MEMO_WRITE_TOOL)) {
        if (record.outcome !== 'returned') continue;
        const memo = fileMemoSchema.safeParse(record.result);
        if (memo.success) latest.set(memo.data.id, memo.data);
      }
      if (context.input.id) {
        const memo = latest.get(context.input.id);
        if (!memo) throw new Error('File memo was not found in this conversation.');
        return resolveFileMemo(store, memo.reference);
      }
      const entries = [...latest.values()].sort((a, b) => a.id.localeCompare(b.id));
      const end = context.input.offset + 10;
      return { memos: entries.slice(context.input.offset, end), total: entries.length, ...(end < entries.length ? { next_offset: end } : {}) };
    },
  });
}
