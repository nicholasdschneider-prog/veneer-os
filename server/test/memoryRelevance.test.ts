import { describe, expect, it, vi } from 'vitest';
import { createOpenRouterMemoryRelevanceSelector } from '../src/memory/relevance.js';

describe('memory semantic relevance selector', () => {
  it('uses strict structured output and returns only decisions for supplied candidates', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        decisions: [
          { id: 'global:one', relevant: true, reason: 'operational' },
          { id: 'invented', relevant: true, reason: 'material' },
        ],
      }) } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const selector = createOpenRouterMemoryRelevanceSelector({
      getApiKey: () => 'test-key',
      fetchImpl,
    });

    await expect(selector({
      query: 'Do I need to enter the queue?',
      candidates: [{ id: 'global:one', content: 'Implementation work joins the build queue.', similarity: 0.7, scope: 'global' }],
    })).resolves.toEqual({
      model: 'openai/gpt-5.6-luna',
      decisions: [{ id: 'global:one', relevant: true, reason: 'operational' }],
    });

    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body.response_format).toEqual(expect.objectContaining({ type: 'json_schema' }));
    expect(body.provider).toEqual({ require_parameters: true });
    expect(body.reasoning).toEqual({ enabled: false });
    expect(body.seed).toBe(0);
    expect(body).not.toHaveProperty('temperature');
  });

  it('fails closed when no relevance key is configured', async () => {
    const selector = createOpenRouterMemoryRelevanceSelector({ getApiKey: () => null });
    await expect(selector({
      query: 'anything',
      candidates: [{ id: 'x', content: 'A candidate', similarity: 0.8, scope: 'global' }],
    })).rejects.toThrow('not configured');
  });
});
