import { uiText } from '../../i18n';
import { ChevronDown, LoaderCircle, RefreshCw, RotateCcw, RotateCw } from 'lucide-react';
import { Suspense, useCallback, useContext, useRef, useState } from 'react';

import type { AppLanguage } from '../../types';
import type { DiffLine, ToolChangeReport, ToolFileChange } from './toolChangeReports';
import { preserveScrollPositionForToggle } from '../preserveScrollPosition';
import { ToolLogo } from './ToolLogo';
import { diffLineNumbers, diffLinePrefix, diffLineSource } from './diffSyntax';
import { DeferredModuleNotice, recoverableLazy } from '../../shared/recoverableLazy';
import { WorkspaceChangeStateContext, workspaceChangeReverted } from './WorkspaceChangeStateContext';
import { ReviewDiffLine } from '../sidebar/ReviewComments';

const DiffSyntaxLines = recoverableLazy<{ lines: DiffLine[]; path: string; language: AppLanguage }>(
  'diff-syntax',
  () => import('./DiffSyntaxLines'),
  (props) => <>
    <DeferredModuleNotice language={props.language} basicPreview />
    <PlainDiffLines lines={props.lines} />
  </>,
);

export function ToolChangeBlock({
  identity,
  report,
  running,
  language,
  toolName,
  onRevert,
  detailsDeferred = false,
  detailsStatus,
  onRequestDetails,
  onRetryDetails,
}: {
  identity?: { sessionId: string; messageId: string; turnId?: string };
  report: ToolChangeReport;
  running: boolean;
  language: AppLanguage;
  toolName: string;
  onRevert?: () => Promise<void>;
  detailsDeferred?: boolean;
  detailsStatus?: 'loading' | 'loaded' | 'failed';
  onRequestDetails?: () => void;
  onRetryDetails?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [reverting, setReverting] = useState(false);
  const changeState = useContext(WorkspaceChangeStateContext);
  const reverted = identity ? workspaceChangeReverted(changeState.states, identity.sessionId, { ...identity, reverted: report.reverted }) : report.reverted;
  const actionLabel = reverted ? (uiText(language)('app.undoRevert')) : (uiText(language)('app.revert'));
  const blockRef = useRef<HTMLDivElement>(null);
  const hasDetails = report.files.some((file) => file.lines.length > 0);
  const canExpand = hasDetails || detailsDeferred;
  const primaryFile = report.files[0];
  const primaryPath = primaryFile?.path ?? '';
  const toggleExpanded = useCallback(() => {
    preserveScrollPositionForToggle(blockRef.current, () => {
      setExpanded((value) => {
        const next = !value;
        if (next && detailsDeferred) onRequestDetails?.();
        return next;
      });
    });
  }, [detailsDeferred, onRequestDetails]);
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
      className={`tool-change-block ${expanded ? 'expanded' : ''} ${running ? 'running' : ''}`}
    >
      <div className="tool-change-header-row">
        <button
          className="tool-change-header"
          type="button"
          disabled={!canExpand}
          onClick={toggleExpanded}
        >
          <ToolLogo name={toolName} size={16} />
          <span>
            <strong>{title}</strong>
            {report.additions > 0 && (
              <b className="diff-count add">
                +{report.additions}
              </b>
            )}
            {report.deletions > 0 && (
              <b className="diff-count del">
                -{report.deletions}
              </b>
            )}
          </span>
          <em>{expanded ? (uiText(language)('toolChangeBlock.hide')) : uiText(language)('toolChangeBlock.viewDiff')}</em>
          <ChevronDown size={16} className={expanded ? 'expanded' : ''} />
        </button>
        {onRevert && report.files.length > 0 && (
          <button
            className="tool-change-revert"
            type="button"
            disabled={reverting || changeState.busy}
            title={actionLabel}
            onClick={async () => {
              setReverting(true);
              try {
                await onRevert();
              } finally {
                setReverting(false);
              }
            }}
          >
            {reverting ? <LoaderCircle size={14} /> : reverted ? <RotateCw size={14} /> : <RotateCcw size={14} />}
            <span>{actionLabel}</span>
          </button>
        )}
      </div>
      {expanded && (
        <div className="tool-change-files">
          {detailsDeferred && !hasDetails && detailsStatus === 'failed' ? (
            <div className="tool-change-details-failed" role="alert">
              <span>{uiText(language)('chatSidebar.unableToLoadChangeDetails')}</span>
              {onRetryDetails && (
                <button type="button" onClick={onRetryDetails}>
                  <RefreshCw size={13} />
                  <span>{uiText(language)('common.retry')}</span>
                </button>
              )}
            </div>
          ) : detailsDeferred && !hasDetails && detailsStatus !== 'loaded' ? (
            <p className="tool-change-details-loading">
              <LoaderCircle size={14} />
              <span>{uiText(language)('chatSidebar.loadingChangeDetails')}</span>
            </p>
          ) : (
            report.files.map((file, index) => (
              <ToolFileChangeView
                // eslint-disable-next-line react/no-array-index-key
                key={`${file.path}-${index}`}
                file={file}
                language={language}
              />
            ))
          )}
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
    return uiText(language)('tools.changedFiles', { count: fileCount });
  }
  const compactPath = compactFilePath(path);
  const verb =
    (hasDetails ? uiText(language)('toolChangeBlock.editing') : uiText(language)('toolChangeBlock.writing'));
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
        <p>{uiText(language)('toolChangeBlock.noDiffDetailsAvailable')}</p>
      ) : (
        <Suspense fallback={<PlainDiffLines lines={file.lines} />}>
          <DiffSyntaxLines lines={file.lines} path={file.path} language={language} />
        </Suspense>
      )}
    </section>
  );
}

function PlainDiffLines({ lines }: { lines: DiffLine[] }) {
  const lineNumbers = diffLineNumbers(lines);
  return (
    <div className="diff-lines">
      {lines.map((line, index) => (
        <DiffLineView
          // eslint-disable-next-line react/no-array-index-key
          key={index}
          line={line}
          index={index}
          oldLine={lineNumbers[index]?.oldLine ?? null}
          newLine={lineNumbers[index]?.newLine ?? null}
        />
      ))}
    </div>
  );
}

function DiffLineView({
  line,
  index,
  oldLine,
  newLine,
}: {
  line: DiffLine;
  index: number;
  oldLine: number | null;
  newLine: number | null;
}) {
  return (
    <ReviewDiffLine index={index} kind={line.kind} oldLine={oldLine} newLine={newLine}>
      <span className="diff-marker" />
      <span className="diff-line-number old">{oldLine ?? ''}</span>
      <span className="diff-line-number new">{newLine ?? ''}</span>
      <span className="diff-prefix" aria-hidden="true">{diffLinePrefix(line)}</span>
      <code>{diffLineSource(line) || ' '}</code>
    </ReviewDiffLine>
  );
}
