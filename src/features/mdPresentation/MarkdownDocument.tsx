import { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { mapWikiLinks } from './markdownGraph';

function decodeFragment(value: string) { try { return decodeURIComponent(value); } catch { return value; } }

export function markdownOutline(source: string, scope: string) {
  const text = (node: { value?: string; children?: unknown[] }): string => node.value ?? (node.children ?? []).map(child => text(child as typeof node)).join('');
  return fromMarkdown(source).children.flatMap(node => node.type === 'heading'
    ? [{ id: `${scope}-${node.position?.start.line}`, label: text(node), depth: node.depth }] : []);
}

export function MarkdownDocument({ source, scope, onNavigate }: { source: string; scope: string; onNavigate: (id: string) => void }) {
  const headings = useMemo(() => markdownOutline(source, scope), [source, scope]);
  const heading = ({ node, children, ...props }: React.ComponentProps<'h1'> & { node?: { position?: { start: { line: number } } } }) =>
    ({ ...props, id: `${scope}-${node?.position?.start.line}`, children });
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    h1: props => <h1 {...heading(props)}/>, h2: props => <h2 {...heading(props)}/>, h3: props => <h3 {...heading(props)}/>,
    h4: props => <h4 {...heading(props)}/>, h5: props => <h5 {...heading(props)}/>, h6: props => <h6 {...heading(props)}/>,
    a: ({ href, children }) => {
      if (href?.startsWith('#md-node=')) return <button type="button" className="md-wiki-link" onClick={() => onNavigate(decodeFragment(href.slice(9)))}>{children}</button>;
      if (href?.startsWith('#')) return <a href={href} onClick={event => {
        const target = headings.find(item => item.label.toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replaceAll(' ', '-') === decodeFragment(href.slice(1)));
        if (target) { event.preventDefault(); window.document.getElementById(target.id)?.scrollIntoView({ block: 'start' }); }
      }}>{children}</a>;
      return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
    },
  }}>{mapWikiLinks(source, (id, label) => `[${label.replaceAll('[', '\\[').replaceAll(']', '\\]')}](#md-node=${encodeURIComponent(id)})`)}</ReactMarkdown>;
}
