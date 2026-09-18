import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseCalendarImport } from '../dist-electron/calendarImport.mjs';
import { CalendarStore, importCalendarFile } from '../dist-electron/calendarStore.mjs';
import { calendarDatasetSchema, CALENDAR_FILE_BYTES } from '@cardbush/bush-protocol';
import { chineseDate, gregorianFromChinese } from '../assets/skills/cardbush-docs/scripts/calendar-date.mjs';

process.env.TZ = 'Asia/Shanghai';
const now = new Date('2026-09-17T00:00:00+08:00');
const entry = { id: 'one', date: '2026-09-25', title: '中秋', kind: 'note' };
const dataset = { protocol: 'cardbush.calendar.v1', id: 'test', name: '测试日历', timeZone: 'Asia/Shanghai', entries: [entry] };
const event = lines => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'].join('\r\n');
const ics = (...parts) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'X-WR-CALNAME:日历测试', ...parts, 'END:VCALENDAR'].join('\r\n');
const parse = text => parseCalendarImport(text, 'test.ics', now);
async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-calendar-'));
  try { await fn(root); } finally { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'cardbush-calendar-')); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

test('JSON protocol validates real dates, identities, boundaries and preserves plain text', async () => {
  assert.deepEqual(parseCalendarImport('\uFEFF'+JSON.stringify(dataset), 'test.json'), dataset);
  assert.equal(calendarDatasetSchema.parse({ ...dataset, entries: [{ ...entry, description: '<script>do not execute</script>' }] }).entries[0].description, '<script>do not execute</script>');
  for (const change of [{ date: '2026-02-29' }, { date: '2026-13-01' }, { date: '1899-12-31' }, { date: '2200-01-01' }, { endDate: entry.date }, { time: '24:00' }, { command: 'run something' }]) {
    assert.throws(() => calendarDatasetSchema.parse({ ...dataset, entries: [{ ...entry, ...change }] }));
  }
  assert.throws(() => calendarDatasetSchema.parse({ ...dataset, entries: [entry, entry] }), /id 重复/);
  assert.throws(() => calendarDatasetSchema.parse({ ...dataset, recurrenceWindow: { from: '2027-01-01', to: '2026-01-01' } }));
  assert.throws(() => calendarDatasetSchema.parse({ ...dataset, timeZone: 'Missing/Zone' }));
  const example = JSON.parse(await readFile('assets/skills/cardbush-docs/assets/calendar-example.json', 'utf8'));
  assert.ok(calendarDatasetSchema.safeParse(example).success);
});

test('ICS all-day, midnight, UTC and IANA civil dates are normalized with exclusive ends', () => {
  const allDay = parse(ics(event(['UID:all-day', 'DTSTART;VALUE=DATE:20261010', 'DTEND;VALUE=DATE:20261013', 'SUMMARY:三天展览']))).entries[0];
  assert.equal(allDay.date, '2026-10-10'); assert.equal(allDay.endDate, '2026-10-13'); assert.equal(allDay.time, undefined);
  const utc = parse(ics(event(['UID:utc', 'DTSTART:20260924T160000Z', 'DTEND:20260925T160000Z', 'SUMMARY:UTC 边界']))).entries[0];
  assert.equal(utc.date, '2026-09-25'); assert.equal(utc.time, '00:00'); assert.equal(utc.endDate, undefined);
  const eastern = parse(ics(event(['UID:ny', 'DTSTART;TZID=America/New_York:20260701T200000', 'DTEND;TZID=America/New_York:20260701T220000', 'SUMMARY:跨时区']))).entries[0];
  assert.equal(eastern.date, '2026-07-02'); assert.equal(eastern.time, '08:00');
  const floating = parse(ics('X-WR-TIMEZONE:Asia/Shanghai', event(['UID:floating', 'DTSTART:20260925T230000', 'DTEND:20260926T010000', 'SUMMARY:跨日']))).entries[0];
  assert.equal(floating.endDate, '2026-09-27');
  const crossZone = parse(ics(event(['UID:flight', 'DTSTART;TZID=Asia/Shanghai:20260925T230000', 'DTEND;TZID=America/New_York:20260925T120000', 'SUMMARY:航班']))).entries[0];
  assert.equal(crossZone.date, '2026-09-25'); assert.equal(crossZone.endDate, undefined);
  assert.throws(() => parse(ics(event(['UID:flight-series', 'DTSTART;TZID=Asia/Shanghai:20260925T230000', 'DTEND;TZID=America/New_York:20260925T120000', 'RRULE:FREQ=DAILY;COUNT=2', 'SUMMARY:航班']))), /跨时区重复/);
  assert.throws(() => parse(ics(event(['UID:bad-tz', 'DTSTART;TZID=Missing/Zone:20260925T120000', 'SUMMARY:错误时区']))));
});

