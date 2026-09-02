import { Highlight, type PrismTheme } from 'prism-react-renderer';

import type { DiffLine } from './toolChangeReports';
import {
  diffLanguageForPath,
  diffLineNumbers,
  diffLinePrefix,
  diffLineSource,
} from './diffSyntax';

export const cardbushSyntaxTheme: PrismTheme = {
  plain: { color: 'var(--diff-syntax-text)' },
  styles: [
    {
      types: ['comment', 'prolog', 'doctype', 'cdata'],
      style: { color: 'var(--diff-syntax-comment)', fontStyle: 'italic' },
    },
    {
      types: ['punctuation'],
      style: { color: 'var(--diff-syntax-punctuation)' },
    },
    {
      types: ['property', 'tag', 'constant', 'symbol', 'attr-name'],
      style: { color: 'var(--diff-syntax-property)' },
    },
    {
      types: ['boolean', 'number'],
      style: { color: 'var(--diff-syntax-number)' },
    },
    {
      types: ['selector', 'string', 'char', 'builtin', 'inserted', 'attr-value'],
      style: { color: 'var(--diff-syntax-string)' },
    },
    {
      types: ['operator', 'entity', 'url'],
      style: { color: 'var(--diff-syntax-operator)' },
    },
    {
      types: ['atrule', 'keyword'],
      style: { color: 'var(--diff-syntax-keyword)' },
    },
    {
      types: ['function', 'class-name'],
      style: { color: 'var(--diff-syntax-function)' },
    },
    {
      types: ['regex', 'important', 'variable'],
      style: { color: 'var(--diff-syntax-variable)' },
    },
    {
      types: ['deleted'],
      style: { color: 'var(--diff-syntax-deleted)' },
    },
  ],
};

export default function DiffSyntaxLines({
  lines,
  path,
}: {
  lines: DiffLine[];
  path: string;
}) {
  const sources = lines.map(diffLineSource);
  const lineNumbers = diffLineNumbers(lines);
  return (
    <Highlight
      code={sources.join('\n')}
      language={diffLanguageForPath(path)}
      theme={cardbushSyntaxTheme}
    >
      {({ tokens, getTokenProps }) => (
        <div className="diff-lines syntax-highlighted">
          {lines.map((line, lineIndex) => (
            <div
              className={`diff-line ${line.kind}`}
              // A diff can contain identical lines in separate hunks.
              // eslint-disable-next-line react/no-array-index-key
              key={lineIndex}
            >
              <span className="diff-marker" />
              <span className="diff-line-number old" aria-label={`Old line ${lineNumbers[lineIndex]?.oldLine ?? ''}`}>
                {lineNumbers[lineIndex]?.oldLine ?? ''}
              </span>
              <span className="diff-line-number new" aria-label={`New line ${lineNumbers[lineIndex]?.newLine ?? ''}`}>
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
            </div>
          ))}
        </div>
      )}
    </Highlight>
  );
}
