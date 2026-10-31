import { useEffect, useRef, useState } from 'react';
import { uiText } from '../../i18n';

export function CanvasZoomValue({ zoom, language, onChange }: { zoom: number; language: string; onChange: (zoom: number) => void }) {
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState('');
  const button = useRef<HTMLButtonElement>(null), input = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), finishing = useRef(false);
  const latestChange = useRef(onChange); latestChange.current = onChange;
  const cancelClick = () => { clearTimeout(timer.current); timer.current = undefined; };
  useEffect(() => cancelClick, [zoom]);
  useEffect(() => { if (editing) { input.current?.focus(); input.current?.select(); } }, [editing]);
  const edit = () => { cancelClick(); finishing.current = false; setDraft(String(Math.round(zoom * 100))); setEditing(true); };
  const finish = (save: boolean, restoreFocus = false) => {
    if (finishing.current) return;
    finishing.current = true;
    const value = Number(draft.trim());
    if (save && draft.trim() && Number.isFinite(value)) onChange(value / 100);
    setEditing(false);
    if (restoreFocus) requestAnimationFrame(() => button.current?.focus({ preventScroll: true }));
  };
  const t = uiText(language), percentage = new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: 0 }).format(zoom);
  if (editing) return <label className="canvas-zoom-edit" title={t('canvasStage.zoomEditHint')}>
    <input ref={input} type="number" inputMode="decimal" min={2} max={200} step={1} value={draft}
      aria-label={t('canvasStage.zoomPercent')} onChange={event => setDraft(event.target.value)} onBlur={() => finish(true)}
      onKeyDown={event => {
        if (event.key !== 'Enter' && event.key !== 'Escape') return;
        event.preventDefault(); event.stopPropagation(); finish(event.key === 'Enter', true);
      }}/><span aria-hidden="true">%</span>
  </label>;
  return <button ref={button} type="button" className="canvas-zoom-value" title={t('canvasStage.zoomActions')}
    aria-label={t('canvasStage.zoomValue', { percentage })} onDoubleClick={edit}
    onKeyDown={event => { if (event.key === 'F2') { event.preventDefault(); edit(); } }}
    onClick={event => {
      cancelClick();
      if (event.detail === 0) { onChange(1); return; }
      // Defer a pointer click so the second click can open the editor without
      // resetting its value or moving the canvas first. Keyboard reset is immediate.
      if (event.detail === 1) timer.current = setTimeout(() => { timer.current = undefined; latestChange.current(1); }, 500);
    }}><span>{percentage}</span></button>;
}
