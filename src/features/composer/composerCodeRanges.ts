import { fromMarkdown } from 'mdast-util-from-markdown';

export type ComposerCodeRange = { start: number; end: number };
type MarkdownNode = { type: string; children?: MarkdownNode[]; position?: { start: { offset?: number }; end: { offset?: number } } };

/** Presentation offsets only. Never normalize the source used for editing or sending. */
export function composerCodeRanges(source: string): ComposerCodeRange[] {
  // Large pasted documents remain editable without a full parse on every keypress.
  if (!source.includes('`') || source.length > 32_000) return [];
  const ranges: ComposerCodeRange[] = [];
  const visit = (node: MarkdownNode) => {
    if (node.type === 'inlineCode') {
      const start = node.position?.start.offset, end = node.position?.end.offset;
      if (start === undefined || end === undefined) return;
      const delimiter = /^`+/.exec(source.slice(start, end))?.[0].length ?? 0;
      if (delimiter && end - start > delimiter * 2) ranges.push({ start: start + delimiter, end: end - delimiter });
    } else node.children?.forEach(visit);
  };
  try { visit(fromMarkdown(source)); } catch { return []; }
  return ranges;
}
