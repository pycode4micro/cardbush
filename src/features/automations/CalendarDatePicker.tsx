import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { calendarDayKey, calendarMonthDays, localDay, shiftCalendarMonth } from './automationCalendarModel';

export type CalendarView = 'day' | 'month' | 'year';
const firstYear = 1900, lastYear = 2199;
const supported = (date: Date) => date.getFullYear() >= firstYear && date.getFullYear() <= lastYear;
const inYear = (date: Date, year: number) => shiftCalendarMonth(date, (year - date.getFullYear()) * 12);

export function CalendarDatePicker({ selected, view, title, zh, onMove, onSelect }: {
  selected: Date; view: CalendarView; title: string; zh: boolean;
  onMove: (direction: number) => void;
  onSelect: (date: Date, view: CalendarView) => boolean;
}) {
  const id = useId(), panel = useRef<HTMLDivElement>(null), anchor = useRef<HTMLButtonElement>(null);
  const focusOnOpen = useRef(false);
  const [open, setOpen] = useState(false), [mode, setMode] = useState<CalendarView>(view);
  const [cursor, setCursor] = useState(selected), [yearText, setYearText] = useState(String(selected.getFullYear()));
  const [error, setError] = useState('');
  const locale = zh ? 'zh-CN' : 'en-US', cursorYear = cursor.getFullYear(), decade = Math.floor(cursorYear / 10) * 10;
  const selectedKey = calendarDayKey(selected), todayKey = calendarDayKey(new Date());
  const yearValid = /^\d{4}$/.test(yearText) && Number(yearText) >= firstYear && Number(yearText) <= lastYear;
  const close = (restoreFocus = false) => {
    panel.current?.hidePopover(); setOpen(false);
    if (restoreFocus) anchor.current?.focus({ preventScroll: true });
  };
  const show = (button: HTMLButtonElement) => {
    if (open && anchor.current === button) { close(true); return; }
    anchor.current = button;
    const date = inYear(selected, Math.max(firstYear, Math.min(lastYear, selected.getFullYear())));
    setCursor(date); setYearText(String(date.getFullYear())); setMode(view); setError('');
    focusOnOpen.current = true; setOpen(true);
  };
  const browse = (date: Date) => {
    if (!supported(date)) return;
    setCursor(date); setYearText(String(date.getFullYear())); setError('');
  };
  const choose = (date: Date, nextView = mode) => {
    if (!onSelect(localDay(date), nextView)) {
      setError(zh ? '这个日期范围内没有匹配的安排。可换一个日期或调整搜索内容。' : 'No matching items in this period. Choose another date or adjust the search.');
      return;
    }
    close(true);
  };
  const shifted = (direction: number) => shiftCalendarMonth(cursor, direction * (mode === 'day' ? 1 : mode === 'month' ? 12 : 120));

  useLayoutEffect(() => {
    if (!open || !panel.current || !anchor.current) return;
    const node = panel.current, bounds = anchor.current.getBoundingClientRect(), margin = 12, gap = 6;
    const width = Math.min(312, window.innerWidth - margin * 2);
    Object.assign(node.style, { width: `${width}px`, maxHeight: `${window.innerHeight - margin * 2}px` });
    if (!node.matches(':popover-open')) node.showPopover();
    const height = node.getBoundingClientRect().height;
    const below = bounds.bottom + gap;
    const above = bounds.top - height - gap;
    Object.assign(node.style, {
      left: `${Math.max(margin, Math.min(bounds.left, window.innerWidth - width - margin))}px`,
      top: `${Math.max(margin, Math.min(below + height <= window.innerHeight - margin || above < margin ? below : above, window.innerHeight - height - margin))}px`,
    });
    if (focusOnOpen.current) {
      focusOnOpen.current = false;
      (node.querySelector<HTMLElement>('.calendar-picker-cell[data-current=true]:not(:disabled)') ?? node.querySelector<HTMLElement>('input'))?.focus({ preventScroll: true });
    }
  }, [open, mode, cursorYear, cursor.getMonth(), error]);
  useEffect(() => {
    const node = panel.current;
    const sync = (event: Event) => { if ((event as ToggleEvent).newState === 'closed' && !node?.matches(':popover-open')) setOpen(false); };
    node?.addEventListener('toggle', sync);
    return () => node?.removeEventListener('toggle', sync);
  }, []);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: Event) => { if (!panel.current?.contains(event.target as Node)) close(); };
    window.addEventListener('resize', dismiss); document.addEventListener('scroll', dismiss, true);
    return () => { window.removeEventListener('resize', dismiss); document.removeEventListener('scroll', dismiss, true); };
  }, [open]);
  const gridKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('.calendar-picker-cell'));
    const index = buttons.indexOf(event.target as HTMLButtonElement), columns = mode === 'day' ? 7 : 3;
    if (index < 0) return;
    const offset = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns } as Record<string, number>)[event.key];
    let next = offset === undefined ? index : index + offset;
    if (event.key === 'Home') next = Math.floor(index / columns) * columns;
    else if (event.key === 'End') next = Math.min(buttons.length - 1, Math.floor(index / columns) * columns + columns - 1);
    else if (offset === undefined) return;
    event.preventDefault();
    if (buttons[next] && !buttons[next].disabled) buttons[next].focus();
  };
  const commonTrigger = { 'aria-haspopup': 'dialog' as const, 'aria-expanded': open, 'aria-controls': id };
  const todayAllowed = supported(new Date());
  return <div className="automation-calendar-heading">
    <div className="automation-calendar-controls" role="group" aria-label={zh ? '日期导航' : 'Date navigation'}>
      <button type="button" aria-label={zh ? { day: '上一天', month: '上个月', year: '上一年' }[view] : `Previous ${view}`} onClick={() => onMove(-1)}><ChevronLeft size={16}/></button>
      <h2 aria-live="polite"><button type="button" className="calendar-period-title" data-date-picker-trigger="title" {...commonTrigger}
        aria-label={zh ? `选择日期范围，${title}` : `Choose date range, ${title}`} onClick={event => show(event.currentTarget)}>{title}<ChevronDown size={13}/></button></h2>
      <button type="button" aria-label={zh ? { day: '下一天', month: '下个月', year: '下一年' }[view] : `Next ${view}`} onClick={() => onMove(1)}><ChevronRight size={16}/></button>
    </div>
    <div id={id} ref={panel} popover="auto" className="calendar-date-picker" role="dialog" aria-label={zh ? '选择日期范围' : 'Choose date range'}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); } }}
      onBlur={event => { if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) close(); }}>
      <header className="calendar-picker-heading"><strong>{zh ? '选择日期范围' : 'Choose date range'}</strong><button type="button" aria-label={zh ? '关闭日期选择器' : 'Close date picker'} onClick={() => close(true)}><X size={15}/></button></header>
      <div className="calendar-view-switch calendar-picker-modes" role="group" aria-label={zh ? '选择范围类型' : 'Period type'}>{(['day', 'month', 'year'] as const).map(value => <button type="button" data-picker-mode={value} key={value} aria-pressed={mode === value} onClick={() => { setMode(value); setError(''); }}>{zh ? { day: '日', month: '月', year: '年' }[value] : { day: 'Day', month: 'Month', year: 'Year' }[value]}</button>)}</div>
      <div className="calendar-picker-navigation">
        <button type="button" data-picker-step="previous" disabled={!supported(shifted(-1))} aria-label={zh ? (mode === 'day' ? '上个月' : mode === 'month' ? '上一年' : '上十年') : 'Previous period'} onClick={() => browse(shifted(-1))}><ChevronLeft size={16}/></button>
        <label><span>{zh ? '年份' : 'Year'}</span><input type="number" inputMode="numeric" min={firstYear} max={lastYear} aria-label={zh ? '年份' : 'Year'} aria-invalid={!yearValid} value={yearText}
          onChange={event => { const value = event.target.value; setYearText(value); setError(''); if (/^\d{4}$/.test(value) && Number(value) >= firstYear && Number(value) <= lastYear) setCursor(inYear(cursor, Number(value))); }}
          onBlur={() => { if (!yearValid) setYearText(String(cursorYear)); }} onKeyDown={event => { if (event.key === 'Enter' && yearValid) { event.preventDefault(); choose(inYear(cursor, Number(yearText))); } }}/></label>
        <span className="calendar-picker-period">{mode === 'day' ? cursor.toLocaleDateString(locale, { month: 'long' }) : mode === 'year' ? `${decade}–${decade + 9}` : ''}</span>
        <button type="button" data-picker-step="next" disabled={!supported(shifted(1))} aria-label={zh ? (mode === 'day' ? '下个月' : mode === 'month' ? '下一年' : '下十年') : 'Next period'} onClick={() => browse(shifted(1))}><ChevronRight size={16}/></button>
      </div>
      {mode === 'day' && <div className="calendar-picker-weekdays" aria-hidden="true">{(zh ? ['一', '二', '三', '四', '五', '六', '日'] : ['M', 'T', 'W', 'T', 'F', 'S', 'S']).map((label, index) => <span key={index}>{label}</span>)}</div>}
      <div className="calendar-picker-grid" data-mode={mode} onKeyDown={gridKeys}>
        {mode === 'day' ? calendarMonthDays(cursor).map(date => {
          const key = calendarDayKey(date), current = key === selectedKey;
          return <button type="button" className="calendar-picker-cell" key={key} data-picker-date={key} data-current={current} data-outside={date.getMonth() !== cursor.getMonth()} data-today={key === todayKey}
            aria-pressed={current} aria-current={key === todayKey ? 'date' : undefined} aria-label={date.toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' })} disabled={!supported(date)}
            tabIndex={date.getDate() === cursor.getDate() && date.getMonth() === cursor.getMonth() ? 0 : -1} onClick={() => choose(date)}>{date.getDate()}</button>;
        }) : (mode === 'month' ? Array.from({ length: 12 }, (_, month) => shiftCalendarMonth(cursor, month - cursor.getMonth())) : Array.from({ length: 12 }, (_, index) => inYear(cursor, decade + index - 1))).map(date => {
          const key = mode === 'month' ? calendarDayKey(date).slice(0, 7) : String(date.getFullYear());
          const current = mode === 'month' ? selectedKey.startsWith(key) : date.getFullYear() === selected.getFullYear();
          return <button type="button" className="calendar-picker-cell" key={key} data-picker-period={key} data-current={current} data-outside={mode === 'year' && Math.floor(date.getFullYear() / 10) * 10 !== decade}
            aria-pressed={current} disabled={!supported(date)} tabIndex={mode === 'month' ? (date.getMonth() === cursor.getMonth() ? 0 : -1) : (date.getFullYear() === cursorYear ? 0 : -1)} onClick={() => choose(date)}>{mode === 'month' ? date.toLocaleDateString(locale, { month: 'short' }) : date.getFullYear()}</button>;
        })}
      </div>
      {error && <p className="calendar-picker-error" role="alert">{error}</p>}
      <footer className="calendar-picker-footer"><button type="button" disabled={!todayAllowed} onClick={() => choose(new Date())}>{zh ? '回到今天' : 'Go to today'}</button><button type="button" onClick={() => close(true)}>{zh ? '取消' : 'Cancel'}</button></footer>
    </div>
  </div>;
}
