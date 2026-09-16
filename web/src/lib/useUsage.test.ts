import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UsageResponse, UsageWindow } from './api';
import {
  USAGE_PUSH_DEBOUNCE_MS,
  USAGE_STALE_MS,
  claudeRingModel,
  createPushDebouncer,
  codexRingModel,
  codexWeeklyWindow,
  isUsageStale,
  newestCapturedAtMs,
  ringAriaLabel,
  shouldReprobe,
} from './useUsage';

const NOW = Date.parse('2026-09-02T18:00:00.000Z');

function win(over: Partial<UsageWindow> & { id: string }): UsageWindow {
  return {
    label: over.id,
    usedPercent: 0,
    resetsAt: null,
    windowMinutes: null,
    status: null,
    ...over,
  };
}

function response(over: {
  claude?: Partial<UsageResponse['providers']['claude']>;
  codex?: Partial<UsageResponse['providers']['codex']>;
}): UsageResponse {
  const blank = {
    connected: false,
    planType: null,
    windows: [] as UsageWindow[],
    capturedAt: null,
    source: null,
    error: null,
  };
  return {
    providers: {
      claude: { ...blank, ...over.claude },
      codex: { ...blank, ...over.codex },
    },
    openrouter: { connected: false, capturedAt: null, summary: null, modelBreakdown: { configured: false, capturedAt: null, periods: { today: [], week: [], month: [], lifetime: [] }, error: null }, error: null },
  };
}

describe('usage staleness', () => {
  it('treats a missing or unparseable capture time as stale', () => {
    expect(isUsageStale(null, NOW)).toBe(true);
    expect(isUsageStale('not-a-time', NOW)).toBe(true);
  });

  it('goes stale only after five minutes', () => {
    const fresh = new Date(NOW - USAGE_STALE_MS + 1_000).toISOString();
    const old = new Date(NOW - USAGE_STALE_MS - 1_000).toISOString();
    expect(isUsageStale(fresh, NOW)).toBe(false);
    expect(isUsageStale(old, NOW)).toBe(true);
  });

  it('takes the newest capture across accounts and providers', () => {
    const usage = response({
      claude: {
        connected: true,
        capturedAt: new Date(NOW - 60_000).toISOString(),
        accounts: [
          {
            accountId: 'a',
            label: 'Pro',
            accountEmail: null,
            planType: null,
            active: true,
            limitReset: null,
            windows: [],
            capturedAt: new Date(NOW - 5_000).toISOString(),
            source: 'stream',
          },
        ],
      },
      codex: { connected: true, capturedAt: new Date(NOW - 600_000).toISOString() },
    });
    expect(newestCapturedAtMs(usage)).toBe(NOW - 5_000);
    expect(newestCapturedAtMs(null)).toBeNull();
  });
});

describe('re-probe policy', () => {
  it('never spends a probe with no chat open', () => {
    expect(shouldReprobe({ newestMs: null, chatOpen: false, now: NOW })).toBe(false);
    expect(shouldReprobe({ newestMs: NOW - USAGE_STALE_MS - 1, chatOpen: false, now: NOW })).toBe(false);
  });

  it('probes with a chat open once the newest snapshot passes five minutes', () => {
    expect(shouldReprobe({ newestMs: NOW - 60_000, chatOpen: true, now: NOW })).toBe(false);
    expect(shouldReprobe({ newestMs: NOW - USAGE_STALE_MS - 1, chatOpen: true, now: NOW })).toBe(true);
    expect(shouldReprobe({ newestMs: null, chatOpen: true, now: NOW })).toBe(true);
  });
});

