// Pure retrieval replay: no provider, business Tool, shell command from history,
// or live persistence writer is created. With no arguments, use synthetic cases.
// Usage: node scripts/replay-execution-history.mjs [sessionId turnId [runtimeRoot]]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { summarizeExecution, EXECUTION_HISTORY_TOOL } from '../packages/bush-runtime/dist/executionHistory.js';
import { ExecutionHistoryIndex } from '../packages/bush-runtime/dist/executionHistoryIndex.js';
import { searchExecutionSummaries, executionHistoryResults, tokenizeHistory } from '../packages/bush-runtime/dist/executionHistorySearch.js';

const hash = text => createHash('sha256').update(text).digest('hex');
const args = process.argv.slice(2);
const worker = args[0] === '--worker';
if (worker) args.shift();

function fixture() {
  const entry = (id, summary, tool = 'terminal_exec') => ({ id: hash(id), summary, tool,
    sessionId: 'fixture', turnId: id, recordedAt: '2026-09-18T08:00:00.000Z', outcome: 'returned' });
  const entries = [
    entry('exact', 'path: C:\\render\\cut_v2_clean.mp4; purpose: 视频定稿'),
    entry('old', 'path: C:\\render\\cut_v1.mp4; purpose: 视频配音'),
    entry('weak', 'summary: 视频生成能力'),
    entry('ffmpeg', 'command: C:\\Tools\\ffmpeg-win-x86_64-v7.1.exe -i source.mp4'),
    entry('noise', 'command: echo hello'),
    entry('upload', 'path: reference-videos/clip.mp4; summary: uploaded to COS', 'upload_video'),
  ];
  const queries = [
    { keywords: ['cut_v2_clean', 'render', '配音'], description: '查找视频生成记录' },
    { keywords: ['ffmpeg', 'exe', 'filter_complex'], description: '查找可执行文件路径' },
    { keywords: ['cos', 'upload', 'reference-videos'], description: '查找视频上传工具' },
    { keywords: ['ＦＦＭＰＥＧ'], description: 'qzxv' },
    { keywords: ['unknown_file'], description: '视频生成能力' },
  ];
  return { tokenization: [...tokenizeHistory('CUT_v2_clean.mp4 头部遮罩 C:\\Tools\\FFMPEG.exe').frequencies],
    searches: queries.map(query => pages(searchExecutionSummaries(entries, query))) };
}

function pages(matches) {
  const result = [];
  let offset = 0;
  do {
    const page = executionHistoryResults(matches, offset);
    result.push(page);
    assert.ok(page.results.length <= 5);
    assert.ok(page.next_offset === null || page.next_offset > offset);
    offset = page.next_offset;
  } while (offset !== null);
  assert.equal(new Set(result.flatMap(page => page.results.map(item => item.record_id))).size, matches.length);
  return result;
}

