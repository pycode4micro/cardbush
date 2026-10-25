import { terminalWidth } from '../../dist-electron/agentChatPresentation.mjs';

// Interpret the shared terminal screen, including overwritten transient rows.
// Counting raw stdout/stderr text cannot distinguish repainting from duplication.
export function terminalScreen(raw, columns) {
  raw = raw.replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
  const lines = [[]]; let row = 0, column = 0;
  for (const part of raw.matchAll(/\x1b\[([0-?]*)([ -/]*[@-~])|([^\x1b]+)/g)) {
    if (part[3] !== undefined) {
      for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(part[3])) {
        if (segment === '\r\n' || segment === '\n') { row++; column = 0; continue; }
        if (segment === '\r') { column = 0; continue; }
        const width = terminalWidth(segment); if (!width) continue;
        if (column + width > columns) { row++; column = 0; }
        const line = lines[row] ??= []; line[column] = segment;
        for (let i = 1; i < width; i++) line[column + i] = '';
        column += width;
      }
      continue;
    }
    const amount = Number(part[1]) || 1;
    if (part[2] === 'A') row = Math.max(0, row - amount);
    if (part[2] === 'B') row += amount;
    if (part[2] === 'G') column = amount - 1;
    if (part[2] === 'C') column += amount;
    if (part[2] === 'D') column = Math.max(0, column - amount);
    if (part[2] === 'J' && (!part[1] || part[1] === '0')) { lines.length = row + 1; (lines[row] ??= []).length = column; }
    if (part[2] === 'K') { if (part[1] === '2') lines[row] = []; else (lines[row] ??= []).length = column; }
  }
  return { text: lines.map(line => line?.join('') ?? '').join('\n'), row, column };
}
