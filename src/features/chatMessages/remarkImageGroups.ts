type ImageNode = {
  type: string;
  value?: string;
  url?: string;
  identifier?: string;
  children?: ImageNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
};

/** Group adjacent image-only paragraphs without changing prose, links or code. */
export function remarkImageGroups({ eligible }: { eligible: (url: string) => boolean }) {
  return (tree: ImageNode) => {
    const definitions = new Map<string, string>();
    const identifier = (value = '') => value.trim().replace(/\s+/g, ' ').toLowerCase();
    const collect = (node: ImageNode) => {
      if (node.type === 'definition' && node.url && !definitions.has(identifier(node.identifier))) {
        definitions.set(identifier(node.identifier), node.url);
      }
      node.children?.forEach(collect);
    };
    collect(tree);
    const imageParagraph = (node: ImageNode) => node.type === 'paragraph' &&
      Boolean(node.children?.some(child => child.type === 'image' || child.type === 'imageReference')) &&
      node.children!.every(child => {
        if (child.type === 'text') return !child.value?.trim();
        if (child.type === 'break') return true;
        const url = child.type === 'image' ? child.url : child.type === 'imageReference'
          ? definitions.get(identifier(child.identifier)) : undefined;
        return Boolean(url && eligible(url));
      });
    const visit = (node: ImageNode) => {
      if (!node.children) return;
      const grouped: ImageNode[] = [];
      for (const child of node.children) {
        if (!imageParagraph(child)) {
          visit(child);
          grouped.push(child);
          continue;
        }
        const previous = grouped.at(-1);
        if (previous?.data?.hProperties?.['data-message-image-gallery']) {
          previous.children!.push(...child.children!);
        } else {
          child.data = { ...child.data, hName: 'div', hProperties: {
            ...child.data?.hProperties, 'data-message-image-gallery': true,
          } };
          grouped.push(child);
        }
      }
      // A lone image keeps its original inline renderer and document semantics.
      for (const child of grouped) {
        if (child.data?.hProperties?.['data-message-image-gallery'] &&
          child.children!.filter(item => item.type === 'image' || item.type === 'imageReference').length < 2) {
          delete child.data.hName;
          delete child.data.hProperties['data-message-image-gallery'];
        }
      }
      node.children = grouped;
    };
    visit(tree);
  };
}
