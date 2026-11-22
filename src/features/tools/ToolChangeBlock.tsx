import { uiText } from '../../i18n';
import { ChevronDown, LoaderCircle, RefreshCw, RotateCcw, RotateCw } from 'lucide-react';
import { memo, Suspense, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';

import type { AppLanguage } from '../../types';
import type { ToolChangeReport, ToolFileChange } from './toolChangeReports';
import { preserveScrollPositionForToggle } from '../preserveScrollPosition';
import { ToolLogo } from './ToolLogo';
import { diffBlocks, diffLineNumbers, shouldVirtualizeDiff } from './diffSyntax';
import { DeferredModuleNotice, recoverableLazy } from '../../shared/recoverableLazy';
import { WorkspaceChangeStateContext, workspaceChangeReverted } from './WorkspaceChangeStateContext';
import { DiffRows, type DiffRowsProps } from './DiffRows';

const DiffSyntaxLines = recoverableLazy<DiffRowsProps & { path: string }>(
  'diff-syntax',
  () => import('./DiffSyntaxLines'),
  (props) => <>
    <DeferredModuleNotice language={props.language} basicPreview />
    <DiffRows {...props} />
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

export const ToolFileChangeView = memo(function ToolFileChangeView({
  file,
  language,
  review = false,
}: {
  file: ToolFileChange;
  language: AppLanguage;
  review?: boolean;
}) {
  const numbers = useMemo(() => diffLineNumbers(file.lines), [file.lines]);
  const largeReview = useMemo(() => review && shouldVirtualizeDiff(file.lines), [review, file.lines]);
  const rows = { lines: file.lines, numbers, language, path: file.path };
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
      ) : largeReview ? <VirtualDiffLines {...rows} /> : <div className="diff-lines"><HighlightedDiffRows {...rows} /></div>}
    </section>
  );
});

function HighlightedDiffRows(props: DiffRowsProps & { path: string }) {
  return <Suspense fallback={<DiffRows {...props} />}>
    <DiffSyntaxLines {...props} />
  </Suspense>;
}

const diffOverscan = { top: 240, bottom: 320 };

function VirtualDiffLines(rows: DiffRowsProps & { path: string }) {
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<VirtuosoHandle>(null);
  const [scrollParent, setScrollParent] = useState<HTMLElement>();
  const blocks = useMemo(() => diffBlocks(rows.lines), [rows.lines]);
  const pendingReveal = useRef<number | null>(null);
  useLayoutEffect(() => {
    const parent = root.current?.closest<HTMLElement>('.tool-file-change');
    if (parent) setScrollParent(parent);
  }, []);
  const revealMountedRow = useCallback(() => {
    const index = pendingReveal.current;
    if (index === null) return;
    const row = root.current?.querySelector(`[data-diff-line-index="${index}"]`);
    const editor = row?.nextElementSibling?.querySelector<HTMLTextAreaElement>('textarea');
    if (!editor) return;
    pendingReveal.current = null;
    editor.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    editor.focus({ preventScroll: true });
  }, []);
  const revealRow = useCallback((index: number) => {
    pendingReveal.current = index;
    revealMountedRow();
    if (pendingReveal.current === null) return;
    // The inline editor remounts only after its virtual block enters the viewport.
    const block = blocks.findIndex(({ start, end }) => index >= start && index < end);
    if (block >= 0) list.current?.scrollToIndex({ index: block, align: 'start' });
  }, [blocks, revealMountedRow]);

  return <div ref={root} className="diff-lines" data-render-mode="virtual">
    {scrollParent && <Virtuoso ref={list} customScrollParent={scrollParent} data={blocks}
      initialItemCount={1} increaseViewportBy={diffOverscan}
      itemsRendered={() => { if (pendingReveal.current !== null) requestAnimationFrame(revealMountedRow); }}
      itemContent={(_index, { start, end, highlight }) => {
        const block = { ...rows, start, end, onRevealRow: revealRow };
        return highlight ? <HighlightedDiffRows {...block} /> : <DiffRows {...block} />;
      }} />}
  </div>;
}
