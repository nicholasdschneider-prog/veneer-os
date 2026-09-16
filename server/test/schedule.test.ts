import { describe, expect, it } from 'vitest';
import {
  describeSchedule,
  isScheduleSpec,
  isValidCronExpression,
  isValidTimeZone,
  nextOccurrence,
  nextOccurrences,
} from '../src/scheduled/schedule.js';

describe('simple schedules', () => {
  it('validates the supported schedule vocabulary and IANA timezones', () => {
    expect(isScheduleSpec({ type: 'daily', time: '08:30' })).toBe(true);
    expect(isScheduleSpec({ type: 'weekly', time: '08:30', weekday: 7 })).toBe(false);
    expect(isScheduleSpec({ type: 'daily', time: '25:00' })).toBe(false);
    expect(isScheduleSpec({ type: 'cron', expression: '0 8-17 * * 1-5' })).toBe(true);
    expect(isScheduleSpec({ type: 'cron', expression: '0 0 8-17 * * 1-5' })).toBe(false);
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('Moon/Sea_of_Tranquility')).toBe(false);
  });

  it('validates five-field cron and returns several timezone-aware occurrences', () => {
    expect(isValidCronExpression('0 8-17 * * 1-5')).toBe(true);
    expect(isValidCronExpression('*/15 8-17 * * MON-FRI')).toBe(true);
    expect(isValidCronExpression('* * *')).toBe(false);
    expect(isValidCronExpression('* * * * * *')).toBe(false);
    expect(isValidCronExpression('H * * * *')).toBe(false);

    expect(
      nextOccurrences(
        { type: 'cron', expression: '0 8-17 * * 1-5' },
        'America/New_York',
        new Date('2026-07-20T11:30:00.000Z'),
        3,
      ).map((date) => date.toISOString()),
    ).toEqual([
      '2026-07-20T12:00:00.000Z',
      '2026-07-20T13:00:00.000Z',
      '2026-07-20T14:00:00.000Z',
    ]);
  });

  it('keeps advanced cron schedules at their local time across DST', () => {
    expect(
      nextOccurrences(
        { type: 'cron', expression: '0 8 * * 1-5' },
        'America/New_York',
        new Date('2026-03-06T13:00:00.000Z'),
        2,
      ).map((date) => date.toISOString()),
    ).toEqual(['2026-03-09T12:00:00.000Z', '2026-03-10T12:00:00.000Z']);
    expect(
      nextOccurrence(
        { type: 'cron', expression: '30 1 * * *' },
        'America/New_York',
        new Date('2026-11-01T05:30:00.000Z'),
      )?.toISOString(),
    ).toBe('2026-11-02T06:30:00.000Z');
  });

  it('finds daily, weekday, weekly, and one-time occurrences', () => {
    const mondayNoon = new Date('2026-07-20T12:00:00.000Z');
    expect(nextOccurrence({ type: 'daily', time: '13:30' }, 'UTC', mondayNoon)?.toISOString()).toBe(
      '2026-07-20T13:30:00.000Z',
    );
    expect(nextOccurrence({ type: 'weekdays', time: '09:00' }, 'UTC', new Date('2026-07-17T10:00:00Z'))?.toISOString()).toBe(
      '2026-07-20T09:00:00.000Z',
    );
    expect(nextOccurrence({ type: 'weekly', time: '09:00', weekday: 2 }, 'UTC', mondayNoon)?.toISOString()).toBe(
      '2026-07-21T09:00:00.000Z',
    );
    expect(nextOccurrence({ type: 'once', runAt: '2026-07-22T10:00:00Z' }, 'UTC', mondayNoon)?.toISOString()).toBe(
      '2026-07-22T10:00:00.000Z',
    );
    expect(nextOccurrence({ type: 'once', runAt: '2026-07-19T10:00:00Z' }, 'UTC', mondayNoon)).toBeNull();
  });

  it('handles a nonexistent daylight-saving local time by selecting the next valid day', () => {
    const result = nextOccurrence(
      { type: 'daily', time: '02:30' },
      'America/New_York',
      new Date('2026-03-08T06:55:00Z'),
    );
    expect(result?.toISOString()).toBe('2026-03-09T06:30:00.000Z');
  });

  it('does not run twice when a daylight-saving fall-back repeats a local minute', () => {
    const result = nextOccurrence(
      { type: 'daily', time: '01:30' },
      'America/New_York',
      new Date('2026-11-01T05:30:00Z'),
    );
    expect(result?.toISOString()).toBe('2026-11-02T06:30:00.000Z');
  });

  it('produces a plain-language schedule label', () => {
    expect(describeSchedule({ type: 'weekdays', time: '08:00' }, 'UTC')).toBe('Weekdays at 8:00 AM');
    expect(describeSchedule({ type: 'weekly', time: '17:15', weekday: 5 }, 'UTC')).toBe('Every Friday at 5:15 PM');
    expect(describeSchedule({ type: 'cron', expression: '0 8-17 * * 1-5' }, 'UTC')).toBe(
      'Cron: 0 8-17 * * 1-5',
    );
  });
});