async function historical(sessionId, turnId, suppliedRoot) {
  assert.match(sessionId ?? '', /^local-[a-f0-9-]+$/i);
  assert.match(turnId ?? '', /^turn_[a-f0-9-]+$/i);
  const root = suppliedRoot ?? join(process.env.APPDATA, 'cardbush', 'runtime-state');
  const journal = join(root, 'tool-executions', hash(sessionId) + '.jsonl');
  const session = join(root, 'sessions', hash(sessionId) + '.jsonl');
  for (const path of [journal, session]) assert.ok((await stat(path)).size <= 128 * 1024 * 1024, 'Offline replay input exceeds 128 MiB.');
  const [journalBytes, sessionBytes, indexBytes] = await Promise.all([
    readFile(journal), readFile(session), readFile(journal + '.history').catch(error => { if (error.code !== 'ENOENT') throw error; return null; }),
  ]);
  const records = journalBytes.toString('utf8').trim().split('\n').map(line => {
    const row = JSON.parse(line);
    assert.equal(row.checksum, hash(JSON.stringify(row.record)));
    if (Object.hasOwn(row, 'history')) assert.equal(row.historyChecksum, hash(JSON.stringify(row.history)));
    return row.record;
  });
  const events = sessionBytes.toString('utf8').trim().split('\n').map(line => {
    const row = JSON.parse(line);
    assert.equal(row.checksum, hash(JSON.stringify(row.event)));
    return row.event;
  });
  const turn = events.find(event => event.kind === 'turn_committed' && event.payload.turnId === turnId)?.payload;
  assert.ok(turn, 'Select a committed turn.');
  const searches = records.filter(record => record.turnId === turnId && record.toolCall.name === EXECUTION_HISTORY_TOOL);
  assert.ok(searches.length, 'The selected turn has no history queries.');
  const output = [];
  for (const record of searches) {
    assert.equal(record.result?.scope, 'session', 'This offline replay covers session-scoped recorded queries only.');
    const message = turn.messages.find(item => item.message.toolCalls?.some(call => call.id === record.toolCall.id));
    assert.ok(message, 'The recorded query must belong to the selected conversation turn.');
    const input = JSON.parse(record.toolCall.argumentsText);
    const entries = records.filter(item => Date.parse(item.recordedAt) < Date.parse(record.recordedAt)).map(summarizeExecution).filter(Boolean);
    const matches = searchExecutionSummaries(entries, input);
    const allPages = pages(matches);
    const result = { scope: 'session', ...executionHistoryResults(matches, input.offset ?? 0) };
    const original = record.result;
    output.push({ callId: record.toolCall.id, keywords: input.keywords, availableSummaries: entries.length,
      before: { matches: original.total_matches, returned: original.results.length, characters: JSON.stringify(original).length,
        recordIds: original.results.map(item => item.record_id), tools: original.results.map(item => item.tool) },
      after: { matches: result.total_matches, returned: result.results.length, characters: JSON.stringify(result).length,
        matchType: result.match_type, nextOffset: result.next_offset, recordIds: result.results.map(item => item.record_id),
        tools: result.results.map(item => item.tool), matchedKeywords: result.results.map(item => item.matched_keywords),
        fileNotes: result.results.filter(item => /purpose:.*points:/.test(item.summary)).length },
      allPagesDigest: hash(JSON.stringify(allPages)), pageCount: allPages.length });
  }
  // Validate real old-index migration only on a temporary copy. Source bytes and
  // the source index are never handed to a writer.
  const scratch = await mkdtemp(join(tmpdir(), 'cardbush-history-replay-'));
  let migrated;
  try {
    const copy = join(scratch, 'source.jsonl');
    await writeFile(copy, journalBytes);
    if (indexBytes) await writeFile(copy + '.history', indexBytes);
    const index = new ExecutionHistoryIndex();
    migrated = await index.read(copy, sessionId);
    assert.deepEqual(migrated.entries, records.map(summarizeExecution).filter(Boolean));
    assert.equal(migrated.omitted, 0);
    assert.equal(migrated.outdated ?? 0, 0);
    assert.deepEqual(await index.read(copy, sessionId), migrated);
    assert.deepEqual(await readFile(copy), journalBytes);
  } finally {
    assert.equal(dirname(resolve(scratch)), resolve(tmpdir()));
    assert.ok(scratch.includes('cardbush-history-replay-'));
    await rm(scratch, { recursive: true, force: true });
  }
  // Allow a live app to append unrelated records; the captured prefix must stay
  // unchanged. Neither a rewrite nor a truncation can pass this check.
  assert.equal(hash((await readFile(journal)).subarray(0, journalBytes.length)), hash(journalBytes));
  assert.equal(hash((await readFile(session)).subarray(0, sessionBytes.length)), hash(sessionBytes));
  return { sessionId, turnId, sourceDigest: hash(journalBytes), journalRecords: records.length,
    migratedSummaries: migrated.entries.length, searches: output };
}

const data = { fixtures: fixture(), ...(args.length ? { historical: await historical(...args) } : {}) };
if (worker) {
  process.stdout.write(JSON.stringify({ runtime: { node: process.versions.node, electron: process.versions.electron }, data }));
} else {
  const electron = createRequire(import.meta.url)('electron');
  const child = spawnSync(electron, [fileURLToPath(import.meta.url), '--worker', ...args], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(child.status, 0, child.error?.message ?? child.stderr);
  const other = JSON.parse(child.stdout);
  assert.deepEqual(other.data, data, 'Node and Electron must return identical ranking, summaries and all progressive pages.');
  console.log(JSON.stringify({ identical: true, node: process.versions.node, electron: other.runtime,
    fixtureQueries: data.fixtures.searches.length, ...(data.historical ? { historical: data.historical } : {}) }, null, 2));
}
