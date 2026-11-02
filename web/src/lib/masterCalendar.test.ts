import { describe, expect, it } from 'vitest';
import { formatRange, layoutDay, startOfDay } from './masterCalendar';
import { localInstant } from '@/components/calendar/EventDialogs';

const m = (minutes: number) => Date.parse('2026-11-02T13:00:00Z') + minutes * 60_000;

describe('master calendar layout', () => {
  it('puts overlapping events side by side and leaves separate ones full width', () => {
    const out = layoutDay([
      { id: 'a', startMs: m(0), endMs: m(60) },
      { id: 'b', startMs: m(30), endMs: m(90) },
      { id: 'c', startMs: m(60), endMs: m(120) },
      { id: 'd', startMs: m(180), endMs: m(240) },
    ]);
    const by = Object.fromEntries(out.map((e) => [e.id, [e.column, e.columns]]));
    expect(by).toEqual({ a: [0, 2], b: [1, 2], c: [0, 2], d: [0, 1] });
  });

  it('gives very short events room so they do not stack on top of each other', () => {
    const out = layoutDay([
      { id: 'a', startMs: m(0), endMs: m(0) },
      { id: 'b', startMs: m(5), endMs: m(10) },
    ]);
    expect(out.map((e) => e.columns)).toEqual([2, 2]);
  });

  it('writes local wall time with this device’s offset', () => {
    const value = localInstant('2026-11-02', '14:30');
    expect(value).toMatch(/^2026-11-02T14:30:00[+-]\d{2}:\d{2}$/);
    const d = new Date(value);
    expect([d.getHours(), d.getMinutes()]).toEqual([14, 30]);
  });

  it('labels all-day spans and starts days at local midnight', () => {
    const day = startOfDay(Date.parse('2026-11-02T15:00:00'));
    expect(new Date(day).getHours()).toBe(0);
    expect(formatRange({ allDay: true, startMs: day, endMs: day + 86_400_000 })).toMatch(/All day/);
    expect(formatRange({ allDay: true, startMs: day, endMs: day + 3 * 86_400_000 })).toContain('–');
  });
});
