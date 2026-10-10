type MarkdownNode = {
  type: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number } };
};

/** Commit streamed table rows at a line boundary. A half-written path/link
 * otherwise alternates between ordinary text, an autolink and inline code,
 * changing the entire table's column widths and starting partial-path IPCs. */
export function remarkStreamingTables() {
  return (tree: MarkdownNode, file: { value: unknown }) => {
    const content = String(file.value);
    if (/[\r\n]$/.test(content)) return;
    const lineStart = content.lastIndexOf('\n') + 1;
    const visit = (node: MarkdownNode) => {
      if (node.type === 'table' && (node.children?.length ?? 0) > 1) {
        const lastRow = node.children!.at(-1)!;
        const start = lastRow.position?.start.offset;
        if (start !== undefined && start >= lineStart) {
          node.children!.pop();
          // Later prose-boundary plugins may reparse the file. They must see
          // the same committed rows, rather than bringing the unfinished one back.
          file.value = content.slice(0, lineStart);
        }
      } else node.children?.forEach(visit);
    };
    visit(tree);
  };
}