test('ICS embedded VTIMEZONE, folding, escapes and cancellation', () => {
  const zone = ['BEGIN:VTIMEZONE', 'TZID:Custom/Plus9', 'BEGIN:STANDARD', 'DTSTART:19700101T000000', 'TZOFFSETFROM:+0900', 'TZOFFSETTO:+0900', 'END:STANDARD', 'END:VTIMEZONE'].join('\r\n');
  const result = parse(ics(zone, event(['UID:embedded', 'DTSTART;TZID=Custom/Plus9:20260925T090000', 'SUMMARY:长标题', ' 折行\\,内容', 'DESCRIPTION:第一行\\n第二行']), event(['UID:cancelled', 'DTSTART;VALUE=DATE:20260926', 'STATUS:CANCELLED'])));
  assert.equal(result.entries.length, 1); assert.equal(result.entries[0].time, '08:00');
  assert.equal(result.entries[0].title, '长标题折行,内容'); assert.equal(result.entries[0].description, '第一行\n第二行');
});

test('ICS RRULE, RDATE, EXDATE and moved/cancelled instances retain correct identity', () => {
  const text = ics(event(['UID:series', 'DTSTART;TZID=Asia/Shanghai:20260925T090000', 'DTEND;TZID=Asia/Shanghai:20260925T100000', 'RRULE:FREQ=DAILY;COUNT=4', 'RDATE;TZID=Asia/Shanghai:20260930T090000', 'EXDATE;TZID=Asia/Shanghai:20260926T090000', 'SUMMARY:原安排']),
    event(['UID:series', 'RECURRENCE-ID;TZID=Asia/Shanghai:20260927T090000', 'DTSTART;TZID=Asia/Shanghai:20260927T140000', 'DTEND;TZID=Asia/Shanghai:20260927T150000', 'SUMMARY:改到下午']),
    event(['UID:series', 'RECURRENCE-ID;TZID=Asia/Shanghai:20260928T090000', 'DTSTART;TZID=Asia/Shanghai:20260928T090000', 'STATUS:CANCELLED', 'SUMMARY:取消']));
  const result = parse(text);
  assert.deepEqual(result.entries.map(item => [item.date, item.time]), [['2026-09-25', '09:00'], ['2026-09-27', '14:00'], ['2026-09-30', '09:00']]);
  assert.equal(result.entries[1].title, '改到下午');
  assert.deepEqual(result.recurrenceWindow, { from: '2025-01-01', to: '2029-01-01' });
  assert.deepEqual(parse(text).entries, result.entries);
  const infinite = parse(ics(event(['UID:annual', 'DTSTART;VALUE=DATE:20000101', 'RRULE:FREQ=YEARLY', 'SUMMARY:元旦'])));
  assert.deepEqual(infinite.entries.map(item => item.date), ['2025-01-01', '2026-01-01', '2027-01-01', '2028-01-01']);
});

test('ICS rejects malformed/ambiguous records and excessive recurrence without partial output', () => {
  assert.throws(() => parse('not a calendar'));
  assert.throws(() => parse(ics('CALSCALE:CHINESE', event(['UID:a', 'DTSTART;VALUE=DATE:20260925']))), /公历/);
  assert.throws(() => parse(ics(event(['UID:a', 'DTSTART;VALUE=DATE:20260925']), event(['UID:a', 'DTSTART;VALUE=DATE:20260926']))), /UID/);
  assert.throws(() => parse(ics(event(['UID:a', 'RECURRENCE-ID;VALUE=DATE:20260925', 'DTSTART;VALUE=DATE:20260926']))), /主事件/);
  assert.throws(() => parse(ics(event(['UID:a', 'SUMMARY:没有日期']))), /DTSTART/);
  assert.throws(() => parse(ics(event(['UID:huge', 'DTSTART:20250101T000000Z', 'RRULE:FREQ=SECONDLY', 'SUMMARY:太多']))), /50,000|展开过多/);
});

