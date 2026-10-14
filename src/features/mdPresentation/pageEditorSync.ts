import { createDocument, type Editor } from '@tiptap/core';
import { pageMarkdownContent } from './pageEditorExtensions';

/** Keep unchanged DOM, scroll, selection and undo history stable across streamed chunks. */
export function syncPageEditor(editor: Editor, source: string) {
  const next = createDocument(pageMarkdownContent(editor, source), editor.schema);
  const before = editor.state.doc, start = before.content.findDiffStart(next.content);
  if (start === null) return;
  const end = before.content.findDiffEnd(next.content)!;
  const overlap = start - Math.min(end.a, end.b);
  const a = end.a + Math.max(0, overlap), b = end.b + Math.max(0, overlap);
  const transaction = editor.state.tr.replace(start, a, next.slice(start, b)).setMeta('preventUpdate', true).setMeta('addToHistory', false);
  editor.view.dispatch(transaction);
  return transaction.mapping;
}

export function pageEditorCaret(editor: Editor, source: string, cursor: number) {
  const prefix = createDocument(pageMarkdownContent(editor, source.slice(0, cursor)), editor.schema);
  let position = Math.max(0, Math.min(editor.state.doc.content.findDiffStart(prefix.content) ?? Infinity, prefix.content.size - 1, editor.state.doc.content.size));
  // A parsed prefix closes its paragraph/list. Keep the caret inside the last
  // textblock, rather than at the beginning of the following unchanged block.
  while (position > 0 && !editor.state.doc.resolve(position).parent.inlineContent) position--;
  return editor.view.coordsAtPos(position);
}
