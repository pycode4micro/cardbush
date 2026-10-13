import { useEffect, useMemo, useRef } from 'react';

export type MarkdownSelection = { startLine: number; endLine: number; source: string };
export function markdownSelection(source: string, start: number, end: number): MarkdownSelection {
  const startLine = source.slice(0, start).split('\n').length;
  // A selection ending at the next line's first column belongs to the previous line.
  const endLine = source.slice(0, end > start && source[end - 1] === '\n' ? end - 1 : end).split('\n').length;
  return { startLine, endLine, source };
}
export function MarkdownSourceEditor({ source, onChange, onSelection, readOnly, language }: {
  source: string; onChange: (source: string) => void; onSelection?: (selection: MarkdownSelection) => void; readOnly?: boolean; language: 'zh' | 'en';
}) {
  const gutter = useRef<HTMLPreElement>(null), input = useRef<HTMLTextAreaElement>(null), status = useRef<HTMLOutputElement>(null);
  const selectionCallback = useRef(onSelection); selectionCallback.current = onSelection;
  const numbers = useMemo(() => Array.from({ length: source.split('\n').length }, (_, index) => index + 1).join('\n'), [source]);
  const selected = () => {
    const element = input.current; if (!element) return;
    const selection = markdownSelection(element.value, element.selectionStart, element.selectionEnd);
    if (status.current) status.current.textContent = selection.startLine === selection.endLine ? `Ln ${selection.startLine}` : `Ln ${selection.startLine}–${selection.endLine}`;
    selectionCallback.current?.(selection);
  };
  useEffect(() => {
    const element = input.current;
    // Listen to the textarea itself: React's document-level selection tracking
    // can miss a restored editor or a programmatic line selection.
    element?.addEventListener('select', selected);
    return () => element?.removeEventListener('select', selected);
  }, []);
  return <div className="creation-source-editor">
    <div className="creation-source-heading"><span>{language === 'zh' ? 'Markdown 源码' : 'Markdown source'}</span><output ref={status}>Ln 1</output></div>
    <div className="creation-source-content">
      <pre ref={gutter} className="creation-line-numbers" aria-hidden="true">{numbers}</pre>
      <textarea ref={input} className="md-source creation-source-input" aria-label={language === 'zh' ? 'Markdown 源码' : 'Markdown source'}
        wrap="off" readOnly={readOnly} spellCheck={false} value={source} onChange={event => { onChange(event.target.value); selected(); }} onSelect={selected} onKeyUp={selected} onMouseUp={selected}
        onScroll={event => { if (gutter.current) gutter.current.scrollTop = event.currentTarget.scrollTop; }}/>
    </div>
  </div>;
}
