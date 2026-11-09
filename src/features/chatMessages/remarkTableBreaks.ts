import type { Root, RootContent, PhrasingContent } from 'mdast';

/** Allow the line break commonly used inside GFM cells without enabling raw HTML. */
export function remarkTableBreaks() {
  function visit(node: Root | RootContent | PhrasingContent, insideCell: boolean) {
    if (!('children' in node)) return;
    const cell = insideCell || node.type === 'tableCell';
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      if (cell && child.type === 'html' && /^<br\s*\/?>$/i.test(child.value)) {
        node.children[i] = { type: 'break' };
      } else visit(child, cell);
    }
  }
  return (tree: Root) => visit(tree, false);
}
