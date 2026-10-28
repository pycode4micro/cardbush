import { uiText } from '../../i18n';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions, TextLayer, version, type PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { fileUrl } from '../../shared/localPaths';
import { Minus, Plus, Download } from 'lucide-react';
import type { InspectorFilePreviewProps } from './inspectorFilePreviewRenderers';
import './pdfPreview.css';

GlobalWorkerOptions.workerSrc = workerUrl;

function PdfPage({ pdf, number, width, scrollRoot }: { pdf: PDFDocumentProxy; number: number; width: number; scrollRoot: HTMLDivElement | null }) {
  const root = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null), text = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useState(1.414), [visible, setVisible] = useState(false), [error, setError] = useState(''), [painted, setPainted] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { root: scrollRoot, rootMargin: '600px' });
    if (root.current) observer.observe(root.current);
    return () => observer.disconnect();
  }, [scrollRoot]);
  useEffect(() => {
    if (!visible || !width) return;
    let disposed = false;
    let render: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | undefined;
    let textLayer: TextLayer | undefined;
    setError(''); setPainted(false);
    void pdf.getPage(number).then(async page => {
      if (disposed || !canvas.current || !text.current) return;
      const natural = page.getViewport({ scale: 1 });
      setRatio(natural.height / natural.width);
      const viewport = page.getViewport({ scale: width / natural.width });
      const scale = Math.min(devicePixelRatio || 1, 2, Math.sqrt(8_000_000 / (viewport.width * viewport.height)));
      const target = canvas.current;
      target.width = Math.ceil(viewport.width * scale); target.height = Math.ceil(viewport.height * scale);
      text.current.replaceChildren();
      text.current.style.setProperty('--total-scale-factor', String(viewport.scale));
      render = page.render({ canvas: target, viewport, transform: [scale, 0, 0, scale, 0, 0] });
      await Promise.all([render.promise, page.getTextContent().then(async content => {
        if (disposed || !text.current) return;
        textLayer = new TextLayer({ textContentSource: content, container: text.current, viewport });
        await textLayer.render();
      })]);
      if (!disposed) setPainted(true);
    }).catch(cause => { if (!disposed && cause?.name !== 'RenderingCancelledException') setError(String(cause.message ?? cause)); });
    return () => { disposed = true; render?.cancel(); textLayer?.cancel(); };
  }, [pdf, number, width, visible]);
  return <div ref={root} className="inspector-pdf-page" data-region-page={number} data-region-loading={!painted || !visible || undefined} style={{ width, height: width * ratio }}>
    {visible && <><canvas ref={canvas}/><div ref={text} className="pdf-region-text"/></>}
    {error && <p role="alert">{error}</p>}
    <span className="inspector-pdf-page-number" data-region-ui>{number}</span>
  </div>;
}

export default function PdfInspectorPreview({ path, source, language, onLoadingChange }: InspectorFilePreviewProps) {
  const [pdf, setPdf] = useState<PDFDocumentProxy>(), [error, setError] = useState('');
  const [root, setRoot] = useState<HTMLDivElement | null>(null), [width, setWidth] = useState(0);
  const [zoom, setZoom] = useState(1);
  useEffect(() => { root?.dispatchEvent(new Event('cardbush-preview-layout', { bubbles: true })); }, [root, zoom]);
  useLayoutEffect(() => {
    if (!root) return;
    const observer = new ResizeObserver(() => setWidth(Math.max(80, root.clientWidth - 32)));
    observer.observe(root); return () => observer.disconnect();
  }, [root]);
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
    {pdf && Array.from({ length: pdf.numPages }, (_, index) => <PdfPage key={index} pdf={pdf} number={index + 1} width={width * zoom} scrollRoot={root}/>)}
  </div>;
}
