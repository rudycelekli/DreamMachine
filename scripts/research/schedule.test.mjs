import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRunId, isRunId, runDate, cycleSlot, scheduledHours } from './schedule.mjs';

const config = { timezone: 'America/Toronto', dailyHours: [7, 19] };
test('morning and evening have distinct stable Toronto cycle IDs', () => {
  for (const [time, expected] of [
    ['2026-09-21T10:59:59Z', '2026-09-20-1900'],
    ['2026-09-21T11:00:00Z', '2026-09-21-0700'],
    ['2026-09-21T22:59:59Z', '2026-09-21-0700'],
    ['2026-09-21T23:00:00Z', '2026-09-21-1900'],
    ['2026-09-22T02:00:00Z', '2026-09-21-1900'],
    ['2026-09-22T10:59:59Z', '2026-09-21-1900'],
    ['2026-09-22T11:00:00Z', '2026-09-22-0700'],
  ]) assert.equal(cycleSlot(new Date(time), config).id, expected, time);
});

test('wall-clock slots survive daylight-saving changes and calendar rollover', () => {
  for (const [time, expected] of [
    ['2026-03-08T10:59:59Z', '2026-03-07-1900'],
    ['2026-03-08T11:00:00Z', '2026-03-08-0700'],
    ['2026-11-01T11:59:59Z', '2026-10-31-1900'],
    ['2026-11-01T12:00:00Z', '2026-11-01-0700'],
    ['2027-01-01T05:00:00Z', '2026-12-31-1900'],
  ]) assert.equal(cycleSlot(new Date(time), config).id, expected, time);
  const repeated = { ...config, dailyHours: [1, 19] };
  assert.equal(cycleSlot(new Date('2026-11-01T05:30:00Z'), repeated).id, '2026-11-01-0100');
  assert.equal(cycleSlot(new Date('2026-11-01T06:30:00Z'), repeated).id, '2026-11-01-0100');
});

test('legacy configuration retains date-only identity without changing calendar dates', () => {
  assert.deepEqual(cycleSlot(new Date('2026-09-21T02:00:00Z'), {
    timezone: 'America/Toronto', dailyHour: 7,
  }), { id: '2026-09-20', date: '2026-09-20', hour: null });
});

test('cycle ID validation accepts both formats and rejects traversal or invalid dates/times', () => {
  for (const id of ['2026-09-21', '2026-09-21-0700', '2026-09-21-1900', '2024-02-29-2359']) {
    assert.equal(assertRunId(id), id);
    assert.equal(runDate(id), id.slice(0, 10));
  }
  for (const id of [null, {}, '../2026-09-21', '2026-09-21/0700', '2026-02-29',
    '2026-02-30-0700', '2026-13-01-0700', '2026-09-21-2400', '2026-09-21-0760',
    '2026-09-21-7', '2026-09-21-0700\n', '2026-09-21-0700-more']) {
    assert.equal(isRunId(id), false);
    assert.throws(() => assertRunId(id), /valid YYYY-MM-DD/);
  }
});

test('schedule configuration rejects ambiguous or invalid hour lists', () => {
  for (const dailyHours of [null, [], [7, 7], [19, 7], [-1, 19], [7, 24], ['7', 19], [7.5, 19], '7,19']) {
    assert.throws(() => scheduledHours({ dailyHours }), /dailyHours/);
  }
  assert.equal(scheduledHours({}), null);
  assert.deepEqual(scheduledHours(config), [7, 19]);
  const copy = scheduledHours(config);
  copy[0] = 8;
  assert.deepEqual(config.dailyHours, [7, 19]);
});
