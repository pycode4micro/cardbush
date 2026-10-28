import { useUiLanguage } from '../../i18n/react';
import { uiText } from '../../i18n';
import { useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, Globe } from 'lucide-react';
import { parseSourceMemoReference, type SourceEvidence, type SourceMemoResolution } from '@cardbush/bush-protocol';
import { fetchSourceMemo } from '../../backend/sourceMemo';
import { ConversationHostContext } from '../conversationHost';
import { openInspector } from '../inspector/inspectorEvents';
import { resourceBasename } from '../../shared/localPaths';
import { LocalFileReferenceLink } from './LocalFileReferenceLink';
import { FileTypeIcon } from './FileTypeIcon';
import './source-memo.css';

function evidenceLabel(source: SourceEvidence) {
  return source.kind === 'file' ? resourceBasename(source.target) || source.target : source.label || source.target;
}
function evidenceLocation(source: SourceEvidence, uiLanguage: string) {
  if (source.locator?.line) {
    const lines = `${source.locator.line}${source.locator.endLine ? `–${source.locator.endLine}` : ''}`;
    return uiText(uiLanguage)(source.locator.endLine ? 'source.lines' : 'source.line', { lines });
  }
  return source.locator?.page ? (uiText(uiLanguage)('sourceMemoReference.page', { value1: source.locator.page })) : '';
}

