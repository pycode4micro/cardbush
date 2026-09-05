import { Highlight } from 'prism-react-renderer';

import { cardbushSyntaxTheme } from './DiffSyntaxLines';
import { diffLanguageForPath } from './diffSyntax';
import { shouldUsePlainTextPreview } from '../../shared/textPreview';

export default function SourceSyntaxLines({
  content,
  path,
  language = 'en',
}: {
  content: string;
  path: string;
  language?: 'zh' | 'en';
}) {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (shouldUsePlainTextPreview(normalized)) {
    return (
      <div className="source-plain-preview" data-render-mode="plain">
        <div className="inspector-preview-notice source">
          {language === 'zh'
            ? '文本较大或行过长，已使用纯文本预览以避免界面卡顿。'
            : 'Large text or long lines · using plain text to keep the preview responsive.'}
        </div>
        <pre className="source-plain-text">{normalized}</pre>
      </div>
    );
  }
  const lines = normalized.split('\n');

  return (
    <Highlight
      code={normalized}
      language={diffLanguageForPath(path)}
      theme={cardbushSyntaxTheme}
    >
      {({ tokens, getTokenProps }) => (
        <div className="source-code-lines syntax-highlighted">
          {lines.map((line, lineIndex) => (
            <div
              className="source-code-line"
              // Source lines are position-addressed and can contain duplicates.
              // eslint-disable-next-line react/no-array-index-key
              key={lineIndex}
            >
              <span className="source-line-number" aria-label={`Line ${lineIndex + 1}`}>
                {lineIndex + 1}
              </span>
              <code>
                {line
                  ? tokens[lineIndex]?.length ? tokens[lineIndex].map((token, tokenIndex) => (
                      <span
                        {...getTokenProps({ token })}
                        // Prism tokens have no stable identity within a line.
                        // eslint-disable-next-line react/no-array-index-key
                        key={tokenIndex}
                      />
                    )) : line
                  : ' '}
              </code>
            </div>
          ))}
        </div>
      )}
    </Highlight>
  );
}
