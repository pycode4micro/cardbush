import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/features/automations/automationCalendarModel.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { calendarDayKey: key, calendarMonthDays: monthDays, calendarEntriesForDays: project, shiftCalendarMonth: month, compactAutomationText: compact, calendarYearDays, importedEntriesForDays, matchingCalendarDates } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
process.env.TZ = 'Asia/Shanghai';
const day = text => new Date(`${text}T00:00:00`);
const stamp = text => new Date(text).toISOString();
const now = Date.parse('2026-09-17T09:30:00+08:00');
const makeJob = (overrides = {}) => ({ id: 'job', name: '计划', prompt: '完整提示词', sessionId: 'session', revision: 1, state: 'active', timeZone: 'Asia/Shanghai', createdAt: stamp('2026-09-01T00:00:00+08:00'), lastEventIds: [], runs: [], trigger: { kind: 'once', at: stamp('2026-09-17T10:00:00+08:00') }, nextRunAt: stamp('2026-09-17T10:00:00+08:00'), ...overrides });
const entries = (jobs, date = '2026-09-17', at = now) => project(jobs, [day(date)], at).get(date);
const run = (id, at, overrides = {}) => ({ id, turnId: id, queuedAt: stamp(at), status: 'completed', reason: 'schedule', ...overrides });

assert.equal(key(month(day('2026-01-31'), 1)), '2026-02-28');
assert.equal(key(month(day('2024-01-31'), 1)), '2024-02-29');
assert.equal(key(month(day('2026-12-31'), 1)), '2027-01-31');
assert.equal(monthDays(day('2026-09-17')).length, 42);
assert.equal(monthDays(day('2026-09-17'))[0].getDay(), 1, 'week starts on Monday');
assert.equal(monthDays(day('2026-09-17'))[41].getDay(), 0);

const once = makeJob();
assert.equal(calendarYearDays(2024).length, 366);
assert.equal(calendarYearDays(2026).length, 365);
const calendar = { id: 'example', name: '纪念日', entries: [{ id: 'multi', date: '2026-09-25', endDate: '2026-09-28', title: '展览' }, { id: 'later', date: '2030-01-01', title: '远期安排' }] };
const imported = importedEntriesForDays([calendar], monthDays(day('2026-09-01')));
assert.equal(imported.get('2026-09-25').items[0].entry.id, 'multi');
assert.equal(imported.get('2026-09-27').count, 1);
assert.equal(imported.get('2026-09-28').count, 0, 'end date is exclusive');
assert.equal(importedEntriesForDays([calendar], [day('2026-09-25')], 'no-match').get('2026-09-25').count, 0);
assert.deepEqual(matchingCalendarDates([], [calendar], 2026, now), ['2026-09-25', '2026-09-26', '2026-09-27', '2030-01-01']);
assert.ok(matchingCalendarDates([makeJob({ nextRunAt: stamp('2031-01-01T10:00:00+08:00') })], [], 2026, now).includes('2031-01-01'), 'search finds far-future tasks');
const largeCalendar = { ...calendar, entries: Array.from({ length: 50000 }, (_, index) => ({ id: String(index), date: '2000-01-01', endDate: '2100-01-01', title: '长区间' })) };
const projectedAt = performance.now();
const counts = importedEntriesForDays([largeCalendar], calendarYearDays(2026), '', 0);
assert.equal(counts.get('2026-09-25').count, 50000);
assert.equal([...counts.values()].reduce((total, day) => total + day.items.length, 0), 0, 'year previews never materialize millions of entries');
assert.ok(performance.now() - projectedAt < 1500, '50k century-long ranges have bounded projection time');
assert.equal(importedEntriesForDays([largeCalendar], [day('2026-09-25')], '', 100).get('2026-09-25').items.length, 100, 'agenda pages are bounded');
assert.equal(entries([once])[0].scheduledCount, 1);
assert.equal(entries([once], '2026-09-18').length, 0);
assert.equal(entries([makeJob({ nextRunAt: '2026-09-17T16:00:00Z' })]).length, 0, 'local midnight belongs to the following day');
assert.equal(entries([makeJob({ nextRunAt: '2026-09-17T16:00:00Z' })], '2026-09-18').length, 1);
assert.equal(entries([makeJob({ nextRunAt: undefined })]).length, 0, 'do not recreate a consumed schedule from trigger.at');
assert.equal(entries([makeJob({ state: 'paused' })]).length, 0, 'paused jobs can retain a stale nextRunAt');
assert.equal(entries([makeJob({ state: 'completed' })]).length, 0);
assert.equal(entries([makeJob({ trigger: { kind: 'event', event: 'Stop', tool: '', cooldownSeconds: 60 } })]).length, 0, 'events have no projected dates');

