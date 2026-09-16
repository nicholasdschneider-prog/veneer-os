import crypto from 'node:crypto';

export const OPENROUTER_SPEND_PERIODS = ['today', 'week', 'month', 'lifetime'] as const;
export type OpenRouterSpendPeriod = (typeof OPENROUTER_SPEND_PERIODS)[number];

export interface OpenRouterModelSpend {
  model: string;
  costUsd: number;
  requestCount: number;
  tokensTotal: number;
}

/**
 * Per-model spend analytics. Veneer OS has no aggregation service to read them
 * from, so the breakdown is always empty unless a caller injects a reader.
 */
export interface OpenRouterModelBreakdown {
  configured: boolean;
  capturedAt: string | null;
  periods: Record<OpenRouterSpendPeriod, OpenRouterModelSpend[]>;
  error: string | null;
}

export function emptyOpenRouterModelBreakdown(
  configured = false,
  error: string | null = null,
): OpenRouterModelBreakdown {
  return {
    configured,
    capturedAt: null,
    periods: { today: [], week: [], month: [], lifetime: [] },
    error,
  };
}

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const CACHE_TTL_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

export interface OpenRouterSpendSummary {
  todayUsd: number;
  weekUsd: number;
  monthUsd: number;
  lifetimeUsd: number;
  limitUsd: number | null;
  remainingUsd: number | null;
  limitReset: string | null;
}

export interface OpenRouterUsage {
  connected: boolean;
  capturedAt: string | null;
  summary: OpenRouterSpendSummary | null;
  modelBreakdown: OpenRouterModelBreakdown;
  error: string | null;
}

export interface OpenRouterUsageReader {
  read(refresh?: boolean): Promise<OpenRouterUsage>;
}

export interface OpenRouterUsageReaderOptions {
  getApiKey: () => string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  cacheTtlMs?: number;
  requestTimeoutMs?: number;
  getModelBreakdown?: (refresh: boolean) => Promise<OpenRouterModelBreakdown>;
}

interface CurrentKeyData {
  usage?: unknown;
  usage_daily?: unknown;
  usage_weekly?: unknown;
  usage_monthly?: unknown;
  limit?: unknown;
  limit_remaining?: unknown;
  limit_reset?: unknown;
}

function numberOrZero(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : 0;
  return Number.isFinite(n) ? n : 0;
}

function numberOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function baseUsage(connected: boolean): OpenRouterUsage {
  return {
    connected,
    capturedAt: null,
    summary: null,
    modelBreakdown: emptyOpenRouterModelBreakdown(),
    error: null,
  };
}

function fingerprint(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}

async function jsonResponse(res: Response): Promise<Record<string, unknown>> {
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) throw new Error(`OpenRouter returned ${res.status}`);
  if (!body || typeof body !== 'object') throw new Error('OpenRouter returned an invalid response');
  return body as Record<string, unknown>;
}

export function createOpenRouterUsageReader(opts: OpenRouterUsageReaderOptions): OpenRouterUsageReader {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const cacheTtl = opts.cacheTtlMs ?? CACHE_TTL_MS;
  const timeout = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const getModelBreakdown = opts.getModelBreakdown ?? (async () => emptyOpenRouterModelBreakdown());
  let cache: { fingerprint: string; expiresAt: number; value: OpenRouterUsage } | null = null;
  let inFlight: { fingerprint: string; promise: Promise<OpenRouterUsage> } | null = null;

  const request = (url: string, key: string): Promise<Response> =>
    fetchImpl(url, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(timeout),
    });

  const load = async (apiKey: string, refresh: boolean): Promise<OpenRouterUsage> => {
    const capturedAt = new Date(now()).toISOString();
    const output = baseUsage(true);
    output.capturedAt = capturedAt;
    const modelBreakdown = getModelBreakdown(refresh).catch(() =>
      emptyOpenRouterModelBreakdown(true, 'OpenRouter analytics could not be loaded.'),
    );

    try {
      const body = await jsonResponse(await request(`${OPENROUTER_BASE_URL}/key`, apiKey));
      const current = (body.data ?? {}) as CurrentKeyData;
      output.summary = {
        todayUsd: numberOrZero(current.usage_daily),
        weekUsd: numberOrZero(current.usage_weekly),
        monthUsd: numberOrZero(current.usage_monthly),
        lifetimeUsd: numberOrZero(current.usage),
        limitUsd: numberOrNull(current.limit),
        remainingUsd: numberOrNull(current.limit_remaining),
        limitReset: stringOrNull(current.limit_reset),
      };
    } catch (err) {
      output.error = err instanceof Error ? err.message : 'Unable to read OpenRouter usage';
      output.modelBreakdown = await modelBreakdown;
      return output;
    }
    output.modelBreakdown = await modelBreakdown;
    return output;
  };

  return {
    async read(refresh = false): Promise<OpenRouterUsage> {
      const apiKey = opts.getApiKey()?.trim() || null;
      if (!apiKey) return baseUsage(false);
      const id = fingerprint(apiKey);
      const at = now();
      if (!refresh && cache?.fingerprint === id && cache.expiresAt > at) return cache.value;
      if (inFlight?.fingerprint === id) return inFlight.promise;
      const promise = load(apiKey, refresh).then((value) => {
        cache = { fingerprint: id, expiresAt: now() + cacheTtl, value };
        return value;
      });
      inFlight = { fingerprint: id, promise };
      try {
        return await promise;
      } finally {
        if (inFlight?.promise === promise) inFlight = null;
      }
    },
  };
}
