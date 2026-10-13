import type { MarkdownSelection } from './MarkdownSourceEditor';
import type { BushItPage } from './bushItPageStore';

/** Small, visible, immutable reference: queueing and retries retain the selected file. */
export function creationRequest(text: string, page: BushItPage | undefined, selection: MarkdownSelection | undefined, language: 'zh' | 'en') {
  if (!page?.file) return text;
  const range = selection?.source === page.source ? `${selection.startLine}–${selection.endLine}` : '';
  const location = `${JSON.stringify(page.file.path)}${range ? ` · L${range}` : ''}`;
  return `${text}\n\n${language === 'zh' ? '编辑位置' : 'Editing location'}: ${location}`;
}