describe('ring models', () => {
  it('renders nothing for a disconnected provider', () => {
    expect(claudeRingModel(response({}), NOW)).toBeNull();
    expect(codexRingModel(response({}), NOW)).toBeNull();
    expect(claudeRingModel(null, NOW)).toBeNull();
  });

  it('reads the ACTIVE Claude account, not simply the first', () => {
    const usage = response({
      claude: {
        connected: true,
        accounts: [
          {
            accountId: 'a',
            label: 'Personal',
            accountEmail: null,
            planType: null,
            active: false,
            limitReset: null,
            windows: [win({ id: 'five_hour', usedPercent: 12 })],
            capturedAt: new Date(NOW - 1_000).toISOString(),
            source: 'stream',
          },
          {
            accountId: 'b',
            label: 'Work',
            accountEmail: null,
            planType: null,
            active: true,
            limitReset: null,
            windows: [
              win({ id: 'five_hour', usedPercent: 71, resetsAt: new Date(NOW + 3_600_000).toISOString() }),
              win({ id: 'seven_day', usedPercent: 34 }),
            ],
            capturedAt: new Date(NOW - 1_000).toISOString(),
            source: 'stream',
          },
        ],
      },
    });
    const model = claudeRingModel(usage, NOW)!;

    expect(model.percent).toBe(71);
    expect(model.label).toBe('5hr');
    expect(model.stale).toBe(false);
    expect(model.primaryText).toBe('Claude · Work · 71% of 5hr used');
    expect(model.secondaryText).toContain('week 34%');
    expect(ringAriaLabel(model)).toMatch(/Open usage settings\.$/);
  });

  it('marks an old Claude snapshot stale but still shows the last known value', () => {
    const usage = response({
      claude: {
        connected: true,
        capturedAt: new Date(NOW - USAGE_STALE_MS - 1_000).toISOString(),
        windows: [win({ id: 'five_hour', usedPercent: 90 })],
      },
    });
    const model = claudeRingModel(usage, NOW)!;

    expect(model.stale).toBe(true);
    expect(model.unknown).toBe(false);
    expect(model.percent).toBe(90);
    expect(model.primaryText).not.toContain('stale');
  });

  it('marks a Claude account with no five-hour window as unknown', () => {
    const usage = response({
      claude: { connected: true, capturedAt: new Date(NOW).toISOString(), windows: [] },
    });
    const model = claudeRingModel(usage, NOW)!;

    expect(model.unknown).toBe(true);
    expect(model.stale).toBe(false);
  });

  it('picks Codex’s longest window as the weekly ring', () => {
    const windows = [
      win({ id: 'primary', usedPercent: 8, windowMinutes: 300 }),
      win({ id: 'secondary', usedPercent: 63, windowMinutes: 10080 }),
    ];
    expect(codexWeeklyWindow(windows)?.id).toBe('secondary');
    expect(codexWeeklyWindow([win({ id: 'primary', windowMinutes: 300 })])).toBeNull();

    const model = codexRingModel(
      response({
        codex: { connected: true, planType: 'Plus', capturedAt: new Date(NOW).toISOString(), windows },
      }),
      NOW,
    )!;
    expect(model.percent).toBe(63);
    expect(model.label).toBe('week');
    expect(model.primaryText).toBe('Codex · Plus · 63% of week used');
  });
});

describe('push debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('collapses a burst of pushes into a single fetch', () => {
    const load = vi.fn();
    const debouncer = createPushDebouncer(load);

    debouncer.push();
    debouncer.push();
    vi.advanceTimersByTime(USAGE_PUSH_DEBOUNCE_MS - 1);
    debouncer.push();
    expect(load).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(load).toHaveBeenCalledTimes(1);

    // The window has closed, so the next push arms a fresh timer.
    debouncer.push();
    vi.advanceTimersByTime(USAGE_PUSH_DEBOUNCE_MS);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('drops a pending fetch when the consumer unmounts', () => {
    const load = vi.fn();
    const debouncer = createPushDebouncer(load);

    debouncer.push();
    debouncer.cancel();
    vi.advanceTimersByTime(USAGE_PUSH_DEBOUNCE_MS * 2);
    expect(load).not.toHaveBeenCalled();
  });
});
