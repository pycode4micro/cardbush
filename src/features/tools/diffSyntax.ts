import type { DiffLine } from './toolChangeReports';

import { codeLanguageForPath } from '../../shared/codeLanguages';

export function diffLanguageForPath(path: string) {
  return codeLanguageForPath(path)?.grammar ?? 'plain';
}

export function diffLinePrefix(line: DiffLine) {
  if (line.kind === 'addition') return '+';
  if (line.kind === 'deletion') return '-';
  return ' ';
}

export function diffLineSource(line: DiffLine) {
  if (line.kind === 'hunk') return line.text;
  return /^[+\- ]/.test(line.text) ? line.text.slice(1) : line.text;
}

export type DiffLineNumber = {
  oldLine: number | null;
  newLine: number | null;
};

const maxHighlightLineLength = 4096;
const diffBlockLineLimit = 24;
const diffBlockCharacterLimit = 12_000;

export type DiffBlock = { start: number; end: number; highlight: boolean };

export function shouldVirtualizeDiff(lines: DiffLine[]): boolean {
  if (lines.length > 300) return true;
  let characters = 0;
  for (const line of lines) {
    characters += line.text.length;
    if (line.text.length > maxHighlightLineLength || characters > 40_000) return true;
  }
  return false;
}

/** Keep each syntax pass bounded, including minified code on one line. */
export function diffBlocks(lines: DiffLine[]): DiffBlock[] {
  const blocks: DiffBlock[] = [];
  let start = 0;
  let characters = 0;
  const flush = (end: number) => {
    if (end > start) blocks.push({ start, end, highlight: true });
    start = end;
    characters = 0;
  };
  lines.forEach((line, index) => {
    const length = line.text.length + 1;
    if (line.text.length > maxHighlightLineLength) {
      flush(index);
      blocks.push({ start: index, end: index + 1, highlight: false });
      start = index + 1;
    } else {
      if (index - start >= diffBlockLineLimit || characters + length > diffBlockCharacterLimit) flush(index);
      characters += length;
    }
  });
  flush(lines.length);
  return blocks;
}

export function diffLineNumbers(lines: DiffLine[]): DiffLineNumber[] {
  let oldLine = 1;
  let newLine = 1;

  return lines.map((line) => {
    if (line.kind === 'hunk') {
      const range = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(line.text);
      if (range) {
        oldLine = Number.parseInt(range[1] ?? '1', 10);
        newLine = Number.parseInt(range[2] ?? '1', 10);
      }
      return { oldLine: null, newLine: null };
    }

    if (line.kind === 'addition') {
      const current = { oldLine: null, newLine };
      newLine += 1;
      return current;
    }

    if (line.kind === 'deletion') {
      const current = { oldLine, newLine: null };
      oldLine += 1;
      return current;
    }

    const current = { oldLine, newLine };
    oldLine += 1;
    newLine += 1;
    return current;
  });
}
