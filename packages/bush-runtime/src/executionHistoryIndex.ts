import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { toolExecutionRecordSchema } from '@cardbush/bush-protocol';
import { boundedJournalLines } from './boundedJournalLines.js';
import { EXECUTION_HISTORY_SUMMARY_VERSION, summarizeExecution, validHistoryEntry, type ExecutionHistoryPage } from './executionHistory.js';

type Index = ExecutionHistoryPage & { version: number; outdated: number; sessionId: string; through: number; mtimeMs: number; prefix: string };
const digest = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const asPage = (index: ExecutionHistoryPage): ExecutionHistoryPage => ({ entries: index.entries, omitted: index.omitted,
  ...(index.outdated ? { outdated: index.outdated } : {}) });
function summaryHeader(prefix: string) {
  const boundary = prefix.indexOf(',"record":');
  return boundary >= 0 ? JSON.parse(prefix.slice(0, boundary) + '}') : undefined;
}

async function prefixHash(path: string, through: number) {
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(4096, through));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return digest(buffer.subarray(0, bytesRead));
  } finally { await file.close(); }
}

/** Disposable, bounded excerpts; the append-only journal remains authoritative. */
export class ExecutionHistoryIndex {
  readonly #pending = new Map<string, Promise<ExecutionHistoryPage>>();

  async read(journal: string, sessionId: string, signal?: AbortSignal): Promise<ExecutionHistoryPage> {
    const prior = this.#pending.get(journal);
    const task = (prior ? prior.catch(() => {}) : Promise.resolve()).then(() => this.#read(journal, sessionId, signal));
    this.#pending.set(journal, task);
    try { return await task; }
    finally { if (this.#pending.get(journal) === task) this.#pending.delete(journal); }
  }

  async #read(journal: string, sessionId: string, signal?: AbortSignal): Promise<ExecutionHistoryPage> {
    signal?.throwIfAborted();
    const source = await stat(journal).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (!source) return { entries: [], omitted: 0 };
    const path = `${journal}.history`;
    let index: Index | undefined;
    try {
      const cached = JSON.parse(await readFile(path, 'utf8'));
      const data = cached.index as Index;
      if (data?.version === EXECUTION_HISTORY_SUMMARY_VERSION && data.sessionId === sessionId && Number.isSafeInteger(data.through) && data.through >= 0 &&
          Number.isSafeInteger(data.outdated) && data.outdated >= 0 &&
          Number.isSafeInteger(data.omitted) && data.omitted >= 0 && Number.isFinite(data.mtimeMs) &&
          data.through <= source.size && (data.through < source.size || data.mtimeMs === source.mtimeMs) &&
          cached.checksum === digest(JSON.stringify(data)) && Array.isArray(data.entries) &&
          data.entries.every(entry => validHistoryEntry(entry, sessionId)) &&
          data.prefix === await prefixHash(journal, data.through)) index = data;
    } catch (error) {
      signal?.throwIfAborted();
      if ((error as NodeJS.ErrnoException).code && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // A missing or invalid derived index can always be rebuilt from the source.
    }
    if (!index) index = { version: EXECUTION_HISTORY_SUMMARY_VERSION, sessionId, through: 0, mtimeMs: 0, prefix: '', entries: [], omitted: 0, outdated: 0 };
    if (index.through === source.size && index.mtimeMs === source.mtimeMs) return asPage(index);
    const ids = new Set(index.entries.map(entry => entry.id));
    const add = (entry: ExecutionHistoryPage['entries'][number]) => {
      if (ids.has(entry.id)) throw new Error('Duplicate execution history record.');
      ids.add(entry.id); index!.entries.push(entry);
    };
    for await (const line of boundedJournalLines(journal, { start: index.through, end: source.size, maxBytes: 16 * 1024 * 1024, signal,
      skip: prefix => {
        const header = summaryHeader(prefix);
        return header?.history === null || header?.history?.summaryVersion === EXECUTION_HISTORY_SUMMARY_VERSION;
      },
    })) {
      signal?.throwIfAborted();
      const header = summaryHeader(line.prefix);
      if (header && Object.hasOwn(header, 'history')) {
        if (header.protocol !== 'bush.tool_execution_journal_record.v1' || header.historyChecksum !== digest(JSON.stringify(header.history)) ||
            (header.history !== null && !validHistoryEntry(header.history, sessionId))) throw new Error('Execution history summary checksum or identity mismatch.');
      }
      if (header?.history === null) { /* Search receipts never index themselves. */ }
      else if (header?.history?.summaryVersion === EXECUTION_HISTORY_SUMMARY_VERSION) add(header.history);
      else if (line.text === undefined) {
        // Preserve a checked old excerpt if its native payload cannot be safely
        // re-read. A future summary format must not silently drop this receipt.
        if (header?.history) { add(header.history); index.outdated++; }
        else index.omitted++;
      } else if (line.text.trim()) {
        const row = JSON.parse(line.text);
        if (row.protocol !== 'bush.tool_execution_journal_record.v1' || row.checksum !== digest(JSON.stringify(row.record))) {
          throw new Error('Execution history journal checksum mismatch.');
        }
        const record = toolExecutionRecordSchema.parse(row.record);
        if (record.sessionId !== sessionId) throw new Error('Execution history session identity mismatch.');
        const entry = summarizeExecution(record);
        if (entry) add(entry);
      }
      index.through = line.end;
    }
    index.mtimeMs = source.mtimeMs;
    index.prefix = await prefixHash(journal, index.through);
    signal?.throwIfAborted();
    // A crash may leave a disposable temporary file; ordinary cache maintenance owns it.
    const temporary = join(dirname(journal), `${basename(journal, '.jsonl')}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify({ checksum: digest(JSON.stringify(index)), index }), { flag: 'wx', mode: 0o600, signal });
      signal?.throwIfAborted();
      await rename(temporary, path);
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    return asPage(index);
  }
}
