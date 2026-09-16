import { describe, expect, it, vi } from 'vitest';
import {
  claimClaudeLimitReset,
  createClaudeLimitResetManager,
  parseClaudeLimitResetStatus,
} from '../src/usage/claudeLimitReset.js';

const STATUS = {
  eligible: true,
  arm: 'reset',
  available: true,
  next_available_at: '2026-09-10T17:00:00Z',
  weekly_resets_at: '2026-09-08T12:00:00Z',
  resets_per_week: 1,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('Claude weekly session reset status', () => {
  it('accepts only Claude\'s eligible reset arm and keeps its cooldown authoritative', () => {
    expect(parseClaudeLimitResetStatus(STATUS, '2026-09-03T17:00:00Z')).toEqual({
      available: true,
      nextAvailableAt: '2026-09-10T17:00:00Z',
      weeklyResetsAt: '2026-09-08T12:00:00Z',
      resetsPerWeek: 1,
      capturedAt: '2026-09-03T17:00:00Z',
    });
    expect(parseClaudeLimitResetStatus({ ...STATUS, eligible: false, ineligible_reason: 'not_at_wall' })).toBeNull();
    expect(parseClaudeLimitResetStatus({ ...STATUS, arm: 'control' })).toBeNull();
  });

  it('does not POST when the provider says the weekly reset was already used', async () => {
    const fetchFn = vi.fn(() => Promise.resolve(json({
      juniper_tide: { ...STATUS, available: false },
    }))) as unknown as typeof fetch;

    const result = await claimClaudeLimitReset('token-b', fetchFn);
    expect(result.result).toBe('already_used');
    expect(result.status?.available).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('Claude weekly session reset claim', () => {
  it('preflights, claims for the selected token, and reports success only on result=reset', async () => {
    const urls: string[] = [];
    const fetchFn = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      if (url.includes('/api/oauth/usage')) return Promise.resolve(json({ juniper_tide: STATUS }));
      if (url.includes('/api/oauth/profile')) {
        return Promise.resolve(json({ organization: { uuid: 'org_selected' } }));
      }
      expect(init?.method).toBe('POST');
      expect(init?.body).toBe(JSON.stringify({ program: 'juniper_tide' }));
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer token-b');
      return Promise.resolve(json({ result: 'reset', next_available_at: '2026-09-10T17:00:00Z' }));
    }) as unknown as typeof fetch;

    const result = await claimClaudeLimitReset('token-b', fetchFn);
    expect(result).toMatchObject({ result: 'reset', status: { available: false } });
    expect(urls).toEqual([
      'https://api.anthropic.com/api/oauth/usage?at_wall=1&skip_spend=1',
      'https://api.anthropic.com/api/oauth/profile',
      'https://api.anthropic.com/api/organizations/org_selected/reset_rate_limits',
    ]);
  });

  it('single-flights double taps and never reads or changes an active account', async () => {
    const getTokenFor = vi.fn((id: string) => id === 'account-b' ? 'token-b' : null);
    const statuses: Array<{ id: string; available: boolean | null }> = [];
    const fetchFn = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/oauth/usage')) return Promise.resolve(json({ juniper_tide: STATUS }));
      if (url.includes('/api/oauth/profile')) return Promise.resolve(json({ organization: { uuid: 'org_b' } }));
      return Promise.resolve(json({ result: 'reset', next_available_at: '2026-09-10T17:00:00Z' }));
    }) as unknown as typeof fetch;
    const manager = createClaudeLimitResetManager({
      getTokenFor,
      fetchFn,
      onStatus: (id, status) => statuses.push({ id, available: status?.available ?? null }),
    });

    const [first, second] = await Promise.all([
      manager.claimForAccount('account-b'),
      manager.claimForAccount('account-b'),
    ]);
    expect(first.result).toBe('reset');
    expect(second).toEqual(first);
    expect(getTokenFor).toHaveBeenCalledTimes(1);
    expect(getTokenFor).toHaveBeenCalledWith('account-b');
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(statuses).toEqual([{ id: 'account-b', available: false }]);
  });

  it('does not claim success for an unreadable or transient provider response', async () => {
    const fetchFn = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/oauth/usage')) return Promise.resolve(json({ juniper_tide: STATUS }));
      if (url.includes('/api/oauth/profile')) return Promise.resolve(json({ organization: { uuid: 'org_b' } }));
      return Promise.resolve(json({ unexpected: true }));
    }) as unknown as typeof fetch;
    await expect(claimClaudeLimitReset('token-b', fetchFn)).resolves.toMatchObject({
      result: 'unavailable',
      status: { available: true },
    });
  });
});
