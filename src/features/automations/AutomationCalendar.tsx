import { useEffect, useMemo, useRef, useState, type ReactNode, type KeyboardEvent } from 'react';
import { CalendarClock, ChevronDown, ChevronRight } from 'lucide-react';
import type { AutomationJob } from '@cardbush/bush-protocol';
import { chineseDate } from '../../../assets/skills/cardbush-docs/scripts/calendar-date.mjs';
import { CalendarDataControls, useCalendarData } from './CalendarDataControls';
import { CalendarDatePicker, type CalendarView } from './CalendarDatePicker';
import { calendarDayKey, calendarEntriesForDays, calendarMonthDays, calendarQueryMatches, calendarYearDays, importedEntriesForDays, matchingCalendarDates, compactAutomationText, localDay, shiftCalendarDay, shiftCalendarMonth, type AutomationCalendarEntry } from './automationCalendarModel';

const fromKey = (key: string) => new Date(`${key}T12:00:00`);
export function AutomationCalendar({ jobs, language, renderJob, onShowPlans, query = '' }: {
  jobs: AutomationJob[]; language: 'zh' | 'en'; renderJob: (job: AutomationJob, entry: AutomationCalendarEntry) => ReactNode;
  onShowPlans: () => void; query?: string;
}) {
  const zh = language === 'zh', locale = zh ? 'zh-CN' : 'en-US', filter = query.trim();
  const [selected, setSelected] = useState(() => localDay(new Date())), [view, setView] = useState<CalendarView>('month');
  const [now, setNow] = useState(Date.now), [dateLimit, setDateLimit] = useState(48);
  const [agendaLimit, setAgendaLimit] = useState(100);
  const data = useCalendarData();
  const selectedKey = calendarDayKey(selected), todayKey = calendarDayKey(new Date(now));
  const dayButtons = useRef(new Map<string, HTMLButtonElement>()), focusDay = useRef(false), previousQuery = useRef('');
  const dateQuery = /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(filter) ? filter : '';
  const filteredJobs = useMemo(() => jobs.filter(job => !filter || dateQuery || calendarQueryMatches(`${job.name} ${job.prompt}`, filter)), [jobs, filter, dateQuery]);
  const calendars = useMemo(() => data.state.datasets.filter(item => item.enabled).map(({ calendar }) => ({ ...calendar,
    entries: calendar.entries.filter(entry => !filter || dateQuery || calendarQueryMatches(`${calendar.name} ${entry.title} ${entry.description ?? ''}`, filter)),
  })), [data.state.datasets, filter, dateQuery]);
  const selectedYear = selected.getFullYear();
  const matches = useMemo(() => filter ? matchingCalendarDates(filteredJobs, calendars, dateQuery ? Number(dateQuery.slice(0, 4)) : selectedYear, now)
    .filter(key => !dateQuery || key.startsWith(dateQuery)) : [], [filteredJobs, calendars, filter, dateQuery, selectedYear, now]);
  useEffect(() => {
    if (previousQuery.current === filter && (!filter || !matches.length || matches.includes(selectedKey))) return;
    previousQuery.current = filter; setDateLimit(48);
    if (filter && matches.length) setSelected(localDay(fromKey(matches.find(key => key >= todayKey) ?? matches[0])));
  }, [filter, matches, todayKey, selectedKey]);
  useEffect(() => {
    const update = () => setNow(Date.now());
    const timer = window.setInterval(update, 30000); window.addEventListener('focus', update);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', update); };
  }, []);
  useEffect(() => { if (focusDay.current) { dayButtons.current.get(selectedKey)?.focus(); focusDay.current = false; } }, [selectedKey, view]);
  const days = useMemo(() => view === 'year' ? calendarYearDays(selected.getFullYear()) : view === 'day' ? [selected] : calendarMonthDays(selected), [selected, view]);
  const entries = useMemo(() => calendarEntriesForDays(filteredJobs, days, now), [days, filteredJobs, now]);
  const imported = useMemo(() => importedEntriesForDays(calendars, days, '', view === 'month' ? 1 : 0), [calendars, days, view]);
  const selectedImports = useMemo(() => view === 'year' ? undefined : importedEntriesForDays(calendars, [selected], '', agendaLimit).get(selectedKey), [calendars, selected, selectedKey, agendaLimit, view]);
  useEffect(() => setAgendaLimit(100), [selectedKey, filter]);
  const count = (key: string) => (entries.get(key)?.length ?? 0) + (imported.get(key)?.count ?? 0);
  const selectedEntries = entries.get(selectedKey) ?? [], selectedImported = selectedImports?.items ?? [];
  const eventPlans = filteredJobs.filter(job => job.state === 'active' && job.trigger.kind === 'event').length;
  const lunar = (key: string) => data.state.chineseLunar && key >= '1900-01-01' && key <= '2199-12-31' ? chineseDate(key) : undefined;
  const move = (amount: number) => {
    if (filter) {
      const current = view === 'year' ? selectedKey.slice(0, 4) : view === 'month' ? selectedKey.slice(0, 7) : selectedKey;
      const adjacent = dateQuery ? matches : [...new Set([...matches, ...matchingCalendarDates(filteredJobs, calendars, selectedYear + amount, now)])].sort();
      const next = (amount > 0 ? adjacent : [...adjacent].reverse()).find(key => amount > 0 ? key.slice(0, current.length) > current : key.slice(0, current.length) < current);
      if (next) { setSelected(localDay(fromKey(next))); setDateLimit(48); return; }
      return;
    }
    setSelected(value => view === 'day' ? shiftCalendarDay(value, amount) : shiftCalendarMonth(value, amount * (view === 'year' ? 12 : 1))); setDateLimit(48);
  };
  const keyDown = (event: KeyboardEvent<HTMLButtonElement>, day: Date) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    let next: Date;
    if (filter && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      const index = matches.indexOf(calendarDayKey(day)), delta = ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1;
      const target = matches[index + delta]; if (!target) return; next = localDay(fromKey(target));
    } else if (filter && ['Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) {
      const target = event.key === 'Home' || event.key === 'PageUp' ? matches[0] : matches.at(-1);
      if (!target) return; next = localDay(fromKey(target));
    } else if (event.key === 'ArrowLeft') next = shiftCalendarDay(day, -1);
    else if (event.key === 'ArrowRight') next = shiftCalendarDay(day, 1);
    else if (event.key === 'ArrowUp') next = shiftCalendarDay(day, -7);
    else if (event.key === 'ArrowDown') next = shiftCalendarDay(day, 7);
    else if (event.key === 'Home') next = shiftCalendarDay(day, -((day.getDay() + 6) % 7));
    else if (event.key === 'End') next = shiftCalendarDay(day, 6 - ((day.getDay() + 6) % 7));
    else if (event.key === 'PageUp') next = shiftCalendarMonth(day, -1);
    else if (event.key === 'PageDown') next = shiftCalendarMonth(day, 1);
    else return;
    event.preventDefault(); focusDay.current = true; setSelected(next);
  };
  const dayButton = (day: Date, sparse = false) => {
    const key = calendarDayKey(day), items = entries.get(key) ?? [], notes = imported.get(key)?.items ?? [], lunarDate = lunar(key);
    const dateLabel = day.toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
    return <button type="button" className="automation-calendar-date" key={key} data-date={key} data-outside={!sparse && day.getMonth() !== selected.getMonth()}
      data-selected={key === selectedKey} data-today={key === todayKey} tabIndex={key === selectedKey || sparse ? 0 : -1}
      ref={node => { if (node) dayButtons.current.set(key, node); else dayButtons.current.delete(key); }}
      aria-current={key === todayKey ? 'date' : undefined} aria-label={`${dateLabel} · ${count(key)} ${zh ? '项安排' : 'items'}${lunarDate ? ` · ${lunarDate.fullLabel}` : ''}`}
      onClick={() => setSelected(localDay(day))} onKeyDown={event => keyDown(event, day)}>
      <span className="automation-calendar-date-number">{sparse ? day.toLocaleDateString(locale, { month: 'numeric', day: 'numeric' }) : day.getDate()}</span>
      {lunarDate && <span className="calendar-lunar-date" title={lunarDate.fullLabel}>{lunarDate.label}</span>}
      <span className="automation-calendar-date-items" aria-hidden="true">
        {items.slice(0, 1).map(item => <span className="automation-calendar-chip" data-recorded={item.scheduledCount === 0} key={item.job.id}>{compactAutomationText(item.job.name)}</span>)}
        {notes.slice(0, items.length ? 0 : 1).map(({ calendar, entry }) => <span className="automation-calendar-chip calendar-import-chip" key={`${calendar.id}:${entry.id}`}>{compactAutomationText(entry.title)}</span>)}
        {count(key) > 1 && <span className="automation-calendar-more">+{count(key) - 1}</span>}
      </span>
      {count(key) > 0 && <span className="automation-calendar-marker" aria-hidden="true"><i/>{count(key) > 1 && <small>{count(key)}</small>}</span>}
    </button>;
  };
  const agenda = <section className="automation-calendar-agenda" aria-label={zh ? '当天安排' : 'Selected day schedule'}>
    <header className="automation-agenda-heading"><div><h2 aria-live="polite">{selected.toLocaleDateString(locale, { month: 'long', day: 'numeric', weekday: 'short' })}</h2>{lunar(selectedKey) && <small>{lunar(selectedKey)!.fullLabel}</small>}</div><span>{count(selectedKey)} {zh ? '项安排' : 'items'}</span></header>
    <div className="automation-agenda-list" key={selectedKey}>
      {selectedEntries.map(entry => renderJob(entry.job, entry))}
      {selectedImported.map(({ calendar, entry }) => <details className="calendar-import-entry" key={`${calendar.id}:${entry.id}`}>
        <summary><time>{entry.date !== selectedKey ? (zh ? '跨日' : 'Ongoing') : entry.time || (zh ? '全天' : 'All day')}</time><strong>{entry.title}</strong><span>{calendar.name}</span><ChevronDown size={12}/></summary>
        <div><p>{zh ? { event: '日程', holiday: '节假日', workday: '工作日', note: '日期备注' }[entry.kind] : entry.kind}{entry.description && ` · ${entry.description}`}</p><small>{entry.date}{entry.endDate && ` – ${entry.endDate} (${zh ? '结束日不含' : 'exclusive end'})`} · {calendar.timeZone}{calendar.source && ` · ${calendar.source}`}</small></div>
      </details>)}
      {(selectedImports?.count ?? 0) > agendaLimit && <div className="automation-actions"><button type="button" onClick={() => setAgendaLimit(limit => limit + 100)}>{zh ? '显示更多日历条目' : 'Show more calendar entries'}</button></div>}
      {!count(selectedKey) && <div className="automation-calendar-empty"><CalendarClock size={22}/><p>{filter ? (zh ? '这一天没有匹配的安排' : 'No matching items') : (zh ? '这一天没有安排' : 'Nothing scheduled')}</p></div>}
    </div>
  </section>;
  const periodMatches = matches.filter(key => key.startsWith(selectedKey.slice(0, 7)));
  const title = selected.toLocaleDateString(locale, view === 'day' ? { year: 'numeric', month: 'long', day: 'numeric' } : view === 'month' ? { year: 'numeric', month: 'long' } : { year: 'numeric' });
  const selectPeriod = (date: Date, mode: CalendarView) => {
    let next = localDay(date);
    if (filter) {
      const prefix = calendarDayKey(date).slice(0, mode === 'year' ? 4 : mode === 'month' ? 7 : 10);
      const candidates = matchingCalendarDates(filteredJobs, calendars, date.getFullYear(), now).filter(key => key.startsWith(prefix) && (!dateQuery || key.startsWith(dateQuery)));
      const match = candidates.find(key => key === calendarDayKey(date)) ?? candidates[0];
      if (!match) return false;
      next = localDay(fromKey(match));
    }
    setNow(Date.now()); setSelected(next); setView(mode); setDateLimit(48);
    return true;
  };
  return <section className="automation-calendar" data-view={view} data-filtered={Boolean(filter)} aria-label={zh ? '安排日历' : 'Schedule calendar'}>
    <header className="calendar-toolbar">
      <CalendarDatePicker selected={selected} view={view} title={title} zh={zh} onMove={move} onSelect={selectPeriod}/>
      <div className="calendar-view-switch" role="group" aria-label={zh ? '日历范围' : 'Calendar range'}>{(['day', 'month', 'year'] as const).map(mode => <button type="button" key={mode} aria-pressed={view === mode} onClick={() => { setView(mode); setDateLimit(48); }}>{zh ? { day: '日', month: '月', year: '年' }[mode] : { day: 'Day', month: 'Month', year: 'Year' }[mode]}</button>)}</div>
    </header>
    {filter && <div className="calendar-search-hint">{zh ? '只显示匹配日期' : 'Matching dates only'}{!matches.length && ` · ${zh ? '没有匹配的日期' : 'No matching dates'}`}</div>}
    {view === 'year' ? <div className="calendar-year-grid">{Array.from({ length: 12 }, (_, month) => {
      const monthDate = new Date(selected.getFullYear(), month, 1), prefix = calendarDayKey(monthDate).slice(0, 7);
      const actualDays = days.filter(day => day.getMonth() === month), hits = actualDays.filter(day => count(calendarDayKey(day)) > 0 && (!dateQuery || calendarDayKey(day).startsWith(dateQuery)));
      if (filter && !hits.length) return null;
      return <button type="button" className="calendar-year-month" data-month={prefix} key={month} onClick={() => { setSelected(hits[0] ?? monthDate); setView('month'); }}>
        <strong>{monthDate.toLocaleDateString(locale, { month: 'long' })}<small>{hits.length > 0 && `${hits.length} ${zh ? '天' : 'days'}`}</small></strong>
        <span className={filter ? 'calendar-year-matches' : 'calendar-mini-grid'}>{!filter && Array.from({ length: (monthDate.getDay() + 6) % 7 }, (_, index) => <i key={`empty-${index}`}/>)}
          {(filter ? hits : actualDays).map(day => <span key={calendarDayKey(day)} data-has-items={count(calendarDayKey(day)) > 0} data-today={calendarDayKey(day) === todayKey}>{day.getDate()}</span>)}</span>
      </button>;
    })}</div> : <div className="automation-calendar-layout">
      {view === 'month' && <div className="automation-calendar-month">
        {filter ? <div className="calendar-matching-dates">{periodMatches.slice(0, dateLimit).map(key => dayButton(fromKey(key), true))}{!periodMatches.length && <p className="automation-hint">{zh ? '本月没有匹配日期' : 'No matching dates this month'}</p>}
          {periodMatches.length > dateLimit && <button type="button" onClick={() => setDateLimit(limit => limit + 48)}>{zh ? '更多日期' : 'More dates'}</button>}</div>
          : <div className="automation-calendar-grid" role="grid" aria-label={title}>
            <div className="automation-calendar-weekdays" role="row">{(zh ? ['一', '二', '三', '四', '五', '六', '日'] : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']).map(day => <span role="columnheader" key={day}>{day}</span>)}</div>
            {Array.from({ length: 6 }, (_, week) => <div role="row" className="automation-calendar-week" key={week}>{days.slice(week * 7, week * 7 + 7).map(day => <div role="gridcell" aria-selected={calendarDayKey(day) === selectedKey} key={calendarDayKey(day)}>{dayButton(day)}</div>)}</div>)}
          </div>}
      </div>}
      {(!filter || matches.includes(selectedKey)) && agenda}
    </div>}
    {eventPlans > 0 && <button type="button" className="automation-calendar-events" onClick={onShowPlans}>{zh ? `${eventPlans} 个事件计划，无固定日期` : `${eventPlans} event plans without fixed dates`}<ChevronRight size={14}/></button>}
    <CalendarDataControls data={data} zh={zh}/>
  </section>;
}
