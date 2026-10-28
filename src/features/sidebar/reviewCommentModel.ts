import { uiText } from '../../i18n';
import type { AppLanguage } from '../../types';
import type { DiffLine } from '../tools/toolChangeReports';
import { diffLineNumbers, diffLineSource } from '../tools/diffSyntax';

export type ReviewCommentAnchor = {
  path: string;
  turnId: string;
  revision: string;
  side: 'old' | 'new';
  startLine: number;
  endLine: number;
  excerpt: string;
};
export type ReviewComment = ReviewCommentAnchor & { id: string; text: string };
export type ReviewCommentDraft = ReviewCommentAnchor & { id?: string; text: string };
export type ReviewCommentState = { comments: ReviewComment[]; draft: ReviewCommentDraft | null };
export const emptyReviewComments: ReviewCommentState = { comments: [], draft: null };

// Keep only the selected excerpt, never a second copy of a file or its undo snapshot.
export function reviewRevision(lines: DiffLine[]) {
  let hash = 2166136261;
  for (const line of lines) {
    const value = `${line.kind}:${line.text}\n`;
    for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  }
  return `${lines.length}-${(hash >>> 0).toString(16)}`;
}

export function reviewAnchor(
  lines: DiffLine[], path: string, turnId: string, revision: string,
  index: number, side: ReviewCommentAnchor['side'], extend?: ReviewCommentAnchor | null,
): ReviewCommentAnchor | null {
  const numbers = diffLineNumbers(lines);
  const numberKey = side === 'old' ? 'oldLine' : 'newLine';
  const line = numbers[index]?.[numberKey];
  if (line == null || line < 1 || lines[index]?.kind === 'hunk') return null;
  const sameScope = extend?.path === path && extend.turnId === turnId && extend.revision === revision && extend.side === side;
  const other = sameScope ? extend.startLine : line;
  const startLine = Math.min(other, line), endLine = Math.max(other, line);
  const excerpt = lines.filter((_, i) => {
    const value = numbers[i]?.[numberKey];
    return value != null && value >= startLine && value <= endLine;
  }).map(diffLineSource).join('\n');
  return { path, turnId, revision, side, startLine, endLine,
    excerpt: excerpt.length > 4000 ? `${excerpt.slice(0, 4000)}\n…` : excerpt };
}

export function reviewLineLabel(anchor: ReviewCommentAnchor) {
  const prefix = anchor.side === 'old' ? 'L' : 'R';
  return `${prefix}${anchor.startLine}${anchor.endLine === anchor.startLine ? '' : `–${prefix}${anchor.endLine}`}`;
}

export function formatReviewComments(comments: ReviewComment[], language: AppLanguage) {

  return [uiText(language)('reviewCommentModel.pleaseAddressTheseCodeReviewCommentsLines'),
  ...comments.map((comment, index) => [
    `${index + 1}. ${uiText(language)('reviewCommentModel.file')}: ${comment.path}`,
    `${uiText(language)('pluginManagementPanel.location')}: ${reviewLineLabel(comment)} · ${uiText(language)('reviewCommentModel.turn')}: ${comment.turnId}`,
    `${uiText(language)('reviewCommentModel.comment')}: ${comment.text.trim()}`,
    `${uiText(language)('reviewCommentModel.reviewedExcerpt')}:\n${comment.excerpt.split('\n').map(line => `    ${line}`).join('\n')}`,
  ].join('\n'))].join('\n\n');
}

export function appendReviewCommentsToDraft(draft: string, comments: ReviewComment[], language: AppLanguage) {
  if (!comments.length) return draft;
  return [draft.trimEnd(), formatReviewComments(comments, language)].filter(Boolean).join('\n\n');
}
