import { describe, expect, it } from 'vitest';
import { windowSummary } from './AccountSwitcher';
import type { UsageWindow } from '../../lib/api';

const win = (over: Partial<UsageWindow>): UsageWindow => ({
  id: 'x', label: 'x', usedPercent: 0, resetsAt: null, windowMinutes: null, status: null, ...over,
});

describe('account switcher window summary', () => {
  it('reads Claude windows by id', () => {
    expect(windowSummary([
      win({ id: 'five_hour', usedPercent: 42.4 }),
      win({ id: 'seven_day', usedPercent: 10 }),
    ])).toBe('5h 42% · wk 10%');
  });

  it('reads Codex windows by length, whichever bucket they arrive in', () => {
    expect(windowSummary([
      win({ id: 'primary', usedPercent: 33, windowMinutes: 300 }),
      win({ id: 'secondary', usedPercent: 80, windowMinutes: 10080 }),
    ])).toBe('5h 33% · wk 80%');
    expect(windowSummary([win({ id: 'secondary', usedPercent: 80, windowMinutes: 10080 })])).toBe('wk 80%');
  });

  it('says so when there is no reading', () => {
    expect(windowSummary([])).toBe('no data');
  });
});
