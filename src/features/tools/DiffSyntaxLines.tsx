import { Highlight } from 'prism-react-renderer';
import { uiText } from '../../i18n';
import { useUiLanguage } from '../../i18n/react';
import { memo } from 'react';
import { Prism } from '../../shared/syntaxPrism';
import { cardbushSyntaxTheme } from '../../shared/syntaxTheme';
import { ReviewDiffLine } from '../sidebar/ReviewComments';

import type { DiffLine } from './toolChangeReports';
import {
  diffLanguageForPath,
  diffLineNumbers,
  diffLinePrefix,
  diffLineSource,
} from './diffSyntax';

export default memo(function DiffSyntaxLines({
  lines,
  path,
}: {
  lines: DiffLine[];
  path: string;
}) {
  const language = useUiLanguage();
  const sources = lines.map(diffLineSource);
  const lineNumbers = diffLineNumbers(lines);
  return (
    <Highlight
      prism={Prism}
      code={sources.join('\n')}
      language={diffLanguageForPath(path)}
      theme={cardbushSyntaxTheme}
    >
      {({ tokens, getTokenProps }) => (
        <div className="diff-lines syntax-highlighted">
          {lines.map((line, lineIndex) => (
            <ReviewDiffLine
              index={lineIndex} kind={line.kind}
              oldLine={lineNumbers[lineIndex]?.oldLine ?? null}
              newLine={lineNumbers[lineIndex]?.newLine ?? null}
              // A diff can contain identical lines in separate hunks.
              // eslint-disable-next-line react/no-array-index-key
              key={lineIndex}
            >
              <span className="diff-marker" />
              <span className="diff-line-number old" aria-label={uiText(language)('source.oldLineNumber', { number: lineNumbers[lineIndex]?.oldLine ?? '' })}>
                {lineNumbers[lineIndex]?.oldLine ?? ''}
              </span>
              <span className="diff-line-number new" aria-label={uiText(language)('source.newLineNumber', { number: lineNumbers[lineIndex]?.newLine ?? '' })}>
                {lineNumbers[lineIndex]?.newLine ?? ''}
              </span>
              <span className="diff-prefix" aria-hidden="true">{diffLinePrefix(line)}</span>
              <code>
                {sources[lineIndex]
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
            </ReviewDiffLine>
          ))}
        </div>
      )}
    </Highlight>
  );
});
