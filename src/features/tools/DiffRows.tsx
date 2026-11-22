import type { ReactNode } from 'react';
import { uiText } from '../../i18n';
import type { AppLanguage } from '../../types';
import { ReviewDiffLine } from '../sidebar/ReviewComments';
import { diffLinePrefix, diffLineSource, type DiffLineNumber } from './diffSyntax';
import type { DiffLine } from './toolChangeReports';

export type DiffRowsProps = {
  lines: DiffLine[];
  numbers: DiffLineNumber[];
  language: AppLanguage;
  start?: number;
  end?: number;
  onRevealRow?: (index: number) => void;
};

export function DiffRows({ lines, numbers, language, start = 0, end = lines.length, onRevealRow, renderSource }: DiffRowsProps & {
  renderSource?: (index: number) => ReactNode;
}) {
  const t = uiText(language);
  return <>{lines.slice(start, end).map((line, offset) => {
    const index = start + offset;
    const { oldLine, newLine } = numbers[index];
    return <ReviewDiffLine key={index} index={index} kind={line.kind} oldLine={oldLine} newLine={newLine} onRevealRow={onRevealRow}>
      <span className="diff-marker" />
      <span className="diff-line-number old" aria-label={t('source.oldLineNumber', { number: oldLine ?? '' })}>{oldLine ?? ''}</span>
      <span className="diff-line-number new" aria-label={t('source.newLineNumber', { number: newLine ?? '' })}>{newLine ?? ''}</span>
      <span className="diff-prefix" aria-hidden="true">{diffLinePrefix(line)}</span>
      <code>{renderSource?.(offset) ?? (diffLineSource(line) || ' ')}</code>
    </ReviewDiffLine>;
  })}</>;
}
