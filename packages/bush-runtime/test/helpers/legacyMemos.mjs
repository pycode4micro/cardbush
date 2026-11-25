import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileMemoMarkdown, fileMemoReference, parseSourceMemoReference } from '@cardbush/bush-protocol';
import { readMemoFile } from '../../dist/memoFileAccess.js';
import { sourceMemoReference } from '../../dist/sourceMemo.js';

const legacyIndexes = new WeakMap();

export function seedLegacyLocator(store, identity, sourceNumber) {
  let index = legacyIndexes.get(store);
  if (!index) {
    index = store.fileMemoLocators();
    legacyIndexes.set(store, index);
    store.fileMemoLocators = () => structuredClone(index);
    store.getFileMemoReference = number => structuredClone(index.find(item => item.number === number));
  }
  const { sessionId, turnId, toolCallId } = identity;
  const reference = { sessionId, turnId, toolCallId, number: (index.at(-1)?.number ?? 0) + 1,
    ...(sourceNumber === undefined ? {} : { sourceNumber }) };
  index.push(reference);
  return reference;
}

/** Write the previous release's storage format for tests that reopen a host. */
export function persistLegacyMemoIndex(store, directory) {
  const rows = store.fileMemoLocators().map(reference => JSON.stringify({
    protocol: 'bush.file_memo_locator.v1', reference,
    checksum: createHash('sha256').update(JSON.stringify(reference)).digest('hex'),
  }));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, '.file-memo-references'), rows.join('\n') + '\n');
  writeFileSync(join(directory, '.file-memo-references-created'), '');
}

export function recordLegacyMemo(store, identity, name, result) {
  const call = { protocol: 'bush.tool_call.v1', id: identity.toolCallId, name, argumentsText: '{}' };
  const outcome = { kind: 'returned', result, workspaceChanges: [], actionManifest: {
    protocol: 'bush.tool.action_manifest.v1', manifest_id: 'legacy-memo-fixture',
    effect_kind: 'observation', operation: 'file_memo', owner: 'runtime', risk: 'low', dispatch_scope: 'session', mutating: false,
  } };
  store.record(call, { requestId: 'legacy-memo-fixture', round: 1, ordinal: 0, ...identity }, outcome);
  return outcome;
}

async function fixtureFile(target, includeContent, remote) {
  if (target.startsWith('ssh://')) return readMemoFile(target, includeContent ? 2 * 1024 * 1024 : 0, remote);
  const path = await realpath(target);
  const { size, mtimeMs } = await stat(path);
  return { path, name: basename(path), size, mtimeMs, ...(includeContent ? { content: await readFile(path) } : {}) };
}

export async function seedLegacyFileMemo(store, identity, { path, purpose, points = [], id = 'file_1' }, remote) {
  const file = await fixtureFile(path, false, remote);
  const reference = fileMemoReference({ number: seedLegacyLocator(store, identity).number });
  return recordLegacyMemo(store, identity, 'remember_file', { protocol: 'bush.file_memo.v1',
    id, reference, markdown: fileMemoMarkdown(file.name, reference), file, note: { purpose, points } });
}

export async function seedLegacySourceMemo(store, identity, { explanation, sources = [] }, remote) {
  const snapshots = await Promise.all(sources.map(async source => {
    if (source.target.startsWith('https://')) return { ...source, kind: 'url', label: source.label ?? new URL(source.target).hostname };
    const file = await fixtureFile(source.target, true, remote);
    const excerpt = source.locator?.line ? file.content.toString().split(/\r?\n/).slice(source.locator.line - 1, source.locator.endLine ?? source.locator.line + 3).join('\n') : undefined;
    return { ...source, kind: 'file', target: file.path, label: file.name, excerpt,
      version: { size: file.size, mtimeMs: file.mtimeMs, sha256: createHash('sha256').update(file.content).digest('hex') } };
  }));
  const previous = store.listByTool(identity.sessionId, 'remember_source').flatMap(record => parseSourceMemoReference(record.result?.reference ?? '') ?? []);
  const locator = seedLegacyLocator(store, identity, Math.max(0, ...previous) + 1);
  const reference = sourceMemoReference(locator);
  return recordLegacyMemo(store, identity, 'remember_source', { protocol: 'bush.source_memo.v1', reference,
    markdown: `[${locator.sourceNumber}](${reference})`, explanation, sources: snapshots, createdAt: '2026-09-10T00:00:00Z' });
}
