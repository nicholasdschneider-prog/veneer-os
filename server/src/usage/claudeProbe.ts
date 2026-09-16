import type { RateLimitInfo } from '../providers/claude/wire.js';
import { redactToken } from '../claude/setupToken.js';
import { LEGACY_ACCOUNT_ID, type UsageStore } from './store.js';
import { parseClaudeLimitResetStatus, type ClaudeLimitResetStatus } from './claudeLimitReset.js';

/**
 * Optional active refresh of Claude usage, best source first:
 *
 * 1. `GET /api/oauth/usage` — what Claude Code's own /usage screen renders
 *    (verified against CLI 2.1.200's bundled fetchUtilization). Free (no
 *    tokens), and the only source that carries the model-scoped weeklies
 *    ("Current week (Fable 5)") plus the plan name. Needs the `user:profile`
 *    scope, which tokens connected before 2026-07-20 lack (403) — the connect
 *    flow now requests it (see claude/setupToken.ts widenScopes).
 * 2. Fallback: the unified rate-limit headers on a 1-max-token haiku call
 *    (`anthropic-ratelimit-unified-5h-*` / `-7d-*`, verified live 2026-07-06).
 *    Covers only the 5-hour + overall weekly windows; premium-model probes
 *    that would surface more get policy-429'd without headers (verified
 *    2026-07-20), so this is as far as headers go.
 *
 * Stream events can't replace either: they report only the single binding
 * window and omit `utilization` below the warning threshold. Guarded by a
 * timeout and single-flighted so a burst of `?refresh=1` requests can never
 * run two probes at once.
 */

const PROBE_TIMEOUT_MS = 15_000;
const API_URL = 'https://api.anthropic.com/v1/messages';
// Claude Code's own reset flow requests the wall-aware shape. It returns the
// same usage windows plus the read-only `juniper_tide` eligibility block.
const OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage?at_wall=1&skip_spend=1';
const OAUTH_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';

/** unified header infix → our rateLimitType (matches the stream's naming). */
const HEADER_WINDOWS: ReadonlyArray<readonly [infix: string, type: string]> = [
  ['5h', 'five_hour'],
  ['7d', 'seven_day'],
];

/** Run one probe request; resolve with every window its headers reported. */
export async function probeClaudeRateLimits(token: string, fetchFn: typeof fetch = fetch): Promise<RateLimitInfo[]> {
  const res = await fetchFn(API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ok' }],
    }),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  // Consume the (tiny) body so the socket is released either way.
  await res.text().catch(() => undefined);

  const infos: RateLimitInfo[] = [];
  for (const [infix, rateLimitType] of HEADER_WINDOWS) {
    const utilization = Number(res.headers.get(`anthropic-ratelimit-unified-${infix}-utilization`) ?? NaN);
    if (!Number.isFinite(utilization)) continue;
    const reset = Number(res.headers.get(`anthropic-ratelimit-unified-${infix}-reset`) ?? NaN);
    const status = res.headers.get(`anthropic-ratelimit-unified-${infix}-status`);
    infos.push({
      rateLimitType,
      utilization,
      ...(Number.isFinite(reset) && reset > 0 ? { resetsAt: reset } : {}),
      ...(status ? { status } : {}),
    });
  }
  // Rate-limited (429) responses still carry the headers; only treat an error
  // status as a failure when it also produced no telemetry.
  if (infos.length === 0 && !res.ok) throw new Error(`probe request failed: HTTP ${res.status}`);
  return infos;
}

export interface OauthUsageWindow extends RateLimitInfo {
  label?: string;
}

export interface OauthUsageResult {
  infos: OauthUsageWindow[];
  planType: string | null;
  limitReset?: ClaudeLimitResetStatus | null;
}

/** OAuth usage reports whole percents (77); the store keeps fractions (0.77). */
function fractionFromPercent(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v / 100 : null;
}

/** resets_at: accept epoch seconds, epoch ms, or an ISO string → epoch seconds. */
function epochSecondsFrom(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    return v > 1e12 ? Math.round(v / 1000) : Math.round(v);
  }
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (Number.isFinite(t) && t > 0) return Math.round(t / 1000);
  }
  return undefined;
}

