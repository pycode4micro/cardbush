import { uiText } from '../../i18n';
import type { ReactNode } from 'react';
import { parseFileMemoReference, parseMcpAppReference, parseSourceMemoReference, parseBrowserTabReference, browserTabReferenceHref, type BrowserTabReference } from '@cardbush/bush-protocol';
import { BrowserTabReferenceLink } from '../browser/BrowserTabReferenceLink';
import { parsePromptReference, type PromptReference } from '../../shared/promptReferences';
import type { AppLanguage } from '../../types';
import { PromptReferenceLink } from '../composer/PromptReferenceLink';
import { McpAppReferenceLink } from '../tools/McpAppReferenceLink';
import { FileMemoReference } from './FileMemoReference';
import { SourceMemoReference } from './SourceMemoReference';

type Reference = { kind: 'source' | 'file' | 'app'; value: string }
  | { kind: 'browser-tab'; value: BrowserTabReference }
  | { kind: 'prompt'; value: PromptReference }
  | { kind: 'invalid' };

/** Reference identities are not byte locations, regardless of Markdown node type. */
export function parseMarkdownReference(value: string | undefined): Reference | null {
  if (!value) return null;
  const browser = parseBrowserTabReference(value);
  if (browser) return { kind: 'browser-tab', value: browser };
  if (parseSourceMemoReference(value)) return { kind: 'source', value };
  if (parseFileMemoReference(value)) return { kind: 'file', value };
  if (parseMcpAppReference(value)) return { kind: 'app', value };
  const prompt = parsePromptReference(value);
  if (prompt) return { kind: 'prompt', value: prompt };
  return /^cardbush-(?:source|memo|app|reference|browser):/i.test(value) ? { kind: 'invalid' } : null;
}

export function UnavailableMarkdownReference({ children, language }: { children?: ReactNode; language: AppLanguage }) {
  return <span className="markdown-reference-unavailable">
    {children}{children ? ' · ' : ''}<small>{uiText(language)('markdownReference.referenceUnavailable')}</small>
  </span>;
}

export function MarkdownReference({ reference, children, language, rich, inline = false }: {
  reference: Reference; children?: ReactNode; language: AppLanguage; rich: boolean; inline?: boolean;
}) {
  if (reference.kind === 'invalid') return <UnavailableMarkdownReference language={language}>{children}</UnavailableMarkdownReference>;
  if (reference.kind === 'prompt') return <PromptReferenceLink reference={reference.value} />;
  if (reference.kind === 'browser-tab') return <BrowserTabReferenceLink key={browserTabReferenceHref(reference.value)} reference={reference.value} language={language}/>;
  if (!rich) return <span>{children}</span>;
  switch (reference.kind) {
    case 'source': return <SourceMemoReference reference={reference.value} language={language} />;
    case 'file': return <FileMemoReference reference={reference.value} inline={inline} language={language}>{children}</FileMemoReference>;
    case 'app': return inline ? <span>{children}</span>
      : <McpAppReferenceLink reference={reference.value} language={language}>{children}</McpAppReferenceLink>;
  }
}
