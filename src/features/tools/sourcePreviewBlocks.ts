export type SourcePreviewRow = { text: string; line: number; continuation: boolean };
export type SourcePreviewBlock = { rows: SourcePreviewRow[]; highlight: boolean };

export function shouldVirtualizeSource(content: string): boolean {
  if (content.length > 40_000) return true;
  let lines = 1, lineLength = 0;
  for (const character of content) {
    if (character === '\n') {
      if (++lines > 300) return true;
      lineLength = 0;
    } else if (++lineLength > 4096) return true;
  }
  return false;
}

/** Bound both tokenization and wrapping, including minified single-line files. */
export function sourcePreviewBlocks(content: string): SourcePreviewBlock[] {
  const blocks: SourcePreviewBlock[] = [];
  let rows: SourcePreviewRow[] = [];
  let characters = 0;
  const flush = () => {
    if (rows.length) blocks.push({ rows, highlight: true });
    rows = [];
    characters = 0;
  };
  for (const [index, text] of content.replace(/\r\n?/g, '\n').split('\n').entries()) {
    if (text.length > 4096) {
      flush();
      for (let offset = 0; offset < text.length;) {
        let end = Math.min(text.length, offset + 4096);
        const last = text.charCodeAt(end - 1);
        if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
        blocks.push({ highlight: false, rows: [{ text: text.slice(offset, end), line: index + 1, continuation: offset > 0 }] });
        offset = end;
      }
    } else {
      if (rows.length >= 40 || characters + text.length > 12_000) flush();
      rows.push({ text, line: index + 1, continuation: false });
      characters += text.length + 1;
    }
  }
  flush();
  return blocks;
}
