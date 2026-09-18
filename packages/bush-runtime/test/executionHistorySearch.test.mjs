import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { searchExecutionSummaries, executionHistoryResults, tokenizeHistory } from '../dist/executionHistorySearch.js';

const entry = (id, summary, extra = {}) => ({
  id: createHash('sha256').update(id).digest('hex'), sessionId: 'one', turnId: id,
  recordedAt: '2026-09-18T08:00:00.000Z', tool: 'terminal_exec', outcome: 'returned', summary, ...extra,
});
const search = (entries, keywords, description = '查找执行记录') => searchExecutionSummaries(entries, { keywords, description });

test('a requested filename outranks a rare generic clue; pages never pad with weaker matches', () => {
  const target = entry('target', 'path: C:/render/cut_v2_clean.mp4; purpose: 视频定稿');
  const failed = entry('failed', 'command: check C:/render/cut_v2_clean.mp4; exitCode: 1', { outcome: 'failed' });
  const old = entry('old', 'path: C:/render/cut_v1.mp4; purpose: 视频配音');
  const weak = Array.from({ length: 8 }, (_, i) => entry(`weak-${i}`, 'summary: 视频生成能力'));
  const entries = [old, ...weak, failed, target];
  const keywords = ['cut_v2_clean', 'render', '配音'];
  const ranked = search(entries, keywords, '查找视频生成与核验记录');
  const first = executionHistoryResults(ranked, 0);
  assert.equal(first.match_type, 'identifier');
  assert.deepEqual(new Set(first.results.map(item => item.record_id)), new Set([target.id, failed.id]));
  assert.equal(first.next_offset, 2);
  const second = executionHistoryResults(ranked, first.next_offset);
  assert.equal(second.match_type, 'keywords');
  assert.deepEqual(second.results.map(item => item.record_id), [old.id]);
  const third = executionHistoryResults(ranked, second.next_offset);
  assert.equal(third.match_type, 'related');
  assert.equal(third.results.length, 5);
  const fourth = executionHistoryResults(ranked, third.next_offset);
  assert.equal(fourth.results.length, 3);
  assert.equal(fourth.next_offset, null);
  assert.equal(new Set([first, second, third, fourth].flatMap(page => page.results.map(item => item.record_id))).size, entries.length);
  assert.deepEqual(search([...entries].reverse(), [...keywords].reverse(), '查找视频生成与核验记录').map(item => item.entry.id),
    ranked.map(item => item.entry.id), 'input order and keyword order do not establish priority');
  assert.equal(first.results.find(item => item.record_id === failed.id).outcome, 'failed');
});

test('identifier boundaries, case, Unicode and slash normalization prevent exe/exec false positives', () => {
  const path = entry('path', 'command: C:\\Tools\\ffmpeg-win-v7.1.exe render\\cut_v2_clean.mp4');
  const unrelated = entry('exec', 'command: echo hello');
  assert.deepEqual(search([unrelated, path], ['exe']).map(item => item.entry.id), [path.id]);
  for (const keyword of ['FFMPEG', 'ＦＦＭＰＥＧ', 'C:/Tools/ffmpeg-win-v7.1.exe', 'cut_v2_clean.mp4', 'cut_v2_clean']) {
    assert.deepEqual(search([unrelated, path], [keyword])[0].matched, [keyword]);
  }
  const longer = entry('longer', 'path: cut_v2_cleaner.mp4');
  assert.equal(search([longer], ['cut_v2_clean'])[0]?.matched.length ?? 0, 0);
  const literal = entry('literal', 'command: run [clip]+.exe');
  assert.deepEqual(search([literal], ['[clip]+.exe'])[0].matched, ['[clip]+.exe']);
  const stats = tokenizeHistory('CUT_v2_clean.mp4');
  assert.ok(stats.frequencies.has('cut_v2_clean'));
  assert.ok(stats.frequencies.has('mp4'));
  assert.ok(stats.frequencies.has('clean'));
});

test('missing exact clues fall back progressively and do not turn a lookup into an AND filter', () => {
  const entries = [entry('keyword', 'path: render/output.mp4'), entry('related', 'summary: 头部遮罩覆盖')];
  const page = executionHistoryResults(search(entries, ['missing_file', 'render'], '头部遮罩抽查'), 0);
  assert.equal(page.match_type, 'keywords');
  assert.equal(page.results.length, 1);
  assert.equal(page.next_offset, 1);
  assert.equal(executionHistoryResults(search(entries, ['missing_file'], '头部遮罩抽查'), 0).match_type, 'related');
  assert.equal(executionHistoryResults(search(entries, ['qzxv'], 'qzxv'), 0).match_type, 'none');
  assert.equal(executionHistoryResults(search(entries, ['render']), 99).next_offset, null);
  assert.deepEqual(search(entries, ['render', 'RENDER', 'ｒｅｎｄｅｒ']).map(item => item.entry.id),
    search(entries, ['render']).map(item => item.entry.id));
  assert.deepEqual(search([entry('boundary', 'summary: 连接，文件')], ['接文'], '接文'), []);
});

test('timestamps and Tool names remain searchable facts, independent of successful outcomes', () => {
  const cancelled = entry('cancelled', 'message: upload interrupted', { outcome: 'cancelled', tool: 'upload_video' });
  const page = executionHistoryResults(search([cancelled], ['2026-09-18', 'upload_video']), 0);
  assert.equal(page.match_type, 'identifier');
  assert.deepEqual(page.results[0].matched_keywords, ['2026-09-18', 'upload_video']);
  assert.equal(page.results[0].outcome, 'cancelled');
});
