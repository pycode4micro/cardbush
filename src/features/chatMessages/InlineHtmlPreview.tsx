import { createElement, memo, useEffect, useRef, useState } from 'react';
import { Maximize2, RotateCw } from 'lucide-react';
import type { AppLanguage } from '../../types';
import { basename } from '../../shared/localPaths';
import { resolveFilePreview } from '../inspector/filePreviewRegistry';
import { openInspector } from '../inspector/inspectorEvents';
import { LocalFileReferenceLink } from './LocalFileReferenceLink';

/** Uses the same file adapter as the inspector; only an authored embed mounts it. */
export function isHtmlPreviewPath(path: string) {
  return resolveFilePreview(path)?.id === 'html';
}

export const InlineHtmlPreview = memo(function InlineHtmlPreview({ path, title, language }: {
  path: string; title?: string; language: AppLanguage;
}) {
  const container = useRef<HTMLSpanElement>(null);
  const frame = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const source = resolveFilePreview(path)?.source(path);
  const label = title || basename(path);
  const zh = language === 'zh';

  useEffect(() => {
    if (!container.current) return;
    // Load once near the viewport. Scrolling and transcript updates must retain
    // the guest and its chart state, rather than repeatedly mounting a page.
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      setVisible(true);
      observer.disconnect();
    }, { rootMargin: '240px' });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const webview = frame.current;
    if (!visible || !webview) return;
    let settled = false;
    const deadline = window.setTimeout(() => fail(), 30000);
    const ready = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(deadline);
      setState('ready');
    };
    const fail = (event?: Event) => {
      const detail = event as (Event & { isMainFrame?: boolean; errorCode?: number }) | undefined;
      if (detail?.isMainFrame === false || detail?.errorCode === -3) return;
      settled = true;
      window.clearTimeout(deadline);
      setState('failed');
    };
    webview.addEventListener('dom-ready', ready);
    webview.addEventListener('did-fail-load', fail);
    webview.addEventListener('render-process-gone', fail);
    return () => {
      window.clearTimeout(deadline);
      webview.removeEventListener('dom-ready', ready);
      webview.removeEventListener('did-fail-load', fail);
      webview.removeEventListener('render-process-gone', fail);
    };
  }, [visible, source, revision]);

  function reload() {
    setState('loading');
    setRevision(value => value + 1);
  }

  // Phrasing elements keep ![] valid inside Markdown paragraphs and memo links.
  return <span ref={container} className="inline-html-preview" aria-label={label}>
    <span className="inline-html-toolbar">
      <LocalFileReferenceLink path={path} knownFileName={basename(path)}>{label}</LocalFileReferenceLink>
      <span className="inline-html-actions">
        <button type="button" onClick={reload} aria-label={zh ? '重新加载 HTML' : 'Reload HTML'} title={zh ? '重新加载' : 'Reload'}><RotateCw size={14} /></button>
        <button type="button" onClick={() => openInspector(path, label)} aria-label={zh ? '在侧栏展开 HTML' : 'Open HTML in side panel'} title={zh ? '在侧栏展开' : 'Open in side panel'}><Maximize2 size={14} /></button>
      </span>
    </span>
    <span className={`inline-html-viewport is-${state}`} aria-busy={visible && state === 'loading'}>
      {visible && source && state !== 'failed' && createElement('webview', {
        key: `${path}:${revision}`,
        ref: frame,
        src: source,
        title: label,
        className: 'inline-html-webview',
        webpreferences: 'contextIsolation=yes,nodeIntegration=no,sandbox=yes',
      })}
      {state !== 'ready' && <span className="inline-html-status" role="status">
        {state === 'failed' ? <>
          <span>{zh ? '预览暂时无法加载' : 'Preview could not load'}</span>
          <button type="button" onClick={reload}>{zh ? '重试' : 'Retry'}</button>
        </> : <span>{zh ? 'HTML 预览' : 'HTML preview'}</span>}
      </span>}
    </span>
  </span>;
});
