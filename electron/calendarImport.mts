import { createHash } from 'node:crypto';
import ICAL from 'ical.js';
import { CALENDAR_ENTRY_LIMIT, calendarDatasetSchema, type CalendarDataset, type CalendarEntry } from '@cardbush/bush-protocol';

type Time = InstanceType<typeof ICAL.Time>;
const dateKey = (year: number, month: number, day: number) => `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);
function wallTime(time: Time, zone: string): Date {
  const wanted = Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second);
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  let guess = wanted;
  for (let i = 0; i < 4; i++) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(guess)).map(part => [part.type, part.value]));
    const shown = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    if (shown === wanted) return new Date(guess);
    guess += wanted - shown;
  }
  throw Error(`无法确定 ${time.toString()} 在 ${zone} 的时间，请转换为带 UTC 偏移的时间。`);
}

export function parseCalendarImport(text: string, fileName: string, now = new Date()): CalendarDataset {
  if (!/\.ics$/i.test(fileName)) return calendarDatasetSchema.parse(JSON.parse(text.replace(/^\uFEFF/, '')));
  const root = new ICAL.Component(ICAL.parse(text.replace(/^\uFEFF/, '')));
  if (root.name !== 'vcalendar') throw Error('文件不是有效的 ICS 日历。');
  if (root.getFirstPropertyValue('calscale') && String(root.getFirstPropertyValue('calscale')).toUpperCase() !== 'GREGORIAN') throw Error('ICS 日期需先转换成公历；可使用 cardbush-docs 日历转换协议。');
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const sourceZone = String(root.getFirstPropertyValue('x-wr-timezone') || zone);
  const name = String(root.getFirstPropertyValue('x-wr-calname') || fileName.replace(/\.ics$/i, '')).slice(0, 120);
  const entries: CalendarEntry[] = [];
  const from = `${now.getFullYear() - 1}-01-01`, to = `${now.getFullYear() + 3}-01-01`;
  const startBound = new Date(`${from}T00:00:00`).getTime(), endBound = new Date(`${to}T00:00:00`).getTime();
  const civil = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  let recurring = false, iterations = 0;
  const components = root.getAllSubcomponents('vevent');
  const exceptions = components.filter(component => component.hasProperty('recurrence-id')).map(component => new ICAL.Event(component));
  const known = new Set<string>();
  for (const component of components) {
    if (component.hasProperty('recurrence-id')) continue;
    const uid = String(component.getFirstPropertyValue('uid') || '');
    if (!uid || known.has(uid)) throw Error('ICS 事件需要唯一的 UID；请先整理重复或缺失的记录。');
    known.add(uid);
    const event = new ICAL.Event(component, { exceptions: exceptions.filter(item => item.uid === uid) });
    if (!component.hasProperty('dtstart')) throw Error(`ICS 事件 ${uid} 缺少 DTSTART。`);
    const asDate = (time: Time, item: InstanceType<typeof ICAL.Event>, property = 'dtstart') => {
      if (time.isDate) return new Date(`${dateKey(time.year, time.month, time.day)}T00:00:00`);
      if (time.zone && !['floating', 'local'].includes(time.zone.tzid)) return time.toJSDate();
      const tzid = String(item.component.getFirstProperty(property)?.getParameter('tzid') || item.component.getFirstProperty('dtstart')?.getParameter('tzid') || sourceZone);
      return wallTime(time, tzid);
    };
    const add = (item: InstanceType<typeof ICAL.Event>, start: Time, end: Time, occurrence: string) => {
      if (String(item.component.getFirstPropertyValue('status')).toUpperCase() === 'CANCELLED') return;
      const first = asDate(start, item), last = asDate(end, item, 'dtend');
      if (last < first) throw Error(`ICS 事件 ${uid} 的结束时间早于开始时间。`);
      const parts = Object.fromEntries(civil.formatToParts(first).map(part => [part.type, part.value]));
      const date = start.isDate ? dateKey(start.year, start.month, start.day) : `${parts.year}-${parts.month}-${parts.day}`;
      const lastParts = Object.fromEntries(civil.formatToParts(new Date(Math.max(first.getTime(), last.getTime() - 1))).map(part => [part.type, part.value]));
      const lastDay = end.isDate ? new Date(last.getTime() - 1) : new Date(`${lastParts.year}-${lastParts.month}-${lastParts.day}T12:00:00`);
      const lastKey = dateKey(lastDay.getFullYear(), lastDay.getMonth() + 1, lastDay.getDate());
      const exclusive = new Date(lastDay.getFullYear(), lastDay.getMonth(), lastDay.getDate() + 1);
      const exclusiveKey = dateKey(exclusive.getFullYear(), exclusive.getMonth() + 1, exclusive.getDate());
      entries.push({ id: hash(`${uid}:${occurrence}`), date,
        ...(lastKey > date ? { endDate: exclusiveKey } : {}),
        title: item.summary || '未命名日程', description: [item.description, item.location].filter(Boolean).join('\n').slice(0, 2000),
        ...(!start.isDate ? { time: `${parts.hour}:${parts.minute}` } : {}), kind: 'event' });
      if (entries.length > CALENDAR_ENTRY_LIMIT) throw Error('日历条目超过 50,000 条，请分段导入。');
    };
    if (!event.isRecurring()) { add(event, event.startDate, event.endDate, event.startDate.toString()); continue; }
    // Without VTIMEZONE, ICAL treats IANA wall times as floating. Cross-zone
    // recurrence durations cannot then be calculated faithfully by the library.
    // Refuse that combination instead of silently shifting dates.
    for (const item of [event, ...exceptions.filter(item => item.uid === uid)]) {
      const startZone = String(item.component.getFirstProperty('dtstart')?.getParameter('tzid') || item.startDate.zone?.tzid || sourceZone);
      const endZone = String(item.component.getFirstProperty('dtend')?.getParameter('tzid') || item.endDate.zone?.tzid || sourceZone);
      if (item.component.hasProperty('dtend') && startZone !== endZone && [item.startDate, item.endDate].some(time => ['floating', 'local'].includes(time.zone?.tzid))) throw Error('跨时区重复事件需包含 VTIMEZONE，或先转换为 JSON 日期明细。');
    }
    recurring = true;
    const iterator = event.iterator();
    for (let occurrence = iterator.next(); occurrence; occurrence = iterator.next()) {
      if (++iterations > 100_000) throw Error('重复规则展开过多，请缩小日期范围并转换为 JSON 明细后导入。');
      const details = event.getOccurrenceDetails(occurrence), at = asDate(details.startDate, details.item).getTime();
      if (asDate(occurrence, event).getTime() >= endBound) break;
      if (at >= startBound && at < endBound) add(details.item, details.startDate, details.endDate, occurrence.toString());
    }
  }
  if (exceptions.some(item => !known.has(item.uid))) throw Error('ICS 包含缺少主事件的重复例外，请先转换为完整日期明细。');
  if (!entries.length) throw Error(`文件中没有可显示的日程。重复事件当前只展开 ${from} 至 ${to}（结束日不含）。`);
  return calendarDatasetSchema.parse({ protocol: 'cardbush.calendar.v1', id: `ics-${hash(String(root.getFirstPropertyValue('uid') || name))}`, name, source: fileName, timeZone: zone,
    ...(recurring ? { recurrenceWindow: { from, to } } : {}), entries });
}
