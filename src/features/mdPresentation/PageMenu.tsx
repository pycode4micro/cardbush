import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Keep secondary page tools out of the writing surface, including in small panels. */
export function PageMenu({ label, trigger, children }: { label: string; trigger: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false), [position, setPosition] = useState({ left: 12, top: 12, maxHeight: 560 });
  const anchor = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null), id = useId();
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!anchor.current || !panel.current) return;
      const at = anchor.current.getBoundingClientRect(), menu = panel.current.getBoundingClientRect();
      const below = innerHeight - at.bottom - 20, above = at.top - 20;
      const down = below >= menu.height || below >= above, maxHeight = Math.max(80, Math.min(560, down ? below : above, innerHeight - 24));
      const height = Math.min(menu.height, maxHeight), top = down ? at.bottom + 8 : at.top - height - 8;
      const next = { left: Math.max(12, Math.min(at.left, innerWidth - menu.width - 12)), top: Math.max(12, Math.min(top, innerHeight - height - 12)), maxHeight };
      setPosition(previous => previous.left === next.left && previous.top === next.top && previous.maxHeight === next.maxHeight ? previous : next);
    };
    place(); panel.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    window.addEventListener('resize', place); window.document.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.document.removeEventListener('scroll', place, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (!anchor.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false); anchor.current?.focus(); }
    };
    window.document.addEventListener('pointerdown', outside); window.document.addEventListener('focusin', outside); window.document.addEventListener('keydown', escape);
    return () => { window.document.removeEventListener('pointerdown', outside); window.document.removeEventListener('focusin', outside); window.document.removeEventListener('keydown', escape); };
  }, [open]);
  const colors = anchor.current && getComputedStyle(anchor.current);
  const palette = { ...Object.fromEntries(['--surface', '--surface-raised', '--surface-hover', '--text', '--text-mid', '--border', '--accent', '--md-accent'].map(name => [name, colors?.getPropertyValue(name)])), colorScheme: colors?.colorScheme, fontFamily: colors?.fontFamily } as CSSProperties;
  return <>
    <button ref={anchor} type="button" className="bush-page-breadcrumb" aria-label={label} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => setOpen(value => !value)} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); } }}>{trigger}</button>
    {open && createPortal(<div ref={panel} id={id} className="bush-page-menu" role="dialog" aria-label={label} style={{ ...palette, ...position }}
      onClick={event => { if ((event.target as Element).closest('button:not(:disabled)')) { setOpen(false); if (panel.current?.contains(window.document.activeElement)) anchor.current?.focus(); } }}
      onKeyDown={event => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        const buttons = [...(panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
        if (!buttons.length) return;
        event.preventDefault(); const index = buttons.indexOf(window.document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length;
        buttons[next]?.focus();
      }}>{children}</div>, window.document.body)}
  </>;
}
