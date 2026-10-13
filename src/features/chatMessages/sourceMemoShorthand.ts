type MarkdownNode = { type: string; value?: string; url?: string; children?: MarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } }; data?: { originalLiteral?: string } };

function* sourceMemoMarkers(content: string) {
  // Check prose boundaries around the whole run, then resolve each source.
  // This keeps adjacent citations valid without matching arrays or nested brackets.
  const groups = /(?<![\\!A-Za-z0-9_\[\]])(?:\[[1-9]\d{0,8}\])+(?![A-Za-z0-9_\[\](])/g;
  for (const group of content.matchAll(groups)) {
    for (const marker of group[0].matchAll(/\[([1-9]\d{0,8})\]/g)) {
      yield { number: Number(marker[1]), label: marker[0], index: group.index! + marker.index! };
    }
  }
}
export function sourceMemoCandidates(content: string): number[] {
  const numbers = new Set<number>();
  for (const marker of sourceMemoMarkers(content)) {
    numbers.add(marker.number);
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
        for (const marker of sourceMemoMarkers(value)) {
          const reference = references.get(marker.number);
          if (!reference) continue;
          const index = marker.index;
          if (index > cursor) pieces.push({ type: 'text', value: value.slice(cursor, index) });
          pieces.push({ type: 'link', url: reference, children: [{ type: 'text', value: marker.label }] });
          cursor = index + marker.label.length;
        }
        if (!cursor) return [child];
        if (cursor < value.length) pieces.push({ type: 'text', value: value.slice(cursor) });
        return pieces;
      });
    };
    visit(tree);
  };
}