const frequent = makeJob({ trigger: { kind: 'interval', at: stamp('2026-09-01T00:00:00+08:00'), seconds: 60 }, nextRunAt: stamp('2026-09-17T09:00:00+08:00') });
const today = entries([frequent])[0];
assert.equal(today.scheduledCount, 871, 'one overdue occurrence plus future minutes, not every missed minute');
assert.equal(today.overdue, true);
assert.equal(today.runs.length, 0, 'estimated runs never become execution history');
assert.equal(entries([frequent], '2026-09-16').length, 0, 'no fabricated historical recurrence');
assert.equal(entries([frequent], '2026-09-18')[0].scheduledCount, 1440);
assert.equal(entries([frequent], '2026-09-18')[0].lastAt, Date.parse('2026-09-18T23:59:00+08:00'));
const late = makeJob({ ...frequent, nextRunAt: stamp('2026-09-15T00:00:00+08:00') });
assert.equal(entries([late], '2026-09-15')[0].scheduledCount, 1, 'a missed day retains only the scheduler’s outstanding occurrence');

const completed = run('actual', '2026-09-16T23:58:00+08:00', { finishedAt: stamp('2026-09-17T00:05:00+08:00') });
const withHistory = makeJob({ runs: [completed, run('manual', '2026-09-17T08:00:00+08:00', { reason: 'manual' })] });
assert.equal(entries([withHistory], '2026-09-16')[0].runs[0].id, 'actual', 'history stays on its queue date across midnight');
assert.equal(entries([withHistory])[0].runs.length, 1);
assert.equal(entries([withHistory])[0].scheduledCount, 1, 'manual execution and future schedule coexist');
assert.equal(entries([makeJob({ ...withHistory, state: 'paused' })])[0].runs.length, 1, 'pausing preserves actual history');
const unsorted = [makeJob({ id: 'later', nextRunAt: stamp('2026-09-17T14:00:00+08:00') }), once];
assert.deepEqual(entries(unsorted).map(entry => entry.job.id), ['job', 'later']);
const original = JSON.stringify(unsorted); entries(unsorted); assert.equal(JSON.stringify(unsorted), original, 'projection never mutates the scheduler snapshot');

assert.equal(compact('一二三四五六七八九十一二三四五六'), '一二三四五六七八九十一二三四…');
assert.equal(compact('  一\n 二  '), '一 二');
assert.equal(compact('👨‍👩‍👧‍👦'.repeat(15)), '👨‍👩‍👧‍👦'.repeat(14) + '…', 'do not split a composed emoji');

// Intervals use elapsed seconds, while local calendar days may have 23 or 25 hours.
process.env.TZ = 'America/New_York';
for (const [date, expected] of [['2026-03-08', 23], ['2026-11-01', 25]]) {
  const midnight = day(date), at = midnight.getTime();
  const hourly = makeJob({ trigger: { kind: 'interval', at: midnight.toISOString(), seconds: 3600 }, nextRunAt: midnight.toISOString() });
  assert.equal(entries([hourly], date, at)[0].scheduledCount, expected, `DST day ${date}`);
  assert.equal(new Set(monthDays(midnight).map(key)).size, 42, 'DST does not duplicate or skip a calendar date');
}
process.env.TZ = 'Asia/Shanghai';
const many = Array.from({ length: 500 }, (_, index) => makeJob({ ...frequent, id: `job-${index}`, runs: Array.from({ length: 50 }, (_, n) => run(`run-${n}`, `2026-09-16T12:${String(n).padStart(2, '0')}:00+08:00`)) }));
const started = performance.now();
const monthResult = project(many, monthDays(day('2026-09-17')), now);
assert.equal(monthResult.get('2026-09-18').length, 500, 'one item per job per day, even for minute intervals');
assert.equal(monthResult.get('2026-09-18').reduce((total, entry) => total + entry.scheduledCount, 0), 720000);
assert.equal(monthResult.get('2026-09-16')[0].runs.length, 50);
console.log(`Automation calendar passed: calendar boundaries, schedule facts, overdue coalescing, history, Unicode, DST; 500 plans / 25,000 retained runs projected in ${Math.round(performance.now() - started)} ms.`);