test('store import/replacement, cancellation, concurrent changes and reload are atomic', async () => fixture(async root => {
  const file = join(root, 'input.json'), storePath = join(root, 'storage/calendars.json');
  await writeFile(file, JSON.stringify(dataset));
  const store = new CalendarStore(storePath), choose = async () => file;
  assert.deepEqual((await store.command({ action: 'list' }, choose)).state.datasets, []);
  assert.equal((await store.command({ action: 'import' }, choose)).state.datasets.length, 1);
  await Promise.all([store.command({ action: 'lunar', enabled: false }, choose), store.command({ action: 'enabled', id: 'test', enabled: false }, choose)]);
  await writeFile(file, JSON.stringify({ ...dataset, entries: [{ ...entry, title: '更新的标题' }] }));
  let result = await store.command({ action: 'import' }, choose);
  assert.equal(result.state.datasets.length, 1); assert.equal(result.state.datasets[0].enabled, false); assert.equal(result.state.chineseLunar, false);
  assert.equal(result.state.datasets[0].calendar.entries[0].title, '更新的标题');
  assert.equal((await store.command({ action: 'import' }, async () => undefined)).cancelled, true);
  const before = await readFile(storePath, 'utf8');
  await writeFile(file, '{not json'); await assert.rejects(store.command({ action: 'import' }, choose));
  assert.equal(await readFile(storePath, 'utf8'), before);
  await writeFile(file, Buffer.alloc(CALENDAR_FILE_BYTES + 1)); await assert.rejects(importCalendarFile(file), /8 MiB/);
  assert.equal(await readFile(storePath, 'utf8'), before);
  result = await new CalendarStore(storePath).command({ action: 'list' }, choose);
  assert.equal(result.state.datasets[0].enabled, false);
  await store.command({ action: 'remove', id: 'test' }, choose);
  assert.equal((await new CalendarStore(storePath).command({ action: 'list' }, choose)).state.datasets.length, 0);
}));

test('worker handles ICS and refuses invalid UTF-8, schema and damaged storage', async () => fixture(async root => {
  const file = join(root, 'calendar.ics');
  await writeFile(file, ics(event(['UID:a', 'DTSTART;VALUE=DATE:20260925', 'SUMMARY:正确显示'])));
  assert.equal((await importCalendarFile(file)).entries[0].title, '正确显示');
  await writeFile(file, Buffer.from([0xc3, 0x28])); await assert.rejects(importCalendarFile(file));
  const storePath = join(root, 'bad-store.json'); await writeFile(storePath, '{damaged');
  const store = new CalendarStore(storePath);
  await assert.rejects(store.command({ action: 'lunar', enabled: false }, async () => undefined));
  assert.equal(await readFile(storePath, 'utf8'), '{damaged');
}));

test('lunar conversion shares UI/CLI behavior, distinguishes leap months and is timezone-independent', () => {
  const expectations = [['2026-02-17', 2026, 1, 1, false], ['2026-09-25', 2026, 8, 15, false], ['2025-07-25', 2025, 6, 1, true], ['2025-06-25', 2025, 6, 1, false]];
  for (const [date, year, month, day, leapMonth] of expectations) {
    const lunar = chineseDate(date);
    assert.deepEqual([lunar.year, lunar.month, lunar.day, lunar.leapMonth], [year, month, day, leapMonth]);
    assert.equal(gregorianFromChinese(year, month, day, leapMonth), date);
  }
  assert.throws(() => chineseDate('2026-02-30'));
  assert.throws(() => gregorianFromChinese(2026, 6, 1, true), /does not exist/);
  assert.throws(() => gregorianFromChinese(2026, 13, 1));
  const script = resolve('assets/skills/cardbush-docs/scripts/convert-date.mjs');
  const run = spawnSync(process.execPath, [script, 'chinese', '2025', '6', '1', '--leap'], { encoding: 'utf8', windowsHide: true, env: { ...process.env, TZ: 'America/Los_Angeles' } });
  assert.equal(run.status, 0); assert.equal(JSON.parse(run.stdout).gregorian, '2025-07-25');
  assert.equal(spawnSync(process.execPath, [script, 'chinese', '2026', '6', '1', '--leap'], { windowsHide: true }).status, 1);
});
