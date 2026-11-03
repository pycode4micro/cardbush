import { Fragment, useLayoutEffect, useMemo, useRef, type RefObject } from 'react';
import { composerCodeRanges } from './composerCodeRanges';
import './composerCodeHighlights.css';

const highlightName = 'cardbush-composer-code';
const richHighlights = new Map<symbol, Range[]>();
function publishRanges(owner: symbol, ranges: Range[]) {
  if (!globalThis.CSS?.highlights || typeof Highlight === 'undefined') return;
  if (ranges.length) richHighlights.set(owner, ranges); else richHighlights.delete(owner);
  if (richHighlights.size) CSS.highlights.set(highlightName, new Highlight(...Array.from(richHighlights.values()).flat()));
  else CSS.highlights.delete(highlightName);
}

/** Paint behind native text, without replacing the editor, changing offsets or touching undo/IME. */
export function useComposerCodeHighlights(value: string, rich: boolean, textarea: RefObject<HTMLTextAreaElement | null>,
  editor: RefObject<HTMLDivElement | null>, locate: (root: HTMLElement, offset: number) => [Node, number]) {
  const ranges = useMemo(() => composerCodeRanges(value), [value]);
  const overlay = useRef<HTMLDivElement>(null), mirror = useRef<HTMLDivElement>(null), owner = useRef(Symbol());
  const measure = useRef<(() => void) | null>(null);
  const visible = !rich && ranges.length > 0;

  useLayoutEffect(() => {
    if (!visible || !textarea.current || !overlay.current || !mirror.current) return;
    const input = textarea.current, layer = overlay.current, text = mirror.current;
    const scroll = () => { text.style.transform = `translate(${-input.scrollLeft}px, ${-input.scrollTop}px)`; };
    const sync = () => {
      const style = getComputedStyle(input);
      // Copy measured typography/geometry, including user font preferences and scrollbar width.
      // Both siblings share the same offset parent, so transforms/zoom do not distort alignment.
      Object.assign(layer.style, { left: `${input.offsetLeft + input.clientLeft}px`, top: `${input.offsetTop + input.clientTop}px`,
        width: `${input.clientWidth}px`, height: `${input.clientHeight}px` });
      for (const key of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontStretch', 'fontVariant', 'fontKerning',
        'fontFeatureSettings', 'fontVariationSettings', 'letterSpacing', 'lineHeight', 'tabSize', 'textAlign', 'textIndent',
        'textTransform', 'direction', 'wordSpacing', 'wordBreak', 'overflowWrap', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'] as const) {
        text.style[key] = style[key];
      }
      scroll();
    };
    measure.current = sync; sync();
    const resize = new ResizeObserver(sync);
    resize.observe(input);
    if (input.parentElement) resize.observe(input.parentElement);
    const appearance = new MutationObserver(sync);
    appearance.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
    const app = input.closest('.app');
    if (app) appearance.observe(app, { attributes: true, attributeFilter: ['class', 'style'] });
    input.addEventListener('scroll', scroll, { passive: true });
    document.fonts.addEventListener('loadingdone', sync);
    return () => { measure.current = null; resize.disconnect(); appearance.disconnect(); input.removeEventListener('scroll', scroll); document.fonts.removeEventListener('loadingdone', sync); };
  }, [visible, textarea]);

  // This hook is called after the reference editor's canonicalization effect.
  // Native highlights preserve its text nodes and the browser's undo/selection history.
  useLayoutEffect(() => {
    measure.current?.();
    const node = editor.current, selections: Range[] = [];
    if (rich && node) {
      for (const item of ranges) {
        const selection = document.createRange();
        selection.setStart(...locate(node, item.start)); selection.setEnd(...locate(node, item.end));
        selections.push(selection);
      }
    }
    publishRanges(owner.current, selections);
  });
  useLayoutEffect(() => { const key = owner.current; return () => publishRanges(key, []); }, []);

  if (!visible) return null;
  return <div className="composer-code-highlights" aria-hidden="true" ref={overlay}><div ref={mirror} className="composer-code-mirror">
    {ranges.map((range, index) => <Fragment key={range.start}>{value.slice(index ? ranges[index - 1].end : 0, range.start)}<mark className="composer-code-mark">{value.slice(range.start, range.end)}</mark></Fragment>)}
    {value.slice(ranges.at(-1)!.end)}{'\u200b'}
  </div></div>;
}
