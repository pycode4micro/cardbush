import { useUiLanguage } from '../../i18n/react';
import { uiText } from '../../i18n';
import { useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { mapWikiLinks } from './markdownGraph';
import { decodeFragment, scrollMarkdownAnchor } from './markdownAnchors';
import { openMarkdownExternalLink } from './markdownLinkNavigation';
export { markdownOutline } from './markdownAnchors';

export function MarkdownDocument({ source, scope, onNavigate, language: selectedLanguage }: { source: string; scope: string; onNavigate: (id: string) => void; language?: string }) {
  const inheritedLanguage = useUiLanguage();
  const language = selectedLanguage ?? inheritedLanguage;
  const root = useRef<HTMLDivElement>(null), [missing, setMissing] = useState('');
  const heading = ({ node, children, ...props }: React.ComponentProps<'h1'> & { node?: { position?: { start: { line: number } } } }) =>
    ({ ...props, id: `${scope}-${node?.position?.start.line}`, children });
  return <div ref={root} className="markdown-document"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    h1: props => <h1 {...heading(props)}/>, h2: props => <h2 {...heading(props)}/>, h3: props => <h3 {...heading(props)}/>,
    h4: props => <h4 {...heading(props)}/>, h5: props => <h5 {...heading(props)}/>, h6: props => <h6 {...heading(props)}/>,
    a: ({ href, children }) => {
      if (href?.startsWith('#md-node=')) return <button type="button" className="md-wiki-link" onClick={() => onNavigate(decodeFragment(href.slice(9)))}>{children}</button>;
      if (href?.startsWith('#')) return <a href={href} onClick={event => {
        event.preventDefault();
        setMissing(scrollMarkdownAnchor(root.current, href) ? '' : href);
      }}>{children}</a>;
      return <a href={href} target="_blank" rel="noreferrer" onClick={event => {
        event.preventDefault();
        if (href) void openMarkdownExternalLink(href, event.currentTarget.textContent ?? '').then(opened => setMissing(opened ? '' : href)).catch(() => setMissing(href));
      }}>{children}</a>;
    },
  }}>{mapWikiLinks(source, (id, label) => `[${label.replaceAll('[', '\\[').replaceAll(']', '\\]')}](#md-node=${encodeURIComponent(id)})`)}</ReactMarkdown>
    {missing && <small role="status" className="md-link-notice">{uiText(language)('markdownDocument.linkTargetNotFound')}{missing}</small>}
  </div>;
}
