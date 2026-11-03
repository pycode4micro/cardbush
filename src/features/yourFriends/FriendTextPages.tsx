import { useLayoutEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { uiText } from '../../i18n';

/** Paginate against the available space, preserving the original text in full. */
export function FriendTextPages({ text, language }: { text: string; language: string }) {
  const t = uiText(language), viewport = useRef<HTMLDivElement>(null), measure = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState([text]), [page, setPage] = useState(0);
  useLayoutEffect(() => {
    const box = viewport.current!, probe = measure.current!;
    const characters = Array.from(new Intl.Segmenter(language, { granularity: 'grapheme' }).segment(text), item => item.segment);
    let frame = 0;
    const paginate = () => {
      if (!box.clientWidth || !box.clientHeight) return;
      const next: string[] = [];
      let start = 0;
      while (start < characters.length) {
        let low = start + 1, high = characters.length, end = low;
        while (low <= high) {
          const middle = Math.floor((low + high) / 2);
          probe.textContent = characters.slice(start, middle).join('');
          if (probe.getBoundingClientRect().height <= box.clientHeight) { end = middle; low = middle + 1; }
          else high = middle - 1;
        }
        next.push(characters.slice(start, end).join('')); start = end;
      }
      probe.textContent = '';
      setPages(next.length ? next : ['']);
      setPage(current => Math.min(current, Math.max(0, next.length - 1)));
    };
    setPage(0); paginate();
    const observer = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(paginate); });
    observer.observe(box);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [text, language]);
  const number = new Intl.NumberFormat(language);
  return <div className="friends-text-pages">
    <div className="friends-text-viewport" ref={viewport}>
      <div className="friends-page-text" aria-live="polite">{pages[page] ?? ''}</div>
      <div className="friends-page-measure" ref={measure} aria-hidden="true"/>
    </div>
    <nav className="friends-page-navigation" aria-label={t('yourFriends.textPages')} data-multiple={pages.length > 1}>
      <button type="button" className="friends-icon" disabled={page === 0} aria-label={t('yourFriends.previousPage')} onClick={() => setPage(value => value - 1)}><ChevronLeft/></button>
      <span>{t('yourFriends.pageProgress', { current: number.format(page + 1), total: number.format(pages.length) })}</span>
      <button type="button" className="friends-icon" disabled={page >= pages.length - 1} aria-label={t('yourFriends.nextPage')} onClick={() => setPage(value => value + 1)}><ChevronRight/></button>
    </nav>
  </div>;
}
