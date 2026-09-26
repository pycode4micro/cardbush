import { z } from 'zod';

export const CALENDAR_FILE_BYTES = 8 * 1024 * 1024;
export const CALENDAR_ENTRY_LIMIT = 50_000;
export const calendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value && value >= '1900-01-01' && value <= '2199-12-31';
}, '日期必须是 1900–2199 年内真实的公历日期');
export const calendarEntrySchema = z.object({
  id: z.string().trim().min(1).max(256), date: calendarDateSchema,
  endDate: calendarDateSchema.optional(), title: z.string().trim().min(1).max(160),
  description: z.string().max(2000).optional(),
  time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).optional(),
  kind: z.enum(['event', 'holiday', 'workday', 'note']).default('event'),
}).strict().refine(entry => !entry.endDate || entry.endDate > entry.date, 'endDate 是不包含在内的结束日期，必须晚于 date');
export const calendarDatasetSchema = z.object({
  protocol: z.literal('cardbush.calendar.v1'),
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/), name: z.string().trim().min(1).max(120),
  source: z.string().max(2000).optional(),
  timeZone: z.string().max(100).default('Asia/Shanghai').refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }, 'Invalid time zone'),
  recurrenceWindow: z.object({ from: calendarDateSchema, to: calendarDateSchema }).strict().refine(value => value.to > value.from, '展开范围的结束日期必须晚于起始日期').optional(),
  entries: z.array(calendarEntrySchema).min(1).max(CALENDAR_ENTRY_LIMIT),
}).strict().superRefine((dataset, context) => {
  const ids = new Set<string>();
  for (const [index, entry] of dataset.entries.entries()) {
    if (ids.has(entry.id)) context.addIssue({ code: 'custom', path: ['entries', index, 'id'], message: '条目 id 重复' });
    ids.add(entry.id);
  }
});
export type CalendarEntry = z.infer<typeof calendarEntrySchema>;
export type CalendarDataset = z.infer<typeof calendarDatasetSchema>;
export type CalendarState = { datasets: Array<{ calendar: CalendarDataset; enabled: boolean; builtin?: boolean }>; chineseLunar: boolean };
export const calendarCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).strict(), z.object({ action: z.literal('import') }).strict(),
  z.object({ action: z.literal('remove'), id: z.string() }).strict(),
  z.object({ action: z.literal('enabled'), id: z.string(), enabled: z.boolean() }).strict(),
  z.object({ action: z.literal('lunar'), enabled: z.boolean() }).strict(),
]);
export type CalendarCommand = z.infer<typeof calendarCommandSchema>;
export type CalendarCommandResult = { state: CalendarState; imported?: string; cancelled?: boolean };
