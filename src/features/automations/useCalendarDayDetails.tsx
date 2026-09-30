import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type FocusEvent } from 'react';
import type { AutomationJob, CalendarDataset } from '@cardbush/bush-protocol';
import { chineseDate } from '../../../assets/skills/cardbush-docs/scripts/calendar-date.mjs';
import { calendarDayKey, calendarEntriesForDays, importedEntriesForDays } from './automationCalendarModel';
import { prefersReducedMotion } from '../../shared/motionPreference';
import './calendarSurface.css';

export function useCalendarDayDetails({ jobs, calendars, chineseLunar, now, language }: {
  jobs: AutomationJob[]; calendars: CalendarDataset[]; chineseLunar: boolean; now: number; language: 'zh' | 'en';
}) {
  const id = useId(), panel = useRef<HTMLDivElement>(null), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const restoringFocus = useRef(false);
  const [active, setActive] = useState<{ date: Date; anchor: HTMLElement; pinned: boolean; closing?: boolean } | null>(null);
  const [limit, setLimit] = useState(30);
  const zh = language === 'zh', key = active ? calendarDayKey(active.date) : '';
  const clearTimer = () => { clearTimeout(timer.current); timer.current = undefined; };
  const dismiss = (current: typeof active) => !current || prefersReducedMotion() ? null : { ...current, closing: true };
  const close = () => { clearTimer(); setActive(dismiss); };
  const leave = () => { clearTimer(); timer.current = setTimeout(() => setActive(current => current?.pinned ? current : dismiss(current)), 140); };
  const keepOpen = () => { clearTimer(); setActive(current => current?.closing ? { ...current, closing: false } : current); };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!active?.closing) return;
    const exit = setTimeout(() => setActive(current => current?.closing ? null : current), 120);
    return () => clearTimeout(exit);
  }, [active?.closing]);
  useEffect(() => { setLimit(30); }, [key]);
  const entries = useMemo(() => active ? calendarEntriesForDays(jobs, [active.date], now).get(key) ?? [] : [], [jobs, key, now]);
  const imported = useMemo(() => active ? importedEntriesForDays(calendars, [active.date], '', limit).get(key) : undefined, [calendars, key, limit]);
  const lunar = chineseLunar && key >= '1900-01-01' && key <= '2199-12-31' ? chineseDate(key) : undefined;
  useLayoutEffect(() => {
    const element = panel.current; if (!active || !element) return;
    // Native top layer keeps the details visible even inside clipped widget slots.
    element.showPopover();
    const place = () => {
      const rect = active.anchor.getBoundingClientRect(), bounds = element.getBoundingClientRect();
      const scaleX = bounds.width / (element.offsetWidth || 1) || 1, scaleY = bounds.height / (element.offsetHeight || 1) || 1;
      const width = Math.min(300, (window.innerWidth - 24) / scaleX);
      element.style.width = `${width}px`;
      const above = rect.top - 10, below = window.innerHeight - rect.bottom - 10;
      const contentHeight = (element.querySelector<HTMLElement>('.calendar-day-details-content')?.scrollHeight ?? 0) + 76;
      const height = Math.min(300, window.innerHeight * .6 / scaleY, contentHeight);
      const useBelow = below >= height * scaleY || below >= above;
      element.dataset.side = useBelow ? 'below' : 'above';
      element.style.maxHeight = `${Math.min(height, Math.max(0, (useBelow ? below : above) - 12) / scaleY)}px`;
      element.style.left = `${Math.max(12, Math.min(window.innerWidth - width * scaleX - 12, rect.left + rect.width / 2 - width * scaleX / 2)) / scaleX}px`;
      element.style.top = `${Math.max(12, useBelow ? rect.bottom + 8 : rect.top - element.getBoundingClientRect().height - 8) / scaleY}px`;
    };
    place(); const observer = new ResizeObserver(place); observer.observe(element);
    const hide = () => close();
    const scroll = (event: Event) => { if (!element.contains(event.target as Node)) hide(); };
    const outside = (event: PointerEvent) => { if (!element.contains(event.target as Node) && !active.anchor.contains(event.target as Node)) hide(); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && element.dataset.closing !== 'true') { event.preventDefault(); event.stopPropagation(); close(); restoringFocus.current = true;
      active.anchor.focus({ preventScroll: true }); queueMicrotask(() => { restoringFocus.current = false; }); } };
    window.addEventListener('resize', hide); window.addEventListener('blur', hide); document.addEventListener('scroll', scroll, true);
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape, true);
    return () => { observer.disconnect(); if (element.matches(':popover-open')) element.hidePopover();
      window.removeEventListener('resize', hide); window.removeEventListener('blur', hide); document.removeEventListener('scroll', scroll, true);
      document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true); };
  }, [active?.anchor]);
  const dayProps = (date: Date) => ({
    'aria-haspopup': 'dialog' as const, 'aria-expanded': !active?.closing && key === calendarDayKey(date), 'aria-controls': key === calendarDayKey(date) ? id : undefined,
    onMouseOver: (event: MouseEvent<HTMLElement>) => {
      const anchor = event.currentTarget;
      if (event.relatedTarget instanceof Node && anchor.contains(event.relatedTarget)) return;
      clearTimer();
      if (active?.anchor === anchor) { keepOpen(); return; }
      // Only deliberate hovering opens details; moving across the month stays quiet.
      timer.current = setTimeout(() => setActive(current => current?.pinned && !current.closing ? current : { date, anchor, pinned: false }), 180);
    },
    onMouseLeave: leave,
    onFocus: (event: FocusEvent<HTMLElement>) => { if (!restoringFocus.current) { clearTimer(); setActive({ date, anchor: event.currentTarget, pinned: false }); } },
    onBlur: (event: FocusEvent<HTMLElement>) => { if (!panel.current?.contains(event.relatedTarget)) leave(); },
    onClick: (event: MouseEvent<HTMLElement>) => { clearTimer(); const anchor = event.currentTarget; setActive(current => current?.anchor === anchor && current.pinned && !current.closing ? dismiss(current) : { date, anchor, pinned: true }); },
  });
  const clock = (at: number) => new Date(at).toLocaleTimeString(zh ? 'zh-CN' : 'en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  const popover = active && <div ref={panel} id={id} popover="manual" className="calendar-day-details" data-closing={Boolean(active.closing)} role="dialog" aria-label={zh ? '日期详情' : 'Date details'}
    onMouseEnter={keepOpen} onMouseLeave={leave} onFocus={keepOpen} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) leave(); }}>
    <header><strong>{active.date.toLocaleDateString(zh ? 'zh-CN' : 'en-US', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' })}</strong>
      {lunar && <span className="calendar-lunar-date">{lunar.fullLabel}</span>}</header>
    <div className="calendar-day-details-content" tabIndex={0}>
    {!!imported?.count && <section aria-label={zh ? '节日与日程' : 'Holidays and events'}><h3>{zh ? '节日与日程' : 'Holidays & events'}</h3>
      {imported.items.map(({ calendar, entry }) => <div className="calendar-day-note" key={`${calendar.id}:${entry.id}`}>
        <strong>{entry.title}</strong><span>{[entry.time || (zh ? '全天' : 'All day'), calendar.name].join(' · ')}</span>{entry.description && <p>{entry.description}</p>}
      </div>)}
      {imported.count > limit && <button className="calendar-details-more" type="button" onClick={() => setLimit(value => value + 50)}>{zh ? `还有 ${imported.count - limit} 项，显示更多` : `${imported.count - limit} more · Show more`}</button>}
    </section>}
    {entries.length > 0 && <section aria-label={zh ? '自动化安排' : 'Automations'}><h3>{zh ? '自动化安排' : 'Automations'}</h3>
      {entries.slice(0, limit).map(entry => <div className="calendar-day-job" key={entry.job.id} data-job-id={entry.job.id}>
        <time>{clock(entry.firstAt)}{entry.lastAt !== entry.firstAt && <small>– {clock(entry.lastAt)}</small>}</time>
        <div><strong>{entry.job.name}</strong><span>{[
          entry.scheduledCount ? (zh ? `预计 ${entry.scheduledCount} 次` : `${entry.scheduledCount} scheduled`) : '',
          entry.runs.length ? (zh ? `已记录 ${entry.runs.length} 次` : `${entry.runs.length} recorded`) : '',
          entry.runs.at(-1)?.status ? (zh ? { queued: '排队中', running: '执行中', completed: '已完成', failed: '失败', stopped: '已停止', interrupted: '执行中断', awaiting_user_action: '等待处理' }[entry.runs.at(-1)!.status] : entry.runs.at(-1)!.status) : entry.overdue ? (zh ? '待执行' : 'Due') : '',
        ].filter(Boolean).join(' · ')}</span></div>
      </div>)}
      {entries.length > limit && <button className="calendar-details-more" type="button" onClick={() => setLimit(value => value + 50)}>{zh ? '显示更多自动化' : 'More automations'}</button>}
    </section>}
    {!entries.length && !imported?.count && <p className="calendar-day-empty">{zh ? '这一天没有安排' : 'Nothing scheduled'}</p>}
    </div>
  </div>;
  return { dayProps, popover, close };
}
