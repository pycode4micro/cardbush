type MarkdownNode = {
  type: string;
  identifier?: string;
  children?: MarkdownNode[];
  data?: { hName: string; hProperties: Record<string, number> };
};

/** Render assistant footnotes beside the claim, keeping their Markdown content. */
export function remarkMarkdownSourceFootnotes() {
  return (tree: MarkdownNode) => {
    const definitions = new Map<string, MarkdownNode>();
    for (const node of tree.children ?? []) {
      if (node.type === 'footnoteDefinition' && node.identifier && !definitions.has(node.identifier)) {
        definitions.set(node.identifier, node);
      }
    }
    if (!definitions.size) return;

    const numbers = new Map<string, number>();
    const visit = (node: MarkdownNode) => {
      if (node.type === 'footnoteDefinition' || !node.children) return;
      node.children = node.children.map(child => {
        const identifier = child.type === 'footnoteReference' ? child.identifier : undefined;
        const definition = identifier ? definitions.get(identifier) : undefined;
        if (!identifier || !definition?.children?.length) { visit(child); return child; }
        const number = numbers.get(identifier) ?? numbers.size + 1;
        numbers.set(identifier, number);
        return { type: 'sourceFootnote', children: structuredClone(definition.children),
          data: { hName: 'span', hProperties: { 'data-source-footnote': number } } };
      });
    };
    visit(tree);
    tree.children = tree.children?.filter(node => node.type !== 'footnoteDefinition' || !node.identifier || !numbers.has(node.identifier));
  };
}
