import type { ChatMessage, ChatToolExecution } from '../types';
import { displayToolName, isToolRunning } from './toolExecutionState';

export type DiffLineKind = 'addition' | 'deletion' | 'context' | 'hunk';

export type DiffLine = {
  kind: DiffLineKind;
  text: string;
};

export type ToolFileChange = {
  path: string;
  additions: number;
  deletions: number;
  diff: string;
  lines: DiffLine[];
};

export type ToolChangeReport = {
  files: ToolFileChange[];
  additions: number;
  deletions: number;
  fileCount: number;
};

export type ConversationChangeReport = ToolChangeReport & {
  id: string;
  messageId: string;
  turnId?: string;
  createdAt?: string;
};

export type SerializedToolFileChange = {
  path: string;
  diff: string;
  lines: string[];
};

type ParsedToolFileChange = {
  files: ToolFileChange[];
  fallbackAdditions: number;
  fallbackDeletions: number;
};

export function toolChangeReportFromExecutions(
  executions: ChatToolExecution[],
): ToolChangeReport | null {
  const relevant = executions.filter(looksLikeFileChangeExecution);
  if (relevant.length === 0) {
    return null;
  }
  const allFiles: ToolFileChange[] = [];
  let fallbackAdditions = 0;
  let fallbackDeletions = 0;
  for (const execution of relevant) {
    const parsed = parseToolFileChange(execution);
    allFiles.push(...parsed.files);
    fallbackAdditions += parsed.fallbackAdditions;
    fallbackDeletions += parsed.fallbackDeletions;
  }
  const files = mergeToolFileChanges(allFiles);
  const parsedAdditions = files.reduce((sum, file) => sum + file.additions, 0);
  const parsedDeletions = files.reduce((sum, file) => sum + file.deletions, 0);
  if (files.length === 0 && fallbackAdditions === 0 && fallbackDeletions === 0) {
    const running = relevant.some(isToolRunning);
    if (!running) {
      return null;
    }
  }
  return {
    files,
    additions: parsedAdditions > 0 ? parsedAdditions : fallbackAdditions,
    deletions: parsedDeletions > 0 ? parsedDeletions : fallbackDeletions,
    fileCount: files.length === 0 ? 1 : files.length,
  };
}

export function changeReportsFromMessages(messages: ChatMessage[]): ConversationChangeReport[] {
  return messages.flatMap((message, index) => {
    const report = toolChangeReportFromExecutions(message.toolExecutions ?? []);
    if (!report) {
      return [];
    }
    return [
      {
        ...report,
        id: `${message.id || index}:${message.turnId ?? ''}`,
        messageId: message.id,
        turnId: message.turnId,
        createdAt: message.createdAt,
      },
    ];
  });
}

export function serializeToolChangeReport(report: ToolChangeReport): SerializedToolFileChange[] {
  return report.files
    .map((file) => ({
      path: file.path,
      diff: file.diff || file.lines.map((line) => line.text).join('\n'),
      lines: file.lines.map((line) => line.text),
    }))
    .filter((file) => file.path.trim() && (file.diff.trim() || file.lines.length > 0));
}

export function looksLikeFileChangeExecution(execution: ChatToolExecution) {
  if (String(execution.metadata.kind ?? '').trim() === 'file_change') {
    return true;
  }
  const name = execution.name.toLowerCase();
  const text = `${execution.summary}\n${execution.output}`.toLowerCase();
  return (
    name.includes('edit_file') ||
    name.includes('write_file') ||
    name.includes('apply_patch') ||
    name.includes('replace_file') ||
    text.includes('*** update file:') ||
    text.includes('*** add file:') ||
    text.includes('*** delete file:') ||
    text.includes('diff --git ') ||
    text.includes('\n+++ ') ||
    text.includes('files changed') ||
    text.includes('个文件已更改')
  );
}

function parseToolFileChange(execution: ChatToolExecution): ParsedToolFileChange {
  const metadataParsed = parseToolFileChangeMetadata(execution);
  if (metadataParsed) {
    return metadataParsed;
  }
  const text = `${execution.summary}\n${execution.output}`
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  const fallback = parseFallbackChangeCounts(text);
  const files: ToolFileChange[] = [];
  const holder: { current: MutableToolFileChange | null } = { current: null };

  function flush() {
    if (holder.current?.hasContent()) {
      files.push(holder.current.freeze());
    }
    holder.current = null;
  }

  function startFile(rawPath: string) {
    const path = cleanDiffPath(rawPath);
    if (!path || path === '/dev/null') {
      return;
    }
    if (holder.current?.path === path) {
      return;
    }
    flush();
    holder.current = new MutableToolFileChange(path);
  }

  function ensureFile() {
    holder.current ??= new MutableToolFileChange(displayToolName(execution.name));
    return holder.current;
  }

  const diffHeader = /^diff --git\s+a\/(.*?)\s+b\/(.*?)$/;
  const patchHeader = /^\*\*\* (?:Update|Add|Delete) File:\s+(.+)$/;
  const oldHeader = /^---\s+(.+)$/;
  const newHeader = /^\+\+\+\s+(.+)$/;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trimEnd();
    const diffMatch = diffHeader.exec(line);
    if (diffMatch) {
      startFile(diffMatch[2] || diffMatch[1] || '');
      continue;
    }
    const patchMatch = patchHeader.exec(line);
    if (patchMatch) {
      startFile(patchMatch[1] ?? '');
      continue;
    }
    const oldMatch = oldHeader.exec(line);
    if (oldMatch) {
      if (!holder.current) {
        startFile(oldMatch[1] ?? '');
      }
      continue;
    }
    const newMatch = newHeader.exec(line);
    if (newMatch) {
      const path = cleanDiffPath(newMatch[1] ?? '');
      if (path && path !== '/dev/null') {
        if (!holder.current || holder.current.path === '/dev/null') {
          startFile(path);
        } else {
          holder.current.path = path;
        }
      }
      continue;
    }
    if (line.startsWith('@@')) {
      const file = ensureFile();
      file.diffLines.push(line);
      file.lines.push({ kind: 'hunk', text: line });
      continue;
    }
    if (line.startsWith('+')) {
      const file = ensureFile();
      file.additions += 1;
      file.diffLines.push(line);
      file.lines.push({ kind: 'addition', text: line });
      continue;
    }
    if (line.startsWith('-')) {
      const file = ensureFile();
      file.deletions += 1;
      file.diffLines.push(line);
      file.lines.push({ kind: 'deletion', text: line });
      continue;
    }
    if (rawLine.startsWith(' ') && holder.current) {
      holder.current.diffLines.push(rawLine.trimEnd());
      holder.current.lines.push({ kind: 'context', text: rawLine.trimEnd() });
    }
  }
  flush();
  return {
    files,
    fallbackAdditions: fallback.additions,
    fallbackDeletions: fallback.deletions,
  };
}

