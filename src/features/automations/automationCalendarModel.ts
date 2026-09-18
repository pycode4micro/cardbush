import type { AutomationJob, AutomationRun, CalendarDataset, CalendarEntry } from '@cardbush/bush-protocol';

export interface AutomationCalendarEntry {
  job: AutomationJob;
  firstAt: number;
  lastAt: number;
  scheduledCount: number;
  overdue: boolean;
  runs: AutomationRun[];
}

export function localDay(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

export function calendarDayKey(value: Date) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

export function shiftCalendarDay(value: Date, days: number) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate() + days);
}

export function shiftCalendarMonth(value: Date, months: number) {
  const first = new Date(value.getFullYear(), value.getMonth() + months, 1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return new Date(first.getFullYear(), first.getMonth(), Math.min(value.getDate(), last));
}

export function calendarMonthDays(value: Date) {
  const first = new Date(value.getFullYear(), value.getMonth(), 1);
  const start = shiftCalendarDay(first, -((first.getDay() + 6) % 7));
  return Array.from({ length: 42 }, (_, index) => shiftCalendarDay(start, index));
}

/** A read-only projection of the scheduler snapshot, never a second schedule. */
export function calendarEntriesForDays(jobs: AutomationJob[], dates: Date[], now: number): Map<string, AutomationCalendarEntry[]> {
  const days = dates.map(date => ({ key: calendarDayKey(date), start: localDay(date).getTime(), end: shiftCalendarDay(localDay(date), 1).getTime() }));
  const result = new Map(days.map(day => [day.key, [] as AutomationCalendarEntry[]]));
  for (const job of jobs) {
    const byDay = new Map<string, AutomationCalendarEntry>();
    const entryFor = (key: string) => {
      let entry = byDay.get(key);
      if (!entry) { entry = { job, firstAt: Infinity, lastAt: -Infinity, scheduledCount: 0, overdue: false, runs: [] }; byDay.set(key, entry); }
      return entry;
    };
    // Keep history on the day it entered the queue, even if execution finishes later.
    // Each run is inspected once for the visible month, not once per calendar cell.
    for (const run of job.runs) {
      const at = Date.parse(run.queuedAt);
      if (!Number.isFinite(at)) continue;
      const key = calendarDayKey(new Date(at));
      if (!result.has(key)) continue;
      const entry = entryFor(key);
      entry.runs.push(run); entry.firstAt = Math.min(entry.firstAt, at); entry.lastAt = Math.max(entry.lastAt, at);
    }
    const next = Date.parse(job.nextRunAt ?? '');
    if (job.state === 'active' && job.trigger.kind !== 'event' && Number.isFinite(next)) {
      for (const { key, start, end } of days) {
        const addSchedule = (first: number, last: number, count: number) => {
          const entry = entryFor(key);
          entry.scheduledCount += count;
          entry.firstAt = Math.min(entry.firstAt, first); entry.lastAt = Math.max(entry.lastAt, last);
          entry.overdue ||= first < now;
        };
        if (job.trigger.kind === 'once') {
          if (next >= start && next < end) addSchedule(next, next, 1);
        } else {
          const step = job.trigger.seconds * 1000;
          // The scheduler coalesces missed intervals. Keep its one outstanding run;
          // do not invent historical executions or enumerate every missed minute.
          if (next < now && next >= start && next < end) addSchedule(next, next, 1);
          if (Number.isFinite(step) && step > 0) {
            const first = next + Math.max(0, Math.ceil((Math.max(start, now) - next) / step)) * step;
            if (first < end) {
              const count = Math.ceil((end - first) / step);
              addSchedule(first, first + (count - 1) * step, count);
            }
          }
        }
      }
    }
    for (const [key, entry] of byDay) {
      entry.runs.sort((a, b) => Date.parse(a.queuedAt) - Date.parse(b.queuedAt));
      result.get(key)!.push(entry);
    }
  }
  for (const entries of result.values()) entries.sort((a, b) => a.firstAt - b.firstAt || a.job.name.localeCompare(b.job.name) || a.job.id.localeCompare(b.job.id));
  return result;
}

export type ImportedCalendarEntry = { calendar: CalendarDataset; entry: CalendarEntry };
export function calendarYearDays(year: number) {
  const end = new Date(year + 1, 0, 1).getTime(), result: Date[] = [];
  for (let date = new Date(year, 0, 1); date.getTime() < end; date = shiftCalendarDay(date, 1)) result.push(date);
  return result;
}
export function calendarQueryMatches(text: string, query: string) {
  return text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
}
export function importedEntriesForDays(calendars: CalendarDataset[], days: Date[], query = '', limit = 100) {
  const keys = [...new Set(days.map(calendarDayKey))].sort();
  const result = new Map(keys.map(key => [key, { count: 0, items: [] as ImportedCalendarEntry[] }]));
  const all = calendars.flatMap(calendar => calendar.entries.filter(entry => !query || calendarQueryMatches(`${calendar.name} ${entry.title} ${entry.description ?? ''}`, query)).map(entry => ({ calendar, entry })));
  if (limit > 0) all.sort((a, b) => (a.entry.time ?? '').localeCompare(b.entry.time ?? '') || a.entry.title.localeCompare(b.entry.title));
  const lowerBound = (date: string) => {
    let lo = 0, hi = keys.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (keys[mid] < date) lo = mid + 1; else hi = mid; }
    return lo;
  };
  // Range counts use a sweep; a year of 50k long events must not allocate
  // millions of per-day rows. Only the requested visible previews are retained.
  const changes = new Int32Array(keys.length + 1);
  for (const item of all) {
    const { entry } = item, lo = lowerBound(entry.date);
    const end = entry.endDate ? lowerBound(entry.endDate) : lo + (keys[lo] === entry.date ? 1 : 0);
    if (end <= lo) continue;
    changes[lo]++; changes[end]--;
    if (limit > 0) for (let index = lo; index < end; index++) {
      const items = result.get(keys[index])!.items;
      if (items.length < limit) items.push(item);
    }
  }
  let count = 0;
  for (const [index, value] of [...result.values()].entries()) { count += changes[index]; value.count = count; }
  return result;
}

/** Search existing dates globally; project open-ended intervals only for the
 * requested year. No recurrence is materialized into the scheduler. */
export function matchingCalendarDates(jobs: AutomationJob[], calendars: CalendarDataset[], year: number, now: number) {
  const yearDays = calendarYearDays(year), dates = new Set<string>();
  for (const [key, entries] of calendarEntriesForDays(jobs, yearDays, now)) if (entries.length) dates.add(key);
  for (const job of jobs) {
    for (const run of job.runs) { const at = new Date(run.queuedAt); if (Number.isFinite(at.getTime())) dates.add(calendarDayKey(at)); }
    if (job.state === 'active' && job.trigger.kind !== 'event' && job.nextRunAt) { const at = new Date(job.nextRunAt); if (Number.isFinite(at.getTime())) dates.add(calendarDayKey(at)); }
  }
  for (const calendar of calendars) for (const entry of calendar.entries) dates.add(entry.date);
  for (const [key, entries] of importedEntriesForDays(calendars, yearDays, '', 0)) if (entries.count) dates.add(key);
  return [...dates].sort();
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export function compactAutomationText(value: string, limit = 14) {
  const text = value.replace(/\s+/gu, ' ').trim();
  let preview = '', count = 0;
  for (const { segment } of segmenter.segment(text)) {
    if (count++ === limit) return `${preview}…`;
    preview += segment;
  }
  return preview;
}
