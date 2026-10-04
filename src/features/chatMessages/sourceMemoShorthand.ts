type MarkdownNode = { type: string; value?: string; url?: string; children?: MarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } }; data?: { originalLiteral?: string } };

const markerPattern = () => /(?<![\\!A-Za-z0-9_\[\]])\[([1-9]\d{0,8})\](?![A-Za-z0-9_\[\](])/g;
export function sourceMemoCandidates(content: string): number[] {
  const numbers = new Set<number>();
  for (const match of content.matchAll(markerPattern())) {
    numbers.add(Number(match[1]));
    if (numbers.size === 32) break;
  }
  return [...numbers].sort((a, b) => a - b);
}

/** Enrich prose from host-confirmed identities, without changing stored Markdown.
 * Code, explicit links, images and escaped text retain their original meaning. */
export function remarkSourceMemoShorthand({ references }: { references: ReadonlyMap<number, string> }) {
  return (tree: MarkdownNode, file: { value: unknown }) => {
    if (!references.size) return;
    const source = String(file.value);
    const visit = (node: MarkdownNode) => {
      if (!node.children || ['link', 'linkReference', 'image', 'imageReference', 'code', 'inlineCode'].includes(node.type)) return;
      node.children = node.children.flatMap(child => {
        if (child.type !== 'text') { visit(child); return [child]; }
        const value = child.value ?? '', start = child.position?.start.offset, end = child.position?.end.offset;
        // A decoded escape/entity is not a request to create a reference.
        const literal = child.data?.originalLiteral ?? (start !== undefined && end !== undefined ? source.slice(start, end) : undefined);
        if (literal !== undefined && literal !== value) return [child];
        const pieces: MarkdownNode[] = []; let cursor = 0;
        for (const match of value.matchAll(markerPattern())) {
          const number = Number(match[1]), reference = references.get(number);
          if (!reference) continue;
          const index = match.index!;
          if (index > cursor) pieces.push({ type: 'text', value: value.slice(cursor, index) });
          pieces.push({ type: 'link', url: reference, children: [{ type: 'text', value: match[0] }] });
          cursor = index + match[0].length;
        }
        if (!cursor) return [child];
        if (cursor < value.length) pieces.push({ type: 'text', value: value.slice(cursor) });
        return pieces;
      });
    };
    visit(tree);
  };
}
