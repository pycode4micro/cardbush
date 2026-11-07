import test from 'node:test';
import assert from 'node:assert/strict';
import { eventRecurrenceSchema } from '@cardbush/bush-protocol';
import { nextEventOccurrence } from '../dist/eventRecurrence.js';

function sequence(rule, after, expected) {
  const parsed = eventRecurrenceSchema.parse(rule);
  let cursor = Date.parse(after);
  for (const value of expected) {
    const next = nextEventOccurrence(parsed, cursor);
    assert.equal(next, new Date(value).toISOString());
    cursor = Date.parse(next);
  }
}

test('calendar recurrences preserve wall time over DST and fire only once in an overlapping hour', () => {
  const daily = { unit: 'day', interval: 1, timeZone: 'America/New_York' };
  sequence({ ...daily, startLocal: '2026-03-07T02:30' }, '2026-03-07T00:00Z',
    ['2026-03-07T07:30Z', '2026-03-08T07:30Z', '2026-03-09T06:30Z']);
  sequence({ ...daily, startLocal: '2026-10-31T01:30' }, '2026-10-31T00:00Z',
    ['2026-10-31T05:30Z', '2026-11-01T05:30Z', '2026-11-02T06:30Z']);
});

test('weekly selections preserve the anchor week, local start bound, phase and fractional-hour zone', () => {
  const fortnight = { unit: 'week', interval: 2, weekdays: [5, 1], timeZone: 'Asia/Kathmandu', startLocal: '2026-11-04T09:00' };
  sequence(fortnight, '2026-10-01T00:00Z', ['2026-11-06T03:15Z', '2026-11-16T03:15Z', '2026-11-20T03:15Z']);
  sequence(fortnight, '2026-11-17T12:00Z', ['2026-11-20T03:15Z']);
});

test('month and year rules skip missing dates; minute and hour intervals keep elapsed time', () => {
  sequence({ unit: 'month', interval: 1, startLocal: '2026-01-31T09:00', timeZone: 'UTC' }, '2026-01-31T09:00Z',
    ['2026-03-31T09:00Z', '2026-05-31T09:00Z']);
  sequence({ unit: 'year', interval: 1, startLocal: '2024-02-29T09:00', timeZone: 'UTC' }, '2024-03-01T00:00Z', ['2028-02-29T09:00Z']);
  sequence({ unit: 'hour', interval: 2, startLocal: '2026-03-08T00:30', timeZone: 'America/New_York' }, '2026-03-08T05:30Z',
    ['2026-03-08T07:30Z', '2026-03-08T09:30Z']);
  sequence({ unit: 'minute', interval: 15, startLocal: '2020-01-01T00:05', timeZone: 'UTC' }, '2026-11-07T12:08Z', ['2026-11-07T12:20Z']);
});

test('invalid zones, dates, offsets in wall times and ambiguous weekday rules fail validation', () => {
  const base = { unit: 'week', interval: 1, startLocal: '2026-11-09T09:00', timeZone: 'Asia/Shanghai' };
  for (const patch of [{ timeZone: 'Unknown/Zone' }, { startLocal: '2026-02-30T09:00' }, { startLocal: '2026-11-09T09:00Z' },
    { interval: 0 }, { interval: 1.5 }, { weekdays: [1, 1] }, { weekdays: [0] }, { unit: 'day', weekdays: [1] }]) {
    assert.equal(eventRecurrenceSchema.safeParse({ ...base, ...patch }).success, false, JSON.stringify(patch));
  }
});
