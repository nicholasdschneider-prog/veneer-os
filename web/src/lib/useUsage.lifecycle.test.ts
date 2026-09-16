import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type UsageResponse } from './api';
import { codexRingModel, useUsage } from './useUsage';

// Run the hook's effect and state setters without a DOM; requests and account
// notifications use the real API module so the disconnect path is exercised.
const hooks = vi.hoisted(() => ({ states: [] as unknown[], cleanups: [] as (() => void)[] }));
vi.mock('react', () => ({
  useRef: (current: unknown) => ({ current }),
  useState: (initial: unknown) => {
    const index = hooks.states.length;
    const value = typeof initial === 'function' ? initial() : initial;
    hooks.states.push(value);
    return [value, (next: unknown) => { hooks.states[index] = next; }];
  },
  useEffect: (effect: () => () => void) => { hooks.cleanups.push(effect()); },
}));
vi.mock('./ws', () => ({ wsBus: { subscribeGlobal: () => () => {} } }));

function usage(connected: boolean, percent = 62): UsageResponse {
  const blank = { connected: false, planType: null, windows: [], capturedAt: null, source: null, error: null };
  return {
    providers: {
      claude: { ...blank, connected: true },
      grok: blank,
      codex: connected ? {
        ...blank, connected, planType: 'plus', capturedAt: new Date().toISOString(),
        windows: [{ id: 'secondary', label: 'week', usedPercent: percent, resetsAt: null, windowMinutes: 10080, status: null }],
      } : blank,
    },
    openrouter: { connected: false, capturedAt: null, summary: null, modelBreakdown: { configured: false, capturedAt: null, periods: { today: [], week: [], month: [], lifetime: [] }, error: null }, error: null },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const current = () => hooks.states[0] as UsageResponse | null;
const flush = () => vi.advanceTimersByTimeAsync(0);
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  hooks.states.length = 0;
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  for (const cleanup of hooks.cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Codex usage disconnect lifecycle', () => {
  it('removes the ring before the refresh returns, while preserving Claude', async () => {
    const refresh = deferred<Response>();
    fetchMock.mockResolvedValueOnce(json(usage(true)))
      .mockResolvedValueOnce(json({ ok: true, connected: false }))
      .mockReturnValueOnce(refresh.promise);
    useUsage(false);
    await flush();
    expect(codexRingModel(current(), Date.now())?.percent).toBe(62);
    await api.codexDisconnect();
    expect(codexRingModel(current(), Date.now())).toBeNull();
    expect(current()?.providers.codex.windows).toEqual([]);
    expect(current()?.providers.claude.connected).toBe(true);
    refresh.resolve(json(usage(false)));
    await flush();
    expect(codexRingModel(current(), Date.now())).toBeNull();
  });

  it.each(['resolve', 'reject'] as const)('ignores an older request that later %ss', async (outcome) => {
    const old = deferred<Response>();
    fetchMock.mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(json({ ok: true, connected: false }))
      .mockResolvedValueOnce(json(usage(false)));
    useUsage(false);
    await api.codexDisconnect();
    await flush();
    if (outcome === 'resolve') old.resolve(json(usage(true)));
    else old.reject(new Error('old request failed'));
    await flush();
    expect(current()?.providers.codex.connected).toBe(false);
    expect(hooks.states[1]).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retains the ring when logout fails', async () => {
    fetchMock.mockResolvedValueOnce(json(usage(true)))
      .mockResolvedValueOnce(json({ ok: false, error: 'Logout failed' }));
    useUsage(false);
    await flush();
    await expect(api.codexDisconnect()).rejects.toThrow('Logout failed');
    expect(codexRingModel(current(), Date.now())?.percent).toBe(62);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('loads the new account when sign-in succeeds without a chat open', async () => {
    fetchMock.mockResolvedValueOnce(json(usage(false)))
      .mockResolvedValueOnce(json({ ok: true, state: 'success', detail: '' }))
      .mockResolvedValueOnce(json(usage(true, 4)));
    useUsage(false);
    await flush();
    await api.codexConnectPoll('attempt');
    await flush();
    expect(codexRingModel(current(), Date.now())?.percent).toBe(4);
  });

  it('recovers from a failed usage read after a successful sign-in', async () => {
    fetchMock.mockRejectedValueOnce(new Error('server restarting'))
      .mockResolvedValueOnce(json({ ok: true, state: 'success', detail: '' }))
      .mockResolvedValueOnce(json(usage(true, 4)));
    useUsage(false);
    await flush();
    expect(hooks.states[1]).toBe(true);
    await api.codexConnectPoll('attempt');
    await flush();
    expect(hooks.states[1]).toBe(false);
    expect(codexRingModel(current(), Date.now())?.percent).toBe(4);
  });

  it('clears the previous meter when replacement sign-in starts', async () => {
    const refresh = deferred<Response>();
    fetchMock.mockResolvedValueOnce(json(usage(true)))
      .mockResolvedValueOnce(json({ ok: true, attemptId: 'replacement' }))
      .mockReturnValueOnce(refresh.promise);
    useUsage(false);
    await flush();
    await api.codexConnectStart(true);
    expect(codexRingModel(current(), Date.now())).toBeNull();
    refresh.resolve(json(usage(false)));
    await flush();
    expect(current()?.providers.codex.connected).toBe(false);
  });

  it('stops listening when the navigation unmounts', async () => {
    fetchMock.mockResolvedValueOnce(json(usage(true)))
      .mockResolvedValueOnce(json({ ok: true, connected: false }));
    useUsage(false);
    await flush();
    hooks.cleanups.pop()!();
    await api.codexDisconnect();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
