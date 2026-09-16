import { describe, expect, it, vi } from 'vitest';
import {
  createGrokUsageReader,
  grokPlanTypeFromEntry,
  grokTokenExpiryMs,
  pickGrokBillingEntry,
} from '../src/usage/grok.js';
import { buildGrokProvider, normalizeGrokBilling } from '../src/usage/contract.js';

const NOW = Date.UTC(2026, 7, 12, 18);
const TOKEN = 'test-grok-billing-token-not-a-real-secret';

const CREDITS_BODY = {
  config: {
    currentPeriod: {
      type: 'USAGE_PERIOD_TYPE_WEEKLY',
      start: '2026-08-10T19:43:17.117127+00:00',
      end: '2026-08-17T19:43:17.117127+00:00',
    },
    creditUsagePercent: 5.0,
    productUsage: [{ product: 'GrokBuild', usagePercent: 5.0 }],
    isUnifiedBillingUser: true,
    billingPeriodStart: '2026-08-10T19:43:17.117127+00:00',
    billingPeriodEnd: '2026-08-17T19:43:17.117127+00:00',
  },
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function authFile(overrides: Record<string, unknown> = {}) {
  return {
    'https://auth.x.ai::client-id': {
      key: TOKEN,
      expires_at: '2026-08-13T04:55:45.914767Z',
      auth_mode: 'oidc',
      email: 'user@example.com',
      ...overrides,
    },
  };
}

function connectedAuth(parsed: unknown) {
  return { connected: true as const, account: { email: 'user@example.com', handle: null, plan: null }, parsed };
}

describe('normalizeGrokBilling', () => {
  it('maps a live weekly credits payload to a 10080-minute window', () => {
    const snap = normalizeGrokBilling(CREDITS_BODY);
    expect(snap).toEqual({
      id: 'weekly',
      usedPercent: 5,
      resetsAt: '2026-08-17T19:43:17.117Z',
      windowMinutes: 10080,
    });
    const usage = buildGrokProvider(snap, true, 'SuperGrok Heavy', '2026-08-12T18:00:00.000Z', null);
    expect(usage).toMatchObject({
      connected: true,
      planType: 'SuperGrok Heavy',
      source: 'live',
      windows: [{ id: 'weekly', label: 'Weekly', usedPercent: 5, windowMinutes: 10080 }],
    });
  });

  it('returns null for dollar-format bodies that have no creditUsagePercent', () => {
    expect(
      normalizeGrokBilling({
        config: { monthlyLimit: { val: 0 }, used: { val: 0 }, billingPeriodEnd: '2026-09-01T00:00:00Z' },
      }),
    ).toBeNull();
  });
});

describe('pickGrokBillingEntry', () => {
  it('prefers the SuperGrok OIDC entry over the legacy sign-in scope', () => {
    const entry = pickGrokBillingEntry({
      'https://accounts.x.ai/sign-in': { key: 'legacy-token', expires_at: '2026-08-20T00:00:00Z' },
      'https://auth.x.ai::abc': { key: TOKEN, expires_at: '2026-08-13T00:00:00Z' },
    });
    expect(entry?.key).toBe(TOKEN);
  });

  it('does not treat a numeric JWT tier as a plan name', () => {
    expect(grokPlanTypeFromEntry({ key: TOKEN, tier: 5 }, null)).toBeNull();
    expect(grokPlanTypeFromEntry({ key: TOKEN, subscription_tier: 'SuperGrok Heavy' }, null)).toBe(
      'SuperGrok Heavy',
    );
  });
});

describe('Grok usage reader', () => {
  it('does not call xAI when Grok is not connected', async () => {
    const fetchImpl = vi.fn();
    const reader = createGrokUsageReader({
      getAuth: () => ({ connected: false, account: null, parsed: null }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    await expect(reader.read()).resolves.toMatchObject({ connected: false, windows: [], error: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns a live weekly window from the credits endpoint', async () => {
    const fetchImpl = vi.fn(async () => json(CREDITS_BODY));
    const reader = createGrokUsageReader({
      getAuth: () => connectedAuth(authFile({ subscription_tier: 'SuperGrok Heavy' })),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    const usage = await reader.read();
    expect(usage).toMatchObject({
      connected: true,
      planType: 'SuperGrok Heavy',
      source: 'live',
      windows: [{ id: 'weekly', label: 'Weekly', usedPercent: 5, windowMinutes: 10080 }],
    });
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(
      'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
    );
    expect(JSON.stringify(usage)).not.toContain(TOKEN);
  });

  it('asks to reconnect when the cached token is expired', async () => {
    const fetchImpl = vi.fn();
    const reader = createGrokUsageReader({
      getAuth: () => connectedAuth(authFile({ expires_at: '2026-08-01T00:00:00Z' })),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    const usage = await reader.read();
    expect(usage.connected).toBe(true);
    expect(usage.error).toMatch(/Reconnect/);
    expect(usage.windows).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(grokTokenExpiryMs({ expires_at: '2026-08-01T00:00:00Z' })).toBe(Date.parse('2026-08-01T00:00:00Z'));
  });

  it('asks to reconnect when auth.json is connected but has no token', async () => {
    const fetchImpl = vi.fn();
    const reader = createGrokUsageReader({
      getAuth: () => ({ connected: true, account: null, parsed: { note: 'empty' } }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    const usage = await reader.read();
    expect(usage).toMatchObject({ connected: true, windows: [], error: expect.stringMatching(/Reconnect/) });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports 401 as an expired sign-in without leaking the token', async () => {
    const fetchImpl = vi.fn(async () => json({ error: 'unauthorized' }, 401));
    const reader = createGrokUsageReader({
      getAuth: () => connectedAuth(authFile()),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    const usage = await reader.read();
    expect(usage).toMatchObject({ connected: true, windows: [], error: expect.stringMatching(/Reconnect/) });
    expect(JSON.stringify(usage)).not.toContain(TOKEN);
  });

  it('does not invent a 0% meter from a malformed body', async () => {
    const fetchImpl = vi.fn(async () => json({ config: { used: { val: 0 } } }));
    const reader = createGrokUsageReader({
      getAuth: () => connectedAuth(authFile()),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    const usage = await reader.read();
    expect(usage.windows).toEqual([]);
    expect(usage.error).toBe('Grok usage is unavailable.');
  });

  it('caches reads and refetches on refresh or after the TTL', async () => {
    let now = NOW;
    const fetchImpl = vi.fn(async () => json(CREDITS_BODY));
    const reader = createGrokUsageReader({
      getAuth: () => connectedAuth(authFile()),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => now,
      cacheTtlMs: 60_000,
    });
    await reader.read();
    await reader.read();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await reader.read(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    now = NOW + 61_000;
    await reader.read();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