function parseToolFileChangeMetadata(
  execution: ChatToolExecution,
): ParsedToolFileChange | null {
  const metadata = execution.metadata;
  if (String(metadata.kind ?? '').trim() !== 'file_change') {
    return null;
  }
  const filesRaw = Array.isArray(metadata.files) ? metadata.files : [];
  const files: ToolFileChange[] = [];
  for (const rawFile of filesRaw) {
    const fileMap = asRecord(rawFile);
    const path = cleanDiffPath(String(fileMap.path ?? ''));
    if (!path) {
      continue;
    }
    let additions = metadataInt(fileMap.additions);
    let deletions = metadataInt(fileMap.deletions);
    const lines = diffLinesFromText(String(fileMap.diff ?? ''));
    if (additions === 0 && deletions === 0 && lines.length > 0) {
      additions = lines.filter((line) => line.kind === 'addition').length;
      deletions = lines.filter((line) => line.kind === 'deletion').length;
    }
    files.push({
      path,
      additions,
      deletions,
      diff: normalizeDiffText(String(fileMap.diff ?? '')),
      lines,
    });
  }
  return {
    files,
    fallbackAdditions: metadataInt(metadata.additions),
    fallbackDeletions: metadataInt(metadata.deletions),
  };
}

function diffLinesFromText(diff: string): DiffLine[] {
  const lines: DiffLine[] = [];
  for (const rawLine of diff.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith('+++') || line.startsWith('---')) {
      continue;
    }
    if (line.startsWith('@@')) {
      lines.push({ kind: 'hunk', text: line });
    } else if (line.startsWith('+')) {
      lines.push({ kind: 'addition', text: line });
    } else if (line.startsWith('-')) {
      lines.push({ kind: 'deletion', text: line });
    } else if (line.startsWith(' ')) {
      lines.push({ kind: 'context', text: line });
    }
  }
  return lines;
}

function normalizeDiffText(diff: string) {
  return diff.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd();
}

class MutableToolFileChange {
  path: string;
  additions = 0;
  deletions = 0;
  diffLines: string[] = [];
  lines: DiffLine[] = [];

  constructor(path: string) {
    this.path = path;
  }

  hasContent() {
    return this.additions > 0 || this.deletions > 0 || this.lines.length > 0;
  }

  freeze(): ToolFileChange {
    return {
      path: this.path,
      additions: this.additions,
      deletions: this.deletions,
      diff: normalizeDiffText(this.diffLines.join('\n')),
      lines: [...this.lines],
    };
  }
}

function mergeToolFileChanges(files: ToolFileChange[]) {
  const byPath = new Map<string, MutableToolFileChange>();
  for (const file of files) {
    let target = byPath.get(file.path);
    if (!target) {
      target = new MutableToolFileChange(file.path);
      byPath.set(file.path, target);
    }
    target.additions += file.additions;
    target.deletions += file.deletions;
    if (file.diff.trim()) {
      target.diffLines.push(file.diff.trimEnd());
    }
    target.lines.push(...file.lines);
  }
  return [...byPath.values()].map((item) => item.freeze());
}

function parseFallbackChangeCounts(text: string) {
  const compact = /\+(\d+)\s+-([0-9]+)/.exec(text);
  if (compact) {
    return {
      additions: Number.parseInt(compact[1] ?? '', 10) || 0,
      deletions: Number.parseInt(compact[2] ?? '', 10) || 0,
    };
  }
  const insertions = /(\d+)\s+insertions?\(\+\)/.exec(text);
  const deletions = /(\d+)\s+deletions?\(-\)/.exec(text);
  return {
    additions: Number.parseInt(insertions?.[1] ?? '', 10) || 0,
    deletions: Number.parseInt(deletions?.[1] ?? '', 10) || 0,
  };
}

function cleanDiffPath(raw: string) {
  let pathValue = raw.trim();
  const tabIndex = pathValue.indexOf('\t');
  if (tabIndex >= 0) {
    pathValue = pathValue.slice(0, tabIndex);
  }
  if (pathValue.startsWith('"') && pathValue.endsWith('"') && pathValue.length > 1) {
    pathValue = pathValue.slice(1, -1);
  }
  if (pathValue.startsWith('a/') || pathValue.startsWith('b/')) {
    pathValue = pathValue.slice(2);
  }
  return pathValue.trim();
}
function metadataInt(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
}

function asRecord(value: unknown) {
  return value != null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}
