import Link from '@tiptap/extension-link';
import type { Editor, JSONContent } from '@tiptap/core';
import { Plugin, type EditorState, type Transaction } from '@tiptap/pm/state';
import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Nodes, Root } from 'mdast';

type Reference = { label: string; text: string; currentText?: string; kind: 'full' | 'collapsed' | 'shortcut'; href: string; title: string | null };
type LinkStorage = { references: Map<string, Reference>; declarations: string };
const linkStorage = (editor: Editor) => (editor.storage as unknown as { link: LinkStorage }).link;

/** Reference links stay clickable without rewriting [text][id] during unrelated edits. */
export function pageLink(refreshDefinitions: (editor: Editor, source: string, state: EditorState) => Transaction | undefined) {
  const references = new Map<string, Reference>();
  return Link.extend({
    addStorage() { return { ...this.parent?.(), references, declarations: '' }; },
    addAttributes() { return { ...this.parent?.(), markdownReference: { default: null, rendered: false } }; },
    addProseMirrorPlugins() {
      const editor = this.editor;
      return [...this.parent?.() ?? [], new Plugin({
        appendTransaction(transactions, _oldState, state) {
          if (!transactions.some(transaction => transaction.docChanged && !transaction.getMeta('preventUpdate'))) return;
          if (!linkStorage(editor).declarations && !state.doc.textContent.includes(']:')) return;
          const source = pageMarkdownSource(editor, state.doc.toJSON());
          // Append to the same history event: changing a definition and all its
          // references must undo together, without a second document rewrite.
          if (pageLinkDefinitionsChanged(editor, source)) return refreshDefinitions(editor, source, state);
        },
      })];
    },
    parseMarkdown(token, helpers) {
      return helpers.applyMark('link', helpers.parseInline(token.tokens || []), {
        href: token.href, title: token.title || null, markdownReference: references.get(token.raw ?? '') ?? null,
      });
    },
    renderMarkdown(node, helpers, context) {
      const href = node.attrs?.href ?? '', title = node.attrs?.title ?? '', text = helpers.renderChildren(node);
      const reference = node.attrs?.markdownReference as Reference | null;
      if (reference && reference.href === href && (reference.title ?? '') === title) {
        // Tiptap asks mark renderers for delimiters using placeholder children.
        const label = reference.currentText ?? context.meta?.markText ?? text;
        const suffix = reference.kind === 'full' || reference.text !== label ? `[${reference.label}]` : reference.kind === 'collapsed' ? '[]' : '';
        return `[${text}]${suffix}`;
      }
      return title ? `[${text}](${href} "${title}")` : `[${text}](${href})`;
    },
  }).configure({ openOnClick: false, HTMLAttributes: { tabindex: '0' } });
}

export function preparePageLinkReferences(editor: Editor, source: string, tree: Root) {
  const storage = linkStorage(editor), references = storage.references;
  references.clear();
  const definitions = new Map<string, { url: string; title: string | null }>(), declarations: string[] = [];
  const visit = (node: Nodes, callback: (node: Nodes) => void) => { callback(node); if ('children' in node) node.children.forEach(child => visit(child, callback)); };
  visit(tree, node => {
    if (node.type !== 'definition' || definitions.has(node.identifier.toLowerCase())) return;
    definitions.set(node.identifier.toLowerCase(), { url: node.url, title: node.title ?? null });
    declarations.push(source.slice(node.position?.start.offset, node.position?.end.offset));
  });
  visit(tree, node => {
    if (node.type !== 'linkReference') return;
    const definition = definitions.get(node.identifier.toLowerCase()); if (!definition) return;
    references.set(source.slice(node.position?.start.offset, node.position?.end.offset), {
      label: node.label ?? node.identifier, kind: node.referenceType, href: definition.url, title: definition.title,
      text: source.slice(node.children[0]?.position?.start.offset, node.children.at(-1)?.position?.end.offset),
    });
  });
  storage.declarations = declarations.join('\n');
  return storage.declarations;
}

/** Render the real label before Tiptap replaces mark children with a placeholder. */
export function pageMarkdownSource(editor: Editor, content = editor.getJSON()) {
  const markdown = editor.markdown!;
  const visit = (node: JSONContent) => {
    const children = node.content ?? [];
    children.forEach(visit);
    for (let start = 0; start < children.length;) {
      const link = children[start].marks?.find(mark => mark.type === 'link');
      if (!link?.attrs?.markdownReference) { start++; continue; }
      let end = start + 1;
      const signature = JSON.stringify(link);
      while (end < children.length && JSON.stringify(children[end].marks?.find(mark => mark.type === 'link')) === signature) end++;
      const label = children.slice(start, end).map(child => ({ ...child, marks: child.marks?.filter(mark => mark.type !== 'link') }));
      const currentText = markdown.serialize({ type: 'doc', content: [{ type: 'paragraph', content: label }] });
      for (let index = start; index < end; index++) children[index].marks = children[index].marks?.map(mark => mark.type === 'link'
        ? { ...mark, attrs: { ...mark.attrs, markdownReference: { ...mark.attrs?.markdownReference, currentText } } } : mark);
      start = end;
    }
  };
  visit(content);
  return markdown.serialize(content);
}

/** A definition edit updates every reference immediately, including undo/redo. */
function pageLinkDefinitionsChanged(editor: Editor, source: string) {
  const previous = linkStorage(editor).declarations;
  if (!previous && !source.includes(']:')) return false;
  const definitions: string[] = [], seen = new Set<string>();
  const visit = (node: Nodes) => {
    if (node.type === 'definition' && !seen.has(node.identifier.toLowerCase())) {
      seen.add(node.identifier.toLowerCase());
      definitions.push(source.slice(node.position?.start.offset, node.position?.end.offset));
    }
    if ('children' in node) node.children.forEach(visit);
  };
  visit(fromMarkdown(source));
  return definitions.join('\n') !== previous;
}
