import ReactMarkdown from 'react-markdown';
import { useContext } from 'react';
import remarkGfm from 'remark-gfm';
import remarkCjkFriendly from 'remark-cjk-friendly';
import { remarkTableBreaks } from '../chatMessages/remarkTableBreaks';
import { openInspector } from '../inspector/inspectorEvents';
import { ConversationHostContext } from '../conversationHost';
import { uiText } from '../../i18n';
import type { AppLanguage } from '../../types';

export default function ComposerMarkdownPreview({ source, language }: { source: string; language: AppLanguage }) {
  const host = useContext(ConversationHostContext);
  return <div className="composer-markdown-preview markdown-content" role="region" aria-label={uiText(language)('inlineHtmlPreview.preview')} tabIndex={0}>
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkCjkFriendly, remarkTableBreaks]} skipHtml
      components={{
        table: ({ children }) => <div className="markdown-table-scroll"><table>{children}</table></div>,
        img: ({ alt }) => <span>{alt}</span>,
        a: ({ href, children }) => href && /^https?:\/\//i.test(href)
          ? <a href={href} onClick={event => {
            event.preventDefault();
            if (host?.openExternal) host.openExternal(href);
            else openInspector(href, event.currentTarget.textContent || href);
          }}>{children}</a>
          : <span>{children}</span>,
      }}>{source}</ReactMarkdown>
  </div>;
}
