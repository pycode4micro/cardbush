import { Highlight } from 'prism-react-renderer';
import { memo, useCallback, useMemo } from 'react';

import { cardbushSyntaxTheme } from './DiffSyntaxLines';
import { diffLanguageForPath } from './diffSyntax';
import { VirtualSourceLines, SourcePreviewRows } from './VirtualSourceLines';
import { shouldVirtualizeSource, type SourcePreviewBlock } from './sourcePreviewBlocks';

export default memo(function SourceSyntaxLines({
  content,
  path,
  language = 'en',
}: {
  content: string;
  path: string;
  language?: 'zh' | 'en';
}) {
  const normalized = useMemo(() => content.replace(/\r\n?/g, '\n'), [content]);
  const renderBlock = useCallback((block: SourcePreviewBlock) => <HighlightedBlock block={block} path={path} />, [path]);
  if (shouldVirtualizeSource(normalized)) {
    return <VirtualSourceLines content={normalized} renderBlock={renderBlock} language={language} />;
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
});

const HighlightedBlock = memo(function HighlightedBlock({ block, path }: { block: SourcePreviewBlock; path: string }) {
  if (!block.highlight) return <SourcePreviewRows block={block} />;
  return <Highlight code={block.rows.map(row => row.text).join('\n')} language={diffLanguageForPath(path)} theme={cardbushSyntaxTheme}>
    {({ tokens, getTokenProps }) => <SourcePreviewRows block={block} renderLine={index => tokens[index]?.map((token, tokenIndex) =>
      <span {...getTokenProps({ token })} key={tokenIndex} />)} />}
  </Highlight>;
});
