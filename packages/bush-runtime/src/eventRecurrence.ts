import { Temporal } from '@js-temporal/polyfill';
import type { EventRecurrence } from '@cardbush/bush-protocol';

/** First occurrence strictly after the supplied instant. Jump over missed periods
 * from the original anchor so sleep, restart and execution time cannot shift it. */
export function nextEventOccurrence(rule: EventRecurrence, after: number): string {
  const anchor = Temporal.PlainDateTime.from(rule.startLocal);
  const instant = (local: Temporal.PlainDateTime) =>
    local.toZonedDateTime(rule.timeZone, { disambiguation: 'compatible' }).epochMilliseconds;
  const iso = (ms: number) => {
    const date = new Date(ms);
    // Persisted event timestamps use the four-digit ISO year in the protocol.
    if (!(date.getUTCFullYear() >= 0 && date.getUTCFullYear() <= 9999)) throw new RangeError('Event recurrence exceeds the supported date range.');
    return date.toISOString();
  };
  if (rule.unit === 'minute' || rule.unit === 'hour') {
    const first = instant(anchor);
    const step = rule.interval * (rule.unit === 'hour' ? 3_600_000 : 60_000);
    return iso(first + Math.max(0, Math.floor((after - first) / step) + 1) * step);
  }

  const today = Temporal.Instant.fromEpochMilliseconds(after).toZonedDateTimeISO(rule.timeZone).toPlainDate();
  const date = anchor.toPlainDate();
  const time = anchor.toPlainTime();
  if (rule.unit === 'week') {
    const monday = date.subtract({ days: date.dayOfWeek - 1 });
    const weekdays = [...(rule.weekdays ?? [date.dayOfWeek])].sort((a, b) => a - b);
    const weeks = Math.floor(monday.until(today).days / (7 * rule.interval));
    for (let period = Math.max(0, weeks); ; period++) {
      const week = monday.add({ weeks: period * rule.interval });
      for (const weekday of weekdays) {
        const candidate = week.add({ days: weekday - 1 }).toPlainDateTime(time);
        if (Temporal.PlainDateTime.compare(candidate, anchor) < 0) continue;
        const at = instant(candidate);
        if (at > after) return iso(at);
      }
    }
  }

  const years = today.year - date.year;
  const distance = rule.unit === 'day' ? date.until(today).days
    : rule.unit === 'month' ? years * 12 + today.month - date.month : years;
  for (let period = Math.max(0, Math.floor(distance / rule.interval)); ; period++) {
    const count = period * rule.interval;
    const candidate = rule.unit === 'day' ? date.add({ days: count })
      : rule.unit === 'month' ? date.add({ months: count }) : date.add({ years: count });
    // "On the 31st" and "on February 29" only occur in matching months/years.
    if (rule.unit !== 'day' && candidate.day !== date.day) continue;
    const at = instant(candidate.toPlainDateTime(time));
    if (at > after) return iso(at);
  }
}
