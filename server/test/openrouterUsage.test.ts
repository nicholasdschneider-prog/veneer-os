import { describe, expect, it, vi } from 'vitest';
import { createOpenRouterUsageReader, emptyOpenRouterModelBreakdown } from '../src/usage/openrouter.js';


const NOW = Date.UTC(2026, 6, 20, 12);
const noModelBreakdown = async () => emptyOpenRouterModelBreakdown();

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('OpenRouter usage reader', () => {
  it('does not call OpenRouter when no inference key is configured', async () => {
    const fetchImpl = vi.fn();
    const reader = createOpenRouterUsageReader({
      getApiKey: () => null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
      getModelBreakdown: noModelBreakdown,
    });

    await expect(reader.read()).resolves.toMatchObject({ connected: false, summary: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns exact totals for the active inference key', async () => {
    const fetchImpl = vi.fn(async () =>
      json({
        data: {
          usage: 39.63,
          usage_daily: 0.43,
          usage_weekly: '1.25',
          usage_monthly: 4.5,
          limit: 25,
          limit_remaining: 20.5,
          limit_reset: 'monthly',
        },
      }),
    );
    const reader = createOpenRouterUsageReader({
      getApiKey: () => 'inference-secret',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
      getModelBreakdown: noModelBreakdown,
    });

    const usage = await reader.read();
    expect(usage.summary).toEqual({
      todayUsd: 0.43,
      weekUsd: 1.25,
      monthUsd: 4.5,
      lifetimeUsd: 39.63,
      limitUsd: 25,
      remainingUsd: 20.5,
      limitReset: 'monthly',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe('https://openrouter.ai/api/v1/key');
    expect(JSON.stringify(usage)).not.toContain('secret');
  });

  it('reports an OpenRouter error without exposing key material', async () => {
    const fetchImpl = vi.fn(async () => json({ error: 'unauthorized' }, 401));
    const reader = createOpenRouterUsageReader({
      getApiKey: () => 'inference-secret',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
      getModelBreakdown: noModelBreakdown,
    });

    const usage = await reader.read();
    expect(usage).toMatchObject({
      connected: true,
      summary: null,
      error: 'OpenRouter returned 401',
    });
    expect(JSON.stringify(usage)).not.toContain('secret');
  });

  it('caches reads, while an explicit refresh fetches again', async () => {
    const fetchImpl = vi.fn(async () => json({ data: { usage: 1 } }));
    const reader = createOpenRouterUsageReader({
      getApiKey: () => 'inference-secret',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
      getModelBreakdown: noModelBreakdown,
    });

    await reader.read();
    await reader.read();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await reader.read(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('reports an empty model breakdown when nothing supplies one', async () => {
    const fetchImpl = vi.fn(async () => json({ data: { usage: 1 } }));
    const reader = createOpenRouterUsageReader({
      getApiKey: () => 'inference-secret',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });

    await expect(reader.read()).resolves.toMatchObject({
      modelBreakdown: emptyOpenRouterModelBreakdown(),
    });
  });
});
