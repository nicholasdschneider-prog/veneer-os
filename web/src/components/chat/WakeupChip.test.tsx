import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { formatWakeRelative, quickAdjust, wakeTickMs, WakeupChip } from './WakeupChip';

const NOW = new Date('2026-08-24T15:00:00.000Z');
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

const wake = {
  id: 'wake-1',
  key: 'build-check',
  reason: 'Re-check build #684 for completion, then summarize the failures.',
  scheduledFor: at(18 * 60_000),
  createdAt: at(-2 * 60_000),
};

function render(props: Partial<Parameters<typeof WakeupChip>[0]> = {}) {
  return renderToStaticMarkup(
    <WakeupChip
      wakeups={[wake]}
      onFire={() => undefined}
      onCancel={() => undefined}
      onReschedule={async () => ({ ok: true })}
      now={NOW}
      {...props}
    />,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('formatWakeRelative', () => {
  it('counts seconds under two minutes and minutes above it', () => {
    expect(formatWakeRelative(at(95_000), NOW)).toEqual({ text: 'in 1:35', tabular: true });
    expect(formatWakeRelative(at(18 * 60_000), NOW)).toEqual({ text: 'in 18 min', tabular: false });
  });

  it('switches to hours past 90 minutes and to a day label past 24 hours', () => {
    expect(formatWakeRelative(at(135 * 60_000), NOW).text).toBe('in 2 h 15 min');
    expect(formatWakeRelative(at(2 * 60 * 60_000), NOW).text).toBe('in 2 h');
    expect(formatWakeRelative(at(30 * 60 * 60_000), NOW).text).toMatch(/^tomorrow /);
    expect(formatWakeRelative(at(4 * 24 * 60 * 60_000), NOW).text).not.toMatch(/^tomorrow /);
  });

  it('ticks per second only inside the seconds band', () => {
    expect(wakeTickMs(at(45_000), NOW)).toBe(1_000);
    expect(wakeTickMs(at(18 * 60_000), NOW)).toBe(30_000);
  });
});

describe('quickAdjust', () => {
  it('moves relative to the edited time and clamps into the future', () => {
    expect(quickAdjust(at(18 * 60_000), 15 * 60_000, NOW)).toBe(at(33 * 60_000));
    expect(quickAdjust(at(2 * 60_000), -5 * 60_000, NOW)).toBe(at(60_000));
  });
});

describe('WakeupChip', () => {
  it('renders the countdown, absolute time, and reason collapsed', () => {
    const html = render();
    expect(html).toContain('in 18 min');
    expect(html).toContain('Re-check build #684');
    expect(html).toContain('aria-label="Wake the agent now"');
    expect(html).toContain('aria-label="Cancel the wake-up"');
  });

  it('renders nothing without a pending wake', () => {
    expect(render({ wakeups: [] })).toBe('');
  });

  it('summarizes several pending wakes by count and next time', () => {
    const html = render({
      wakeups: [wake, { ...wake, id: 'wake-2', key: 'unit-size-review', scheduledFor: at(26 * 60 * 60_000) }],
    });
    expect(html).toContain('2 wake-ups');
    expect(html).toContain('· next ');
  });

  it('caps the expanded reason in a scroll area instead of growing the composer', () => {
    const html = render({ defaultOpen: true });
    expect(html).toContain('max-h-[min(40dvh,24rem)]');
    expect(html).toContain('overflow-y-auto');
    expect(html).toContain('overscroll-contain');
  });

  it('saves an edited time as a future ISO PATCH', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const runAt = at(45 * 60_000);
    await api.rescheduleWakeup('conv-1', wake.id, runAt);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/conversations/conv-1/wakeups/${wake.id}`,
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ runAt }) }),
    );
    expect(Date.parse(runAt)).toBeGreaterThan(NOW.getTime());
  });

  it('fires through the fire endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    await api.fireWakeup('conv-1', wake.id);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/conversations/conv-1/wakeups/${wake.id}/fire`,
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
