import { readFile } from 'node:fs/promises';
import { calendarDatasetSchema, type CalendarState } from '@cardbush/bush-protocol';

export const CHINESE_CALENDAR_ID = 'cardbush.chinese';
const builtinIds = new Set([CHINESE_CALENDAR_ID, 'cardbush.us']);
export const isBuiltinCalendar = (id: string) => builtinIds.has(id);
let bundled: Promise<CalendarState['datasets']> | undefined;

export function bundledCalendars() {
  return bundled ??= Promise.all(['china', 'us'].map(async name => ({
    calendar: calendarDatasetSchema.parse(JSON.parse(await readFile(new URL(`../assets/calendars/${name}.json`, import.meta.url), 'utf8'))),
    enabled: false, builtin: true,
  })));
}

export async function withBundledCalendars(state: CalendarState): Promise<CalendarState> {
  const builtins = await bundledCalendars();
  // Trust bundled definitions while preserving only the user's explicit enable
  // choice. Old defaults must not turn on either newly supplied calendar.
  const datasets = [...builtins.map(item => ({ ...item,
    enabled: state.datasets.find(saved => saved.calendar.id === item.calendar.id)?.enabled ?? false,
  })), ...state.datasets.filter(item => !isBuiltinCalendar(item.calendar.id)).map(({ calendar, enabled }) => ({ calendar, enabled }))];
  return { datasets, chineseLunar: datasets.find(item => item.calendar.id === CHINESE_CALENDAR_ID)!.enabled };
}
