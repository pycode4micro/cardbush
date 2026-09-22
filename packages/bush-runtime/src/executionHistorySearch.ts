import { Bm25Retriever, type TermStats } from './bm25Retrieval.js';
import type { ExecutionHistoryEntry } from './executionHistory.js';

export const normalizeHistoryText = (text: string) => text.normalize('NFKC').toLowerCase().replace(/\\/g, '/');
const eastAsian = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;

/** Explicit identifier boundaries and adjacent CJK pairs are identical in Node
 * and Electron; Intl word dictionaries split filenames differently between hosts. */
export function tokenizeHistory(text: string): TermStats {
  const frequencies = new Map<string, number>();
  let length = 0;
  const add = (term: string) => {
    if ([...term].length < 2) return;
    frequencies.set(term, (frequencies.get(term) ?? 0) + 1); length++;
  };
  const identifiers = normalizeHistoryText(text).replace(eastAsian, phrase => {
    const chars = [...phrase];
    for (let i = 1; i < chars.length; i++) add(chars[i - 1] + chars[i]);
    return ' ';
  });
  for (const match of identifiers.matchAll(/[\p{L}\p{N}]+(?:[_-][\p{L}\p{N}]+)*/gu)) {
    add(match[0]);
    const parts = match[0].split(/[_-]/);
    if (parts.length > 1) parts.forEach(add);
  }
  return { frequencies, length };
}

function keywordMatcher(keyword: string) {
  const normalized = normalizeHistoryText(keyword);
  // Chinese clues remain substring matches. Identifier clues may span path
  // separators, but "exe" must not match the "exec" in every terminal tool.
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(normalized)) {
    return (text: string) => text.includes(normalized);
  }
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'u');
  return (text: string) => pattern.test(text);
}

function localDate(timestamp: string) {
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` : '';
}

export function searchExecutionSummaries(entries: ExecutionHistoryEntry[], input: { keywords: string[]; description: string }) {
  const keywords = [...new Map(input.keywords.map(word => [normalizeHistoryText(word), word])).values()];
  const tests = keywords.map(keywordMatcher);
  // Only lexical structure matters here: paths, filenames, compound Tool names
  // and dated IDs are more specific than isolated words. No task-specific lists.
  const identifiers = new Set(keywords.filter(word => /[\p{L}\p{N}][._/-][\p{L}\p{N}]/u.test(normalizeHistoryText(word))));
  const documents = entries.map(entry => ({ entry, texts: [entry.summary, entry.tool, entry.recordedAt, localDate(entry.recordedAt), entry.outcome] }));
  const scores = new Map(new Bm25Retriever(tokenizeHistory).search(documents, [...keywords, input.description])
    .map(match => [(match.record.entry as ExecutionHistoryEntry).id, match.score]));
  const candidates = documents.map(({ entry, texts }) => {
    const text = normalizeHistoryText(texts.join(' '));
    const matched = keywords.filter((_, index) => tests[index](text));
    return { entry, matched, tier: matched.some(word => identifiers.has(word)) ? 2 : matched.length ? 1 : 0,
      score: scores.get(entry.id) ?? 0 };
  });
  return candidates.filter(candidate => candidate.matched.length > 0 || candidate.score > 0)
    .sort((left, right) => right.tier - left.tier || right.matched.length - left.matched.length || right.score - left.score ||
      Date.parse(right.entry.recordedAt) - Date.parse(left.entry.recordedAt) ||
      (left.entry.id < right.entry.id ? -1 : left.entry.id > right.entry.id ? 1 : 0));
}

/** A page never pads identifier/keyword matches with a less specific tier.
 * All other receipts remain available through the same contiguous next_offset. */
export function executionHistoryResults(matches: ReturnType<typeof searchExecutionSummaries>, offset: number) {
  const page = matches.slice(offset, offset + 5).filter(match => match.tier === matches[offset]?.tier);
  return { total_matches: matches.length,
    match_type: page.length ? (page[0].tier === 2 ? 'identifier' : page[0].tier === 1 ? 'keywords' : 'related') : 'none',
    results: page.map(({ entry, matched }) => ({ record_id: entry.id, recorded_at: entry.recordedAt,
      tool: entry.tool, outcome: entry.outcome, summary: entry.summary, matched_keywords: matched })),
    next_offset: offset + page.length < matches.length ? offset + page.length : null };
}
