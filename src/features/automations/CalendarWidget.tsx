import { ChevronLeft, ChevronRight, Settings2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDataControls, useCalendarData } from './CalendarDataControls';
import { useCalendarJobs } from './useCalendarJobs';
import { useCalendarDayDetails } from './useCalendarDayDetails';
import { CalendarMonthGrid } from './CalendarMonthGrid';
import { calendarDayKey, calendarEntriesForDays, calendarMonthDays, importedEntriesForDays, localDay, shiftCalendarDay, shiftCalendarMonth } from './automationCalendarModel';

export function CalendarWidget({ language }: { language: 'zh' | 'en' }) {
  const zh = language === 'zh', locale = zh ? 'zh-CN' : 'en-US';
  const [now, setNow] = useState(Date.now), [selected, setSelected] = useState(() => localDay(new Date()));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const data = useCalendarData(), { jobs, error } = useCalendarJobs();
  const days = useMemo(() => calendarMonthDays(selected), [selected]);
  const calendars = useMemo(() => data.state.datasets.filter(item => item.enabled).map(item => item.calendar), [data.state.datasets]);
  const entries = useMemo(() => calendarEntriesForDays(jobs, days, now), [jobs, days, now]);
  const notes = useMemo(() => importedEntriesForDays(calendars, days, '', 0), [calendars, days]);
  const details = useCalendarDayDetails({ jobs, calendars, now, chineseLunar: data.state.chineseLunar, language });
  const today = calendarDayKey(new Date(now)), selectedKey = calendarDayKey(selected), buttons = useRef(new Map<string, HTMLButtonElement>()), focus = useRef(false);
  useEffect(() => {
    const tick = () => setNow(Date.now()), timer = setInterval(tick, 30000);
    window.addEventListener('focus', tick); document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(timer); window.removeEventListener('focus', tick); document.removeEventListener('visibilitychange', tick); };
  }, []);
  useEffect(() => { if (focus.current) { buttons.current.get(selectedKey)?.focus(); focus.current = false; } }, [selectedKey]);
  const move = (month: number) => { details.close(); setSelected(date => shiftCalendarMonth(date, month)); };
  return <div className="builtin-calendar calendar-surface">
    <div className="builtin-calendar-heading calendar-month-heading">
      <strong aria-live="polite">{selected.toLocaleDateString(locale, { year: 'numeric', month: 'long' })}</strong>
      <div>
        <button type="button" aria-label={zh ? '上个月' : 'Previous month'} onClick={() => move(-1)}><ChevronLeft size={14}/></button>
        <button type="button" onClick={() => { details.close(); setNow(Date.now()); setSelected(localDay(new Date())); }}>{zh ? '今天' : 'Today'}</button>
        <button type="button" aria-label={zh ? '下个月' : 'Next month'} onClick={() => move(1)}><ChevronRight size={14}/></button>
        <button type="button" aria-label={zh ? '日历设置' : 'Calendar settings'} title={zh ? '日历设置' : 'Calendar settings'} onClick={() => { details.close(); setSettingsOpen(true); }}><Settings2 size={14}/></button>
      </div>
    </div>
    <CalendarMonthGrid className="builtin-calendar-grid" days={days} month={selected.getMonth()} language={language} renderDay={day => {
      const key = calendarDayKey(day), handlers = details.dayProps(day), count = (entries.get(key)?.length ?? 0) + (notes.get(key)?.count ?? 0);
      return <button type="button" className="calendar-day-button" data-date={key} data-selected={key === selectedKey} aria-current={key === today ? 'date' : undefined}
        tabIndex={key === selectedKey ? 0 : -1} aria-label={`${day.toLocaleDateString(locale, { month: 'long', day: 'numeric', weekday: 'long' })} · ${count} ${zh ? '项安排' : 'items'}`}
        ref={node => { if (node) buttons.current.set(key, node); else buttons.current.delete(key); }} {...handlers}
        onClick={event => { setSelected(localDay(day)); handlers.onClick(event); }} onKeyDown={event => {
          if (event.altKey || event.ctrlKey || event.metaKey) return;
          const offset = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -((day.getDay() + 6) % 7), End: 6 - ((day.getDay() + 6) % 7) } as Record<string, number>)[event.key];
          const next = offset !== undefined ? shiftCalendarDay(day, offset) : event.key === 'PageUp' ? shiftCalendarMonth(day, -1) : event.key === 'PageDown' ? shiftCalendarMonth(day, 1) : null;
          if (next) { event.preventDefault(); details.close(); focus.current = true; setSelected(next); }
        }}><span className="calendar-day-number">{day.getDate()}</span>{count > 0 && <i className="calendar-day-dot" aria-hidden="true"/>}</button>;
    }}/>
    {(error || data.error) && <small className="calendar-widget-error" role="status">{zh ? '部分日程暂时无法读取' : 'Some schedules are unavailable'}</small>}
    {details.popover}
    {settingsOpen && <CalendarSettings data={data} zh={zh} onClose={() => setSettingsOpen(false)}/>}
  </div>;
}

function CalendarSettings({ data, zh, onClose }: { data: ReturnType<typeof useCalendarData>; zh: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  return <dialog ref={dialog} className="calendar-settings-dialog" aria-label={zh ? '日历设置' : 'Calendar settings'} onCancel={onClose}>
    <header><strong>{zh ? '日历设置' : 'Calendar settings'}</strong><button type="button" aria-label={zh ? '关闭' : 'Close'} onClick={onClose}><X size={16}/></button></header>
    <CalendarDataControls data={data} zh={zh} expanded/>
  </dialog>;
}
