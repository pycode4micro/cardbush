import { Highlight } from 'prism-react-renderer';

import { cardbushSyntaxTheme } from './DiffSyntaxLines';
import { diffLanguageForPath } from './diffSyntax';

export default function SourceSyntaxLines({
  content,
  path,
}: {
  content: string;
  path: string;
}) {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
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
                  ? (tokens[lineIndex] ?? []).map((token, tokenIndex) => (
                      <span
                        {...getTokenProps({ token })}
                        // Prism tokens have no stable identity within a line.
                        // eslint-disable-next-line react/no-array-index-key
                        key={tokenIndex}
                      />
                    ))
                  : ' '}
              </code>
            </div>
          ))}
        </div>
      )}
    </Highlight>
  );
}