/** `seven_day_fable_5` from "Fable 5" — a stable per-model window id. */
function scopedWindowType(displayName: string): string {
  return `seven_day_${displayName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
}

function oauthWindow(rateLimitType: string, raw: unknown, label?: string): OauthUsageWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as Record<string, unknown>;
  // Named windows carry `utilization`, model-scoped entries carry `percent`
  // (Claude Code maps the latter into the former for rendering — same units).
  const utilization = fractionFromPercent(w.utilization ?? w.percent);
  if (utilization == null) return null;
  const resetsAt = epochSecondsFrom(w.resets_at);
  return {
    rateLimitType,
    utilization,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(typeof w.status === 'string' ? { status: w.status } : {}),
    ...(label ? { label } : {}),
  };
}

/**
 * Fetch `GET /api/oauth/usage` — the endpoint behind Claude Code's /usage
 * screen. Returns null when the token lacks the `user:profile` scope (403) so
 * the caller can fall back to the header probe. Shape (from the CLI bundle):
 * `{ rate_limits: { five_hour, seven_day, seven_day_sonnet?, limits?: [
 *    { kind: "weekly_scoped", scope: { model: { display_name } }, percent,
 *      resets_at } ] }, subscription_type }` — or, since mid-2026, the same
 * fields at the TOP level with no `rate_limits` wrapper and no
 * `subscription_type` (verified live 2026-07-23).
 */
export async function fetchClaudeOauthUsage(
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<OauthUsageResult | null> {
  const res = await fetchFn(OAUTH_USAGE_URL, {
    headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  if (res.status === 403) {
    await res.text().catch(() => undefined);
    return null; // pre-user:profile token — caller falls back to the header probe
  }
  if (!res.ok) {
    await res.text().catch(() => undefined);
    throw new Error(`oauth usage failed: HTTP ${res.status}`);
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  // Mid-2026 the endpoint dropped the `rate_limits` wrapper — five_hour /
  // seven_day / limits[] now sit at the top level (and subscription_type is
  // gone). Accept both shapes.
  const rl = (body?.rate_limits ?? body ?? {}) as Record<string, unknown>;

  const infos: OauthUsageWindow[] = [];
  const push = (w: OauthUsageWindow | null): void => {
    if (w) infos.push(w);
  };
  push(oauthWindow('five_hour', rl.five_hour));
  push(oauthWindow('seven_day', rl.seven_day));
  push(oauthWindow('seven_day_sonnet', rl.seven_day_sonnet, 'Weekly (Sonnet)'));
  if (Array.isArray(rl.limits)) {
    for (const item of rl.limits as Array<Record<string, unknown>>) {
      if (!item || typeof item !== 'object' || item.kind !== 'weekly_scoped') continue;
      const model = (item.scope as Record<string, unknown> | undefined)?.model as
        | Record<string, unknown>
        | undefined;
      const displayName = typeof model?.display_name === 'string' ? model.display_name : null;
      if (!displayName) continue;
      push(oauthWindow(scopedWindowType(displayName), item, `Weekly (${displayName})`));
    }
  }
  if (infos.length === 0) throw new Error('oauth usage returned no recognizable windows');
  return {
    infos,
    planType: typeof body?.subscription_type === 'string' ? body.subscription_type : null,
    limitReset: parseClaudeLimitResetStatus(body?.juniper_tide),
  };
}

export interface OauthProfile {
  email: string | null;
  /** Human plan label ("Max 20x") derived from the org's rate-limit tier. */
  planType: string | null;
}

/**
 * "default_claude_max_20x" → "Max 20x", "claude_pro" → "Pro". Falls back to
 * the raw organization_type so an unknown tier still says something.
 */
export function planLabelFromProfile(rateLimitTier: unknown, organizationType: unknown): string | null {
  for (const v of [rateLimitTier, organizationType]) {
    if (typeof v !== 'string') continue;
    const m = /claude_(max|pro|team|enterprise)(?:_(\d+)x)?/.exec(v);
    if (m) {
      const name = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1);
      return m[2] ? `${name} ${m[2]}x` : name;
    }
  }
  return typeof organizationType === 'string' && organizationType ? organizationType : null;
}

/**
 * Who the token belongs to — shown in the Usage panel so an account swap is
 * verifiable at a glance. Same scope as the usage endpoint (user:profile);
 * 403 → null, other failures throw (the caller tolerates both).
 */
export async function fetchClaudeOauthProfile(token: string, fetchFn: typeof fetch = fetch): Promise<OauthProfile | null> {
  const res = await fetchFn(OAUTH_PROFILE_URL, {
    headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  if (res.status === 403) {
    await res.text().catch(() => undefined);
    return null;
  }
  if (!res.ok) {
    await res.text().catch(() => undefined);
    throw new Error(`oauth profile failed: HTTP ${res.status}`);
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const account = (body?.account ?? {}) as Record<string, unknown>;
  const org = (body?.organization ?? {}) as Record<string, unknown>;
  return {
    email: typeof account.email === 'string' && account.email ? account.email : null,
    planType: planLabelFromProfile(org.rate_limit_tier, org.organization_type),
  };
}

export interface ClaudeProbe {
  /**
   * Refresh every connected account whose newest stored snapshot is older than
   * `maxAgeMs` (or has none), recording the captured windows against that
   * account. Single-flighted PER ACCOUNT: concurrent callers share the one
   * in-flight probe. Returns whether anything probed and how many windows all
   * of them captured between them.
   */
  refreshIfStale(maxAgeMs: number): Promise<{ probed: boolean; captured: number; error: string | null }>;
}

export interface ClaudeProbeAccount {
  id: string;
  token: string;
}

export interface ClaudeProbeOptions {
  store: UsageStore;
  /**
   * Every account to meter, newest telemetry per account. Takes precedence
   * over `getToken`; the runner passes the connected accounts (or the env
   * fallback as one pseudo-account).
   */
  getAccounts?: () => ClaudeProbeAccount[];
  /** Single-account fallback: effective Claude token, or null when not connected. */
  getToken?: () => string | null;
  /** Override the fetch-based probe (tests). */
  probe?: (token: string) => Promise<RateLimitInfo[]>;
  /** Override the OAuth usage fetch (tests). Resolve null = missing scope. */
  oauthUsage?: (token: string) => Promise<OauthUsageResult | null>;
  /** Override the OAuth profile fetch (tests). Resolve null = missing scope. */
  oauthProfile?: (token: string) => Promise<OauthProfile | null>;
  /** Identity learned for an account — lets the secret store label it (best effort). */
  onProfile?: (accountId: string, profile: OauthProfile) => void;
  log?: Pick<Console, 'warn' | 'error'>;
}

export function createClaudeProbe(opts: ClaudeProbeOptions): ClaudeProbe {
  const log = opts.log ?? console;
  const runProbe = opts.probe ?? ((token: string) => probeClaudeRateLimits(token));
  const runOauthUsage = opts.oauthUsage ?? ((token: string) => fetchClaudeOauthUsage(token));
  const runOauthProfile = opts.oauthProfile ?? ((token: string) => fetchClaudeOauthProfile(token));
  const inFlight = new Map<string, Promise<{ captured: number; error: string | null }>>();

  function accounts(): ClaudeProbeAccount[] {
    if (opts.getAccounts) return opts.getAccounts();
    const token = opts.getToken?.() ?? null;
    // Single-account callers share the keyspace the store defaults to.
    return token ? [{ id: LEGACY_ACCOUNT_ID, token }] : [];
  }

  /** Probe one account, recording everything it reports against that account. */
  function refreshAccount(account: ClaudeProbeAccount): Promise<{ captured: number; error: string | null }> {
    const running = inFlight.get(account.id);
    // Never two probes at once for the same account — hand back the in-flight one.
    if (running) return running;
    const run = (async () => {
      // Identity first: a re-login as someone else clears the slot's old
      // snapshots (store.setClaudeAccountEmailFor), which must happen BEFORE
      // this probe records the new account's windows. Never fatal.
      let profile: OauthProfile | null = null;
      try {
        profile = await runOauthProfile(account.token);
      } catch (err) {
        log.warn(`[usage] claude oauth profile failed: ${redactToken((err as Error).message)}`);
      }
      if (profile) {
        opts.store.setClaudeAccountEmailFor(account.id, profile.email);
        if (profile.planType) opts.store.setClaudePlanTypeFor(account.id, profile.planType);
        opts.onProfile?.(account.id, profile);
      }
      // Best source first: the OAuth usage endpoint (model-scoped weeklies +
      // plan name). null = token predates the user:profile scope; any other
      // failure logs and falls through to the header probe as well.
      try {
        const oauth = await runOauthUsage(account.token);
        if (oauth) {
          for (const info of oauth.infos) opts.store.recordClaudeFor(account.id, info, 'oauth');
          opts.store.setClaudeLimitResetFor(account.id, oauth.limitReset ?? null);
          // The usage endpoint's plan name is the older, coarser source ('max');
          // keep the profile's tiered label when we have it.
          if (oauth.planType && !profile?.planType) opts.store.setClaudePlanTypeFor(account.id, oauth.planType);
          return { captured: oauth.infos.length, error: null };
        }
      } catch (err) {
        log.warn(`[usage] claude oauth usage failed: ${redactToken((err as Error).message)}`);
      }
      const infos = await runProbe(account.token);
      for (const info of infos) opts.store.recordClaudeFor(account.id, info, 'probe');
      return { captured: infos.length, error: null };
    })()
      .catch((err: Error) => {
        log.warn(`[usage] claude probe failed: ${redactToken(err.message)}`);
        return { captured: 0, error: 'Claude usage probe failed.' };
      })
      .finally(() => {
        inFlight.delete(account.id);
      });
    inFlight.set(account.id, run);
    return run;
  }

  return {
    refreshIfStale(maxAgeMs) {
      const all = accounts();
      // A disconnected account's meters describe a credential we no longer
      // hold; drop them rather than letting them linger in usage.json.
      opts.store.forgetClaudeAccountsExcept(all.map((account) => account.id));
      if (all.length === 0) return Promise.resolve({ probed: false, captured: 0, error: 'Claude is not connected.' });
      const now = Date.now();
      // Each account has its own meters, so each ages independently: a switch
      // to a long-idle account must re-probe it even if the one just used is fresh.
      const stale = all.filter((account) => {
        const newest = opts.store.newestClaudeCapturedAtMsFor(account.id);
        return newest == null || now - newest >= maxAgeMs;
      });
      if (stale.length === 0) return Promise.resolve({ probed: false, captured: 0, error: null });
      return Promise.all(stale.map((account) => refreshAccount(account))).then((results) => ({
        probed: true,
        captured: results.reduce((sum, r) => sum + r.captured, 0),
        // One failing account shouldn't hide the others' numbers; report the first error.
        error: results.find((r) => r.error)?.error ?? null,
      }));
    },
  };
}