export function SourceMemoReference({ reference, language: selectedLanguage, load = fetchSourceMemo }: {
  reference: string; language?: string; load?: typeof fetchSourceMemo;
}) {
  const inheritedLanguage = useUiLanguage();
  const language = selectedLanguage ?? inheritedLanguage;
  const host = useContext(ConversationHostContext);
  const uiLanguage = language, id = useId();
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const excerptPanel = useRef<HTMLDivElement>(null);
  const evidenceRows = useRef<(HTMLDivElement | null)[]>([]);
  const suppressFocus = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const excerptTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [open, setOpen] = useState<'hover' | 'pinned' | null>(null);
  const [excerptIndex, setExcerptIndex] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ key: string; result?: SourceMemoResolution; failed?: boolean }>();
  const key = JSON.stringify([host?.id, reference]);
  useEffect(() => {
    let alive = true, revision = 0;
    const refresh = () => {
      const current = ++revision;
      void load(reference, host?.runtime).then(result => {
        if (alive && current === revision) setState({ key, result });
      }, () => { if (alive && current === revision) setState({ key, failed: true }); });
    };
    refresh(); window.addEventListener('focus', refresh);
    return () => { alive = false; window.removeEventListener('focus', refresh); };
  }, [key, reference, host?.runtime, load, attempt]);
  const result = state?.key === key ? state.result : undefined;
  const failed = state?.key === key && state.failed;
  const memo = result?.status === 'resolved' ? result.memo : undefined;
  const excerpt = excerptIndex === null ? undefined : memo?.sources[excerptIndex];
  const excerptId = `${id}-excerpt`;
  const cancelClose = () => clearTimeout(timer.current);
  const cancelExcerptTimer = () => clearTimeout(excerptTimer.current);
  const closeSoon = () => { cancelClose(); timer.current = setTimeout(() => setOpen(value => value === 'pinned' ? value : null), 180); };
  const closeExcerptSoon = () => {
    cancelExcerptTimer();
    excerptTimer.current = setTimeout(() => {
      if (!excerptPanel.current?.contains(document.activeElement)) setExcerptIndex(null);
    }, 220);
  };
  const enterEvidence = (index: number, hasExcerpt: boolean) => {
    cancelClose(); cancelExcerptTimer();
    excerptTimer.current = setTimeout(() => setExcerptIndex(hasExcerpt ? index : null), 120);
  };
  const showExcerpt = (index: number) => {
    cancelClose(); cancelExcerptTimer(); setOpen('pinned'); setExcerptIndex(index);
    requestAnimationFrame(() => excerptPanel.current?.focus());
  };
  const returnToEvidence = () => {
    cancelExcerptTimer();
    evidenceRows.current[excerptIndex ?? -1]?.querySelector<HTMLButtonElement>('.source-memo-excerpt-trigger')?.focus({ preventScroll: true });
    setExcerptIndex(null);
  };
  useEffect(() => () => { clearTimeout(timer.current); clearTimeout(excerptTimer.current); }, []);
  useEffect(() => { setOpen(null); setExcerptIndex(null); }, [key]);
  useEffect(() => { if (!open) { cancelExcerptTimer(); setExcerptIndex(null); } }, [open]);
  useLayoutEffect(() => {
    if (!open || !panel.current || !trigger.current) return;
    const node = panel.current;
    const child = excerptPanel.current;
    if (!node.matches(':popover-open')) node.showPopover();
    if (child && !child.matches(':popover-open')) child.showPopover();
    const position = () => {
      const anchor = trigger.current?.getBoundingClientRect(); if (!anchor) return;
      node.style.maxHeight = '';
      node.dataset.hasExcerpt = String(Boolean(child));
      const box = node.getBoundingClientRect();
      node.style.left = `${Math.max(8, Math.min(innerWidth - box.width - 8, anchor.left))}px`;
      node.style.top = `${Math.max(8, anchor.top - box.height - 8 >= 8 ? anchor.top - box.height - 8 : Math.min(innerHeight - box.height - 8, anchor.bottom + 8))}px`;
      if (!child || excerptIndex === null) return;
      let parent = node.getBoundingClientRect();
      const rightSpace = innerWidth - parent.right - 14, leftSpace = parent.left - 14;
      const side = rightSpace >= 360 || rightSpace >= leftSpace ? 'right' : 'left';
      const available = side === 'right' ? rightSpace : leftSpace;
      const stacked = available < 260;
      child.dataset.side = stacked ? 'below' : side;
      child.style.width = `${stacked ? parent.width : Math.min(400, available)}px`;
      if (stacked) {
        // Keep both levels visible and reachable by pointer, even in a narrow pane.
        const availableHeight = innerHeight - 22;
        child.style.maxHeight = '';
        const reservedExcerptHeight = Math.min(240, child.getBoundingClientRect().height);
        node.style.maxHeight = `${Math.min(460, Math.max(availableHeight * .5, availableHeight - reservedExcerptHeight))}px`;
        parent = node.getBoundingClientRect();
        child.style.maxHeight = `${availableHeight - parent.height}px`;
        const childHeight = child.getBoundingClientRect().height;
        const top = Math.max(8, Math.min(parent.top, innerHeight - parent.height - childHeight - 14));
        node.style.top = `${top}px`;
        child.style.left = `${parent.left}px`;
        child.style.top = `${top + parent.height + 6}px`;
        return;
      }
      child.style.maxHeight = '';
      const row = evidenceRows.current[excerptIndex]?.getBoundingClientRect() ?? parent;
      const childBox = child.getBoundingClientRect();
      child.style.left = `${side === 'right' ? parent.right + 6 : parent.left - childBox.width - 6}px`;
      child.style.top = `${Math.max(8, Math.min(innerHeight - childBox.height - 8, row.top - 8))}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(node);
    if (child) observer.observe(child);
    const inside = (target: Node | null) => node.contains(target) || child?.contains(target) || trigger.current?.contains(target);
    const outside = (event: PointerEvent) => { if (!inside(event.target as Node)) setOpen(null); };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || (event.key === 'ArrowLeft' && child?.contains(event.target as Node))) {
        event.preventDefault(); event.stopPropagation();
        if (child) returnToEvidence();
        else { setOpen(null); suppressFocus.current = true; trigger.current?.focus({ preventScroll: true }); suppressFocus.current = false; }
      }
    };
    const scroll = (event: Event) => {
      if (!inside(event.target as Node)) setOpen(null);
      else if (node.contains(event.target as Node)) position();
    };
    window.addEventListener('resize', position); window.addEventListener('scroll', scroll, true);
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { observer.disconnect(); node.style.maxHeight = '';
      window.removeEventListener('resize', position); window.removeEventListener('scroll', scroll, true);
      document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open, result, failed, excerptIndex]);
  const blur = (event: React.FocusEvent) => {
    const next = event.relatedTarget as Node | null;
    if (next && !panel.current?.contains(next) && !excerptPanel.current?.contains(next) && !trigger.current?.contains(next)) setOpen(null);
  };
  const openEvidence = (source: SourceEvidence) => {
    setOpen(null);
    if (source.kind === 'url') openInspector(source.target, source.label);
    else if (host) host.openFile(source.target);
    else openInspector(source.target, source.label);
  };
  const evidenceLink = (source: SourceEvidence, index: number) => {
    const disabled = result?.status === 'resolved' && result.evidenceStatus[index] === 'unavailable';
    if (source.kind === 'file' && !host) return <LocalFileReferenceLink path={source.target}
      knownFileName={evidenceLabel(source)} disabled={disabled} language={language}
      className="source-memo-evidence-link" onOpen={() => openEvidence(source)} />;
    if (source.kind === 'file') return <button type="button" className="source-memo-evidence-link local-file-reference"
      title={source.target} disabled={disabled} onClick={() => openEvidence(source)}>
      <FileTypeIcon path={source.target} /><span>{evidenceLabel(source)}</span>
    </button>;
    return <a href={source.target} title={source.target} className="source-memo-evidence-link local-file-reference"
      onClick={event => { event.preventDefault(); openEvidence(source); }}><Globe size={14} aria-hidden="true" /><span>{evidenceLabel(source)}</span></a>;
  };
  const pinForContextMenu = () => { cancelClose(); cancelExcerptTimer(); setOpen('pinned'); };
  return <>
    <button ref={trigger} type="button" className="source-memo-marker" aria-label={uiText(language)('reference.sourceNumber', { number: parseSourceMemoReference(reference) })}
      aria-expanded={Boolean(open)} aria-controls={open ? id : undefined} aria-haspopup="dialog"
      onMouseEnter={() => { cancelClose(); setOpen(value => value ?? 'hover'); }} onMouseLeave={closeSoon}
      onFocus={event => { if (!suppressFocus.current && event.currentTarget.matches(':focus-visible')) setOpen('hover'); }} onBlur={blur}
      onKeyDown={event => { if (event.key === 'ArrowDown') {
        event.preventDefault(); setOpen('pinned');
        requestAnimationFrame(() => (panel.current?.querySelector<HTMLElement>('a:not([aria-disabled="true"]), button:not(:disabled)') ?? panel.current)?.focus());
      } }}
      onClick={() => { cancelClose(); setOpen(value => value === 'pinned' ? null : 'pinned'); }}>
      {parseSourceMemoReference(reference)}
    </button>
    {open && createPortal(<div ref={panel} popover="manual" id={id} role="dialog" tabIndex={-1} aria-labelledby={`${id}-heading`} className="source-memo-card"
      onMouseEnter={cancelClose} onMouseLeave={closeSoon} onBlur={blur} onContextMenuCapture={pinForContextMenu}>
      <div className="source-memo-heading"><h3 id={`${id}-heading`}>{uiText(language)('sourceMemoReference.whyThisConclusion')}</h3>
        <span>{uiText(language)('sourceMemoReference.source')}{parseSourceMemoReference(reference)}</span></div>
      {memo ? <>
        <p className="source-memo-explanation">{memo.explanation}</p>
        {memo.sources.length > 0 ? <section className="source-memo-evidence" aria-labelledby={`${id}-sources`}>
          <div className="source-memo-evidence-heading"><h3 id={`${id}-sources`}>{uiText(language)('sourceMemoReference.supportingSources')}</h3>
            <small>{host ? (uiText(language)('sourceMemoReference.clickToOpen')) : (uiText(language)('sourceMemoReference.clickToOpenRightClickForMore'))}</small></div>
          <div className="source-memo-evidence-list">
          {memo.sources.map((source, index) => <div key={index} ref={node => { evidenceRows.current[index] = node; }}
            className="source-memo-evidence-row" data-expanded={excerptIndex === index || undefined}
            onMouseEnter={() => enterEvidence(index, source.excerpt !== undefined)} onMouseLeave={closeExcerptSoon}
            onKeyDown={event => { if (event.key === 'ArrowRight' && source.excerpt !== undefined) { event.preventDefault(); showExcerpt(index); } }}>
            <div className="source-memo-evidence-info">
              {evidenceLink(source, index)}
              {evidenceLocation(source, uiLanguage) && <small>{evidenceLocation(source, uiLanguage)}</small>}
              {result?.status === 'resolved' && ['changed', 'unavailable'].includes(result.evidenceStatus[index]) &&
                <small>{result.evidenceStatus[index] === 'changed' ? (uiText(language)('sourceMemoReference.fileChangedOpensTheCurrentVersion')) : (uiText(language)('sourceMemoReference.fileUnavailableOriginalEvidenceRetained'))}</small>}
            </div>
            {source.excerpt !== undefined && <button type="button" className="source-memo-excerpt-trigger"
              aria-label={`${uiText(language)('sourceMemoReference.viewOriginalExcerpt')} · ${evidenceLabel(source)}`}
              title={uiText(language)('sourceMemoReference.viewOriginalExcerpt')} aria-haspopup="dialog"
              aria-expanded={excerptIndex === index} aria-controls={excerptIndex === index ? excerptId : undefined}
              onClick={() => showExcerpt(index)}><span>{uiText(language)('sourceMemoReference.excerpt')}</span><ChevronRight size={14} aria-hidden="true" /></button>}
          </div>)}
          </div>
        </section> : <small className="source-memo-judgment">{uiText(language)('sourceMemoReference.agentJudgmentNoSupportingMaterialsAttached')}</small>}
      </> : <p role="status">{failed || result?.status === 'unresolved'
        ? uiText(language)('sourceMemoReference.thisSourceNoteIsUnavailable')
        : uiText(language)('sourceMemoReference.loadingSource')}</p>}
      {(failed || result?.status === 'unresolved') && <button type="button" onClick={() => setAttempt(value => value + 1)}>{uiText(language)('common.retry')}</button>}
    </div>, document.querySelector('.app') ?? document.body)}
    {open && excerpt?.excerpt !== undefined && createPortal(<div ref={excerptPanel} popover="manual" id={excerptId}
      role="dialog" tabIndex={-1} aria-labelledby={`${excerptId}-heading`} className="source-memo-card source-memo-excerpt"
      onMouseEnter={() => { cancelClose(); cancelExcerptTimer(); }} onMouseLeave={() => { closeSoon(); closeExcerptSoon(); }} onBlur={blur} onContextMenuCapture={pinForContextMenu}>
      <div className="source-memo-excerpt-heading">
        <h3 id={`${excerptId}-heading`}>{uiText(language)('sourceMemoReference.originalExcerpt')}</h3>
        <small>{uiText(language)('sourceMemoReference.savedWhenThisExplanationWasWritten')}</small>
      </div>
      <div className="source-memo-excerpt-label">{evidenceLink(excerpt, excerptIndex!)}
        {evidenceLocation(excerpt, uiLanguage) && <small>{evidenceLocation(excerpt, uiLanguage)}</small>}</div>
      <pre tabIndex={0}>{excerpt.excerpt}</pre>
    </div>, document.querySelector('.app') ?? document.body)}
  </>;
}
