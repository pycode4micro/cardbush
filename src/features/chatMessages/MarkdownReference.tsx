import type { ReactNode } from 'react';
import { parseFileMemoReference, parseMcpAppReference, parseSourceMemoReference } from '@cardbush/bush-protocol';
import { parsePromptReference, type PromptReference } from '../../shared/promptReferences';
import type { AppLanguage } from '../../types';
import { PromptReferenceLink } from '../composer/PromptReferenceLink';
import { McpAppReferenceLink } from '../tools/McpAppReferenceLink';
import { FileMemoReference } from './FileMemoReference';
import { SourceMemoReference } from './SourceMemoReference';

type Reference = { kind: 'source' | 'file' | 'app'; value: string }
  | { kind: 'prompt'; value: PromptReference }
  | { kind: 'invalid' };

/** Reference identities are not byte locations, regardless of Markdown node type. */
export function parseMarkdownReference(value: string | undefined): Reference | null {
  if (!value) return null;
  if (parseSourceMemoReference(value)) return { kind: 'source', value };
  if (parseFileMemoReference(value)) return { kind: 'file', value };
  if (parseMcpAppReference(value)) return { kind: 'app', value };
  const prompt = parsePromptReference(value);
  if (prompt) return { kind: 'prompt', value: prompt };
  return /^cardbush-(?:source|memo|app|reference):/i.test(value) ? { kind: 'invalid' } : null;
}

export function UnavailableMarkdownReference({ children, language }: { children?: ReactNode; language: AppLanguage }) {
  return <span className="markdown-reference-unavailable">
    {children}{children ? ' · ' : ''}<small>{language === 'zh' ? '引用不可用' : 'Reference unavailable'}</small>
  </span>;
}

export function MarkdownReference({ reference, children, language, rich, inline = false }: {
  reference: Reference; children?: ReactNode; language: AppLanguage; rich: boolean; inline?: boolean;
}) {
  if (reference.kind === 'invalid') return <UnavailableMarkdownReference language={language}>{children}</UnavailableMarkdownReference>;
  if (reference.kind === 'prompt') return <PromptReferenceLink reference={reference.value} />;
  if (!rich) return <span>{children}</span>;
  switch (reference.kind) {
    case 'source': return <SourceMemoReference reference={reference.value} language={language} />;
    case 'file': return <FileMemoReference reference={reference.value} inline={inline} language={language}>{children}</FileMemoReference>;
    case 'app': return inline ? <span>{children}</span>
      : <McpAppReferenceLink reference={reference.value} language={language}>{children}</McpAppReferenceLink>;
  }
}
