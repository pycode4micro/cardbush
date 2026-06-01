import { ChevronDown, Edit3, LoaderCircle, RotateCcw } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';

import type { AppLanguage } from '../types';
import type { DiffLine, ToolChangeReport, ToolFileChange } from './toolChangeReports';
import { preserveScrollPositionForToggle } from './preserveScrollPosition';

type ToolExecutionTone = 'neutral' | 'warning' | 'danger';

export function ToolChangeBlock({
  report,
  running,
  tone,
  language,
  onRevert,
}: {
  report: ToolChangeReport;
  running: boolean;
  tone: ToolExecutionTone;
  language: AppLanguage;
  onRevert?: () => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [reverting, setReverting] = useState(false);
  const blockRef = useRef<HTMLDivElement>(null);
  const hasDetails = report.files.some((file) => file.lines.length > 0);
  const primaryFile = report.files[0];
  const primaryPath = primaryFile?.path ?? '';
  const toggleExpanded = useCallback(() => {
    preserveScrollPositionForToggle(blockRef.current, () => {
      setExpanded((value) => !value);
    });
  }, []);
  const title = toolChangeTitle({
    running,
    hasDetails,
    path: primaryPath,
    fileCount: report.fileCount,
    language,
  });

  return (
    <div
      ref={blockRef}
      className={`tool-change-block ${expanded ? 'expanded' : ''} ${running ? 'running' : ''} ${tone}`}
    >
      <div className="tool-change-header-row">
        <button
          className="tool-change-header"
          type="button"
          disabled={!hasDetails}
          onClick={toggleExpanded}
        >
          <Edit3 size={14} />
          <span>
            <strong>{title}</strong>
            {report.additions > 0 && (
              <b className={`diff-count add ${running ? 'running' : ''}`}>
                +{report.additions}
              </b>
            )}
            {report.deletions > 0 && (
              <b className={`diff-count del ${running ? 'running' : ''}`}>
                -{report.deletions}
              </b>
            )}
          </span>
          <em>{expanded ? (language === 'zh' ? '收起' : 'Hide') : language === 'zh' ? '查看改动' : 'View diff'}</em>
          <ChevronDown size={16} className={expanded ? 'expanded' : ''} />
        </button>
        {onRevert && hasDetails && (
          <button
            className="tool-change-revert"
            type="button"
            disabled={reverting}
            title={language === 'zh' ? '撤回这组修改' : 'Revert this change set'}
            onClick={async () => {
              setReverting(true);
              try {
                await onRevert();
              } finally {
                setReverting(false);
              }
            }}
          >
            {reverting ? <LoaderCircle size={14} /> : <RotateCcw size={14} />}
            <span>{language === 'zh' ? '撤回' : 'Revert'}</span>
          </button>
        )}
      </div>
      {expanded && (
        <div className="tool-change-files">
          {report.files.map((file, index) => (
            <ToolFileChangeView
              // eslint-disable-next-line react/no-array-index-key
              key={`${file.path}-${index}`}
              file={file}
              language={language}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function compactFilePath(path: string) {
  const normalized = path.trim();
  if (!normalized) {
    return '';
  }
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) {
    return normalized;
  }
  return `${parts.at(-2)}/${parts.at(-1)}`;
}

function toolChangeTitle({
  running,
  hasDetails,
  path,
  fileCount,
  language,
}: {
  running: boolean;
  hasDetails: boolean;
  path: string;
  fileCount: number;
  language: AppLanguage;
}) {
  if (!running) {
    return language === 'zh'
      ? `${fileCount} 个文件已更改`
      : `${fileCount} file${fileCount === 1 ? '' : 's'} changed`;
  }
  const compactPath = compactFilePath(path);
  const verb =
    language === 'zh'
      ? hasDetails
        ? '正在编辑'
        : '正在写入'
      : hasDetails
        ? 'Editing'
        : 'Writing';
  return compactPath ? `${verb} ${compactPath}` : verb;
}

export function ToolFileChangeView({
  file,
  language,
}: {
  file: ToolFileChange;
  language: AppLanguage;
}) {
  return (
    <section className="tool-file-change">
      <header>
        <strong title={file.path}>{file.path}</strong>
        <span>
          {file.additions > 0 && <b className="diff-count add">+{file.additions}</b>}
          {file.deletions > 0 && <b className="diff-count del">-{file.deletions}</b>}
        </span>
      </header>
      {file.lines.length === 0 ? (
        <p>{language === 'zh' ? '没有可展开的 diff 内容' : 'No diff details available'}</p>
      ) : (
        <div className="diff-lines">
          {file.lines.map((line, index) => (
            <DiffLineView
              // eslint-disable-next-line react/no-array-index-key
              key={index}
              line={line}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function DiffLineView({ line }: { line: DiffLine }) {
  return (
    <div className={`diff-line ${line.kind}`}>
      <span className="diff-marker" />
      <code>{line.text || ' '}</code>
    </div>
  );
}
