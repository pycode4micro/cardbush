import { uiText } from '../../i18n';
import { memo, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { InspectorPageVisible } from './inspectorPageVisibility';
import { getDocument, GlobalWorkerOptions, TextLayer, version, type PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { fileUrl } from '../../shared/localPaths';
import { Minus, Plus, Download } from 'lucide-react';
import type { InspectorFilePreviewProps } from './inspectorFilePreviewRenderers';
import './pdfPreview.css';

GlobalWorkerOptions.workerSrc = workerUrl;

// Budget only hidden, fully painted pages. Visible pages are virtualized by
// Virtuoso. Closing a tab or scrolling a page out of that window unregisters it.
const parkedPages = new Map<HTMLCanvasElement, { bytes: number; release: () => void }>();
function parkPage(canvas: HTMLCanvasElement, release: () => void) {
  parkedPages.set(canvas, { bytes: canvas.width * canvas.height * 4, release });
  let bytes = 0;
  for (const page of parkedPages.values()) bytes += page.bytes;
  for (const [key, page] of parkedPages) {
    if (bytes <= 24 * 1024 * 1024 && parkedPages.size <= 6) break;
    parkedPages.delete(key);
    bytes -= page.bytes;
    page.release();
  }
  return () => { parkedPages.delete(canvas); };
}

const PdfPage = memo(function PdfPage({ pdf, number, width }: { pdf: PDFDocumentProxy; number: number; width: number }) {
  const active = useContext(InspectorPageVisible);
  const canvas = useRef<HTMLCanvasElement>(null), text = useRef<HTMLDivElement>(null);
  const completed = useRef<{ pdf: PDFDocumentProxy; number: number; width: number; pixelRatio: number } | null>(null);
  const [ratio, setRatio] = useState(1.414), [error, setError] = useState(''), [painted, setPainted] = useState(false);
  useEffect(() => {
    const target = canvas.current, layer = text.current;
    if (!target || !layer) return;
    const pixelRatio = devicePixelRatio || 1;
    const saved = completed.current;
    const reusable = saved?.pdf === pdf && saved.number === number && saved.width === width && saved.pixelRatio === pixelRatio;
    if (!active) {
      const release = () => {
        completed.current = null;
        target.width = target.height = 0;
        layer.replaceChildren();
        setPainted(false);
      };
      if (reusable) return parkPage(target, release);
      release();
      return;
    }
    if (reusable || !width) return;
    completed.current = null;
    let disposed = false;
    let loaded: Awaited<ReturnType<PDFDocumentProxy['getPage']>> | undefined;
    let render: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | undefined;
    let textLayer: TextLayer | undefined;
    setError(''); setPainted(false);
    void pdf.getPage(number).then(async page => {
      if (disposed || !canvas.current || !text.current) return;
      loaded = page;
      const natural = page.getViewport({ scale: 1 });
      setRatio(natural.height / natural.width);
      const viewport = page.getViewport({ scale: width / natural.width });
      const scale = Math.min(pixelRatio, 2, Math.sqrt(8_000_000 / (viewport.width * viewport.height)));
      target.width = Math.ceil(viewport.width * scale); target.height = Math.ceil(viewport.height * scale);
      text.current.replaceChildren();
      text.current.style.setProperty('--total-scale-factor', String(viewport.scale));
      render = page.render({ canvas: target, viewport, transform: [scale, 0, 0, scale, 0, 0] });
      await Promise.all([render.promise, page.getTextContent().then(async content => {
        if (disposed || !text.current) return;
        textLayer = new TextLayer({ textContentSource: content, container: text.current, viewport });
        await textLayer.render();
      })]);
      if (!disposed) {
        completed.current = { pdf, number, width, pixelRatio };
        setPainted(true);
      }
    }).catch(cause => { if (!disposed && cause?.name !== 'RenderingCancelledException') setError(String(cause.message ?? cause)); });
    return () => { disposed = true; render?.cancel(); textLayer?.cancel(); loaded?.cleanup(); };
  }, [pdf, number, width, active]);
  return <div className="inspector-pdf-page" data-region-page={number} data-region-loading={!active || !painted || undefined} style={{ width, height: width * ratio }}>
    <canvas ref={canvas}/><div ref={text} className="pdf-region-text"/>
    {error && <p role="alert">{error}</p>}
    <span className="inspector-pdf-page-number" data-region-ui>{number}</span>
  </div>;
});

export default function PdfInspectorPreview({ path, source, language, onLoadingChange }: InspectorFilePreviewProps) {
  const active = useContext(InspectorPageVisible);
  const [pdf, setPdf] = useState<PDFDocumentProxy>(), [error, setError] = useState('');
  const [root, setRoot] = useState<HTMLDivElement | null>(null), [width, setWidth] = useState(0);
  const [zoom, setZoom] = useState(1);
  useEffect(() => { root?.dispatchEvent(new Event('cardbush-preview-layout', { bubbles: true })); }, [root, zoom]);
  useLayoutEffect(() => {
    if (!active || !root) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(root); return () => observer.disconnect();
  }, [active, root]);
  useEffect(() => {
    let disposed = false;
    setPdf(undefined); setError(''); onLoadingChange(true);
    const base = new URL(`assets/pdfjs-${version}/`, document.baseURI).href;
    const job = getDocument({ url: source.startsWith('blob:') ? source : fileUrl(path), cMapUrl: base + 'cmaps/', cMapPacked: true,
      standardFontDataUrl: base + 'standard_fonts/', wasmUrl: base + 'wasm/', isEvalSupported: false });
    void job.promise.then(value => { if (!disposed) { setPdf(value); onLoadingChange(false); } }).catch(cause => {
      if (!disposed) { setError(String(cause.message ?? cause)); onLoadingChange(false); }
    });
    return () => { disposed = true; void job.destroy().catch(() => {}); };
  }, [path, source, onLoadingChange]);
  return <div ref={setRoot} className="inspector-pdf-preview" aria-label={uiText(language)('pdfInspectorPreview.pdfPreview')}>
    {pdf && <div className="inspector-pdf-toolbar" data-region-ui>
      <span>{pdf.numPages} {uiText(language)('pdfInspectorPreview.pages')}</span>
      <button type="button" aria-label={uiText(language)('pdfInspectorPreview.zoomOutPdf')} disabled={zoom <= .5} onClick={() => setZoom(value => Math.max(.5, value - .25))}><Minus size={14}/></button>
      <button type="button" aria-label={uiText(language)('pdfInspectorPreview.fitPdfWidth')} onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
      <button type="button" aria-label={uiText(language)('pdfInspectorPreview.zoomInPdf')} disabled={zoom >= 3} onClick={() => setZoom(value => Math.min(3, value + .25))}><Plus size={14}/></button>
      <a href={source.startsWith('blob:') ? source : fileUrl(path)} download={path.split(/[\\/]/).at(-1)} aria-label={uiText(language)('pdfInspectorPreview.downloadPdf')}><Download size={14}/></a>
    </div>}
    {error && <p role="alert">{error}</p>}
    {pdf && root && width > 0 && <Virtuoso key={path} customScrollParent={root} totalCount={pdf.numPages}
      defaultItemHeight={width * zoom * 1.414} increaseViewportBy={{ top: 400, bottom: 600 }}
      itemContent={index => <div className="inspector-pdf-page-slot"><PdfPage pdf={pdf} number={index + 1} width={width * zoom}/></div>} />}
  </div>;
}
