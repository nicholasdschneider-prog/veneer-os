const OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage?at_wall=1&skip_spend=1';
const OAUTH_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const API_BASE_URL = 'https://api.anthropic.com';
const REQUEST_TIMEOUT_MS = 25_000;
const PROGRAM = 'juniper_tide';

export interface ClaudeLimitResetStatus {
  /** Claude currently offers the reset for this account at its session wall. */
  available: boolean;
  /** Provider-reported next time this once-weekly action becomes available. */
  nextAvailableAt: string | null;
  /** Current weekly usage window reset, when Claude reports it. */
  weeklyResetsAt: string | null;
  /** Provider policy, currently one. Never inferred locally. */
  resetsPerWeek: number;
  capturedAt: string;
}

export type ClaudeLimitResetResult =
  | 'reset'
  | 'already_used'
  | 'not_limited'
  | 'ineligible'
  | 'unavailable';

export interface ClaudeLimitResetClaim {
  result: ClaudeLimitResetResult;
  status: ClaudeLimitResetStatus | null;
}

type FetchLike = typeof fetch;

function oauthHeaders(json = false): Record<string, string> {
  return {
    'anthropic-beta': 'oauth-2025-04-20',
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

function bearerHeaders(token: string, json = false): Record<string, string> {
  return { Authorization: `Bearer ${token}`, ...oauthHeaders(json) };
}

function timestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return value;
}

/**
 * Normalize Claude Code's feature block. Ineligible/not-at-wall accounts return
 * null so the Usage tab stays quiet until the action is actually relevant.
 */
export function parseClaudeLimitResetStatus(
  value: unknown,
  capturedAt = new Date().toISOString(),
): ClaudeLimitResetStatus | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.eligible !== true || raw.arm !== 'reset') return null;
  const count = typeof raw.resets_per_week === 'number' && Number.isFinite(raw.resets_per_week)
    ? Math.max(1, Math.round(raw.resets_per_week))
    : 1;
  return {
    available: raw.available === true,
    nextAvailableAt: timestamp(raw.next_available_at),
    weeklyResetsAt: timestamp(raw.weekly_resets_at),
    resetsPerWeek: count,
    capturedAt,
  };
}

async function responseJson(res: Response): Promise<Record<string, unknown> | null> {
  const body = await res.json().catch(() => null);
  return body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : null;
}

/** Live, read-only eligibility check used both by probes and immediately before a claim. */
export async function fetchClaudeLimitResetStatus(
  token: string,
  fetchFn: FetchLike = fetch,
): Promise<ClaudeLimitResetStatus | null> {
  const res = await fetchFn(OAUTH_USAGE_URL, {
    headers: bearerHeaders(token),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.status === 401 || res.status === 403) {
    await res.text().catch(() => undefined);
    return null;
  }
  if (!res.ok) {
    await res.text().catch(() => undefined);
    throw new Error(`Claude reset eligibility check failed: HTTP ${res.status}`);
  }
  const body = await responseJson(res);
  return parseClaudeLimitResetStatus(body?.juniper_tide);
}

async function organizationUuid(token: string, fetchFn: FetchLike): Promise<string | null> {
  const res = await fetchFn(OAUTH_PROFILE_URL, {
    headers: bearerHeaders(token),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    await res.text().catch(() => undefined);
    return null;
  }
  const body = await responseJson(res);
  const organization = body?.organization;
  if (!organization || typeof organization !== 'object' || Array.isArray(organization)) return null;
  const uuid = (organization as Record<string, unknown>).uuid;
  return typeof uuid === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(uuid) ? uuid : null;
}

function claimResult(value: unknown): ClaudeLimitResetResult | null {
  switch (value) {
    case 'reset':
    case 'already_used':
    case 'not_limited':
    case 'ineligible':
    case 'unavailable':
      return value;
    default:
      return null;
  }
}

/**
 * Claim one reset for one token. The live preflight is deliberate: a stale UI
 * must never spend the account's weekly action after Claude withdrew it.
 */
export async function claimClaudeLimitReset(
  token: string,
  fetchFn: FetchLike = fetch,
): Promise<ClaudeLimitResetClaim> {
  const status = await fetchClaudeLimitResetStatus(token, fetchFn);
  if (!status) return { result: 'ineligible', status: null };
  if (!status.available) return { result: 'already_used', status };

  const uuid = await organizationUuid(token, fetchFn);
  if (!uuid) return { result: 'unavailable', status };
  const res = await fetchFn(`${API_BASE_URL}/api/organizations/${encodeURIComponent(uuid)}/reset_rate_limits`, {
    method: 'POST',
    headers: bearerHeaders(token, true),
    body: JSON.stringify({ program: PROGRAM }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    await res.text().catch(() => undefined);
    return { result: 'unavailable', status };
  }
  const body = await responseJson(res);
  const result = claimResult(body?.result);
  if (!result) return { result: 'unavailable', status };

  if (result === 'reset' || result === 'already_used') {
    return {
      result,
      status: {
        ...status,
        available: false,
        nextAvailableAt: timestamp(body?.next_available_at) ?? status.nextAvailableAt,
        capturedAt: new Date().toISOString(),
      },
    };
  }
  // No reset happened. Hide a now-irrelevant action after "not limited" or
  // "ineligible"; keep it retryable only for a transient provider failure.
  return { result, status: result === 'unavailable' ? status : null };
}

export interface ClaudeLimitResetManager {
  claimForAccount(accountId: string): Promise<ClaudeLimitResetClaim>;
}

/** Account-scoped single-flight guard: double taps can produce at most one POST. */
export function createClaudeLimitResetManager({
  getTokenFor,
  onStatus,
  fetchFn = fetch,
}: {
  getTokenFor: (accountId: string) => string | null;
  onStatus?: (accountId: string, status: ClaudeLimitResetStatus | null) => void;
  fetchFn?: FetchLike;
}): ClaudeLimitResetManager {
  const inFlight = new Map<string, Promise<ClaudeLimitResetClaim>>();
  return {
    claimForAccount(accountId) {
      const running = inFlight.get(accountId);
      if (running) return running;
      const token = getTokenFor(accountId);
      if (!token) return Promise.reject(new Error('Claude account is no longer connected.'));
      const run = claimClaudeLimitReset(token, fetchFn)
        .then((result) => {
          onStatus?.(accountId, result.status);
          return result;
        })
        .finally(() => inFlight.delete(accountId));
      inFlight.set(accountId, run);
      return run;
    },
  };
}
