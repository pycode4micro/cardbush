import { readUserPrompt, type UserPromptInput } from '@cardbush/bush-protocol';
import type { MarkdownSelection } from './MarkdownSourceEditor';
import type { BushItPage } from './bushItPageStore';

/** Immutable model context: queueing and retries retain the selected file without exposing its backing path. */
export function creationRequest(input: UserPromptInput, page: BushItPage | undefined, selection: MarkdownSelection | undefined, language: 'zh' | 'en'): UserPromptInput {
  const prompt = readUserPrompt(input);
  const text = prompt.text;
  if (!page?.file || prompt.context?.some(item => item.kind === 'editing-location' || item.kind === 'preview-selection')) return input;
  const range = selection?.source === page.source ? `${selection.startLine}–${selection.endLine}` : '';
  const location = `${JSON.stringify(page.file.path)}${range ? ` · L${range}` : ''}`;
  return { text, context: [...prompt.context ?? [], { kind: 'editing-location', content: `${language === 'zh' ? '编辑位置' : 'Editing location'}: ${location}` }] };
}
