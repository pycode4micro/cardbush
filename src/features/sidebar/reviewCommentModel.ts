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
  const zh = language === 'zh';
  return [zh
    ? '请按以下代码审查评论处理修改。行号和代码片段对应评论时的版本，请先核对当前文件。L 表示修改前，R 表示修改后。'
    : 'Please address these code review comments. Lines and excerpts refer to the version reviewed; verify the current file first. L is before the change and R is after.',
  ...comments.map((comment, index) => [
    `${index + 1}. ${zh ? '文件' : 'File'}: ${comment.path}`,
    `${zh ? '位置' : 'Location'}: ${reviewLineLabel(comment)} · ${zh ? '轮次' : 'Turn'}: ${comment.turnId}`,
    `${zh ? '评论' : 'Comment'}: ${comment.text.trim()}`,
    `${zh ? '当时的代码片段' : 'Reviewed excerpt'}:\n${comment.excerpt.split('\n').map(line => `    ${line}`).join('\n')}`,
  ].join('\n'))].join('\n\n');
}

export function appendReviewCommentsToDraft(draft: string, comments: ReviewComment[], language: AppLanguage) {
  if (!comments.length) return draft;
  return [draft.trimEnd(), formatReviewComments(comments, language)].filter(Boolean).join('\n\n');
}
