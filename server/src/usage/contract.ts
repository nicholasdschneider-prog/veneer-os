/**
 * Pure normalization for `GET /api/usage`. Provider telemetry (Claude stream
 * `rate_limit_event`s, Codex `account/rateLimits/read` / session `token_count`,
 * Grok CLI billing credits) is folded into one stable response contract the
 * web UI is built against. Everything here is side-effect-free and unit-tested.
 */

import type { OpenRouterUsage } from './openrouter.js';
import type { ClaudeLimitResetStatus } from './claudeLimitReset.js';

/** One rate-limit window as the UI renders it (a meter + reset time). */
export interface UsageWindow {
  /** Provider-native window id: 'five_hour'|'seven_day' (claude) or 'primary'|'secondary' (codex). */
  id: string;
  /** Human label derived from the window length ("5-hour", "Weekly", …). */
  label: string;
  /** Whole-percent utilization, 0–100. */
  usedPercent: number;
  /** ISO 8601 reset time, or null if unknown. */
  resetsAt: string | null;
  /** Window length in minutes (300 = 5-hour, 10080 = weekly), or null if unknown. */
  windowMinutes: number | null;
  /** Provider status string (claude: "allowed_warning" etc.); null for codex. */
  status: string | null;
}

export interface ProviderUsage {
  connected: boolean;
  planType: string | null;
  /** Account the token belongs to (Claude only, from the OAuth profile). */
  accountEmail?: string | null;
  windows: UsageWindow[];
  capturedAt: string | null;
  source: string | null;
  error: string | null;
  /** Claude only: provider-authoritative once-weekly session reset offer. */
  limitReset?: ClaudeLimitResetStatus | null;
  /**
   * Claude and Codex: every connected account's meters, in registry order. The
   * top-level fields above describe the ACTIVE account, so a single-account
   * install reads exactly as it always did.
   */
  accounts?: ProviderAccountUsageBlock[];
}

/** One connected subscription's meters (Settings → Usage, one block each). */
export interface ProviderAccountUsageBlock {
  accountId: string;
  /** User-facing account name (defaults to the account email). */
  label: string;
  accountEmail: string | null;
  planType: string | null;
  /** True for the account turns currently run on. */
  active: boolean;
  windows: UsageWindow[];
  capturedAt: string | null;
  source: string | null;
  limitReset: ClaudeLimitResetStatus | null;
  /** Codex only: whether the account's credential is still present. */
  connected?: boolean;
  /** Codex only: degraded reason for this account, if any. */
  error?: string | null;
}

/** Kept for the Claude-side callers and tests. */
export type ClaudeAccountUsageBlock = ProviderAccountUsageBlock;

export interface UsageResponse {
  providers: { claude: ProviderUsage; codex: ProviderUsage; grok: ProviderUsage };
  openrouter: OpenRouterUsage;
}

/**
 * Label from a window length. 300→"5-hour" and 10080→"Weekly" are the two the
 * UI shows today; anything else falls back to a whole-day ("N-day") or
 * whole-hour ("N-hour") form so a new window length still reads sensibly.
 */
export function labelForWindowMinutes(mins: number | null): string | null {
  if (mins == null) return null;
  if (mins === 300) return '5-hour';
  if (mins === 10080) return 'Weekly';
  if (mins % 1440 === 0) return `${mins / 1440}-day`;
  return `${Math.round(mins / 60)}-hour`;
}

/** Epoch seconds → ISO 8601, or null. Guards against NaN/negative junk. */
export function epochSecondsToIso(sec: number | null | undefined): string | null {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec <= 0) return null;
  return new Date(sec * 1000).toISOString();
}

/** Sort short-window-first; equal lengths sort by id (the two Claude weeklies); unknown lengths sort last. Non-mutating. */
export function sortWindowsShortFirst(windows: UsageWindow[]): UsageWindow[] {
  return [...windows].sort(
    (a, b) => (a.windowMinutes ?? Infinity) - (b.windowMinutes ?? Infinity) || a.id.localeCompare(b.id),
  );
}

// ── Claude ───────────────────────────────────────────────────────────────────

/**
 * A single stored Claude window snapshot (the latest seen for its rateLimitType).
 * `utilization` is the raw fraction (0.83), not yet ×100.
 */
export interface ClaudeSnapshot {
  rateLimitType: string;
  utilization: number;
  resetsAt: number | null;
  status: string | null;
  /** 'oauth' = GET /api/oauth/usage (richest; needs user:profile scope). */
  source: 'stream' | 'probe' | 'oauth';
  /** Display label carried by the source (OAuth model-scoped windows). */
  label?: string;
  /** ISO time the snapshot was captured. */
  capturedAt: string;
}

/**
 * Claude's window types carry no length on the wire — derive from the type
 * name. Model-scoped weeklies arrive as `seven_day_<model>` (e.g.
 * `seven_day_fable_5` from the OAuth usage endpoint), so match by prefix.
 */
function claudeWindowMinutes(rateLimitType: string): number | null {
  if (rateLimitType === 'five_hour') return 300;
  if (rateLimitType.startsWith('seven_day')) return 10080;
  return null;
}

/**
 * Claude has multiple weekly windows (overall + model-scoped — see store.ts /
 * claudeProbe.ts for how they get identified), so label them apart the way
 * Claude Code's /usage does ("Current week (all models)" / "(Fable 5)").
 * OAuth-sourced snapshots carry their own label; these cover the rest.
 */
const CLAUDE_WINDOW_LABELS: Record<string, string> = {
  seven_day: 'Weekly (all models)',
  seven_day_sonnet: 'Weekly (Sonnet)',
  seven_day_fable: 'Weekly (Fable)',
};

function claudeWindow(snap: ClaudeSnapshot): UsageWindow {
  const windowMinutes = claudeWindowMinutes(snap.rateLimitType);
  return {
    id: snap.rateLimitType,
    // Fall back to the raw type for an unmapped window rather than an empty label.
    label:
      snap.label ??
      CLAUDE_WINDOW_LABELS[snap.rateLimitType] ??
      labelForWindowMinutes(windowMinutes) ??
      snap.rateLimitType,
    usedPercent: Math.round(snap.utilization * 100),
    resetsAt: epochSecondsToIso(snap.resetsAt),
    windowMinutes,
    status: snap.status,
  };
}

/**
 * Build the claude provider block from stored snapshots. `connected` reflects
 * the secret store (token present), independent of whether we have any
 * snapshots yet — a freshly connected account has no telemetry until its first
 * turn. capturedAt/source come from the newest snapshot. `planType` comes from
 * the OAuth usage endpoint when available (e.g. "max"), else null.
 */
export function buildClaudeProvider(
  snapshots: ClaudeSnapshot[],
  connected: boolean,
  planType: string | null = null,
  accountEmail: string | null = null,
  accounts?: ClaudeAccountUsageBlock[],
  limitReset: ClaudeLimitResetStatus | null = null,
): ProviderUsage {
  const windows = sortWindowsShortFirst(snapshots.map(claudeWindow));
  // Newest wins; on an identical timestamp the later-recorded snapshot (later in
  // insertion order) wins, so >= not >.
  const newest = snapshots.reduce<ClaudeSnapshot | null>(
    (best, s) => (best == null || s.capturedAt >= best.capturedAt ? s : best),
    null,
  );
  return {
    connected,
    planType,
    accountEmail,
    windows,
    capturedAt: newest?.capturedAt ?? null,
    source: newest?.source ?? null,
    error: null,
    limitReset,
    ...(accounts ? { accounts } : {}),
  };
}

/**
 * Meters for one connected account. Same normalization as the provider block,
 * kept separate so the Usage screen can render one block per account without
 * the account list leaking into the other providers' shape.
 */
export function buildClaudeAccountUsage(
  account: {
    accountId: string;
    label: string;
    accountEmail: string | null;
    planType: string | null;
    active: boolean;
    limitReset?: ClaudeLimitResetStatus | null;
  },
  snapshots: ClaudeSnapshot[],
): ClaudeAccountUsageBlock {
  const newest = snapshots.reduce<ClaudeSnapshot | null>(
    (best, s) => (best == null || s.capturedAt >= best.capturedAt ? s : best),
    null,
  );
  return {
    ...account,
    windows: sortWindowsShortFirst(snapshots.map(claudeWindow)),
    capturedAt: newest?.capturedAt ?? null,
    source: newest?.source ?? null,
    limitReset: account.limitReset ?? null,
  };
}

// ── Codex ──────────────────────────────────────────────────────────────────

/** The two windows Codex reports, as the RPC/session normalizers hand them over. */
export interface CodexWindowRaw {
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: number | null;
}

export interface CodexSnapshot {
  planType: string | null;
  primary: CodexWindowRaw | null;
  secondary: CodexWindowRaw | null;
}

function codexWindow(id: 'primary' | 'secondary', raw: CodexWindowRaw): UsageWindow {
  return {
    id,
    label: labelForWindowMinutes(raw.windowMinutes) ?? id,
    // Codex reports whole percents already; round to defend against a float
    // (the session-file fallback stores 19.0, not 19).
    usedPercent: Math.round(raw.usedPercent),
    resetsAt: epochSecondsToIso(raw.resetsAt),
    windowMinutes: raw.windowMinutes,
    status: null,
  };
}

/** Windows for a codex snapshot, short-first, dropping absent buckets. */
export function codexWindows(snap: CodexSnapshot): UsageWindow[] {
  const ws: UsageWindow[] = [];
  if (snap.primary) ws.push(codexWindow('primary', snap.primary));
  if (snap.secondary) ws.push(codexWindow('secondary', snap.secondary));
  return sortWindowsShortFirst(ws);
}

/** Normalize the camelCase `account/rateLimits/read` RPC `rateLimits` object. */
export function normalizeCodexRpc(rateLimits: unknown): CodexSnapshot {
  const rl = (rateLimits ?? {}) as Record<string, unknown>;
  const win = (v: unknown): CodexWindowRaw | null => {
    if (!v || typeof v !== 'object') return null;
    const w = v as Record<string, unknown>;
    if (typeof w.usedPercent !== 'number') return null;
    return {
      usedPercent: w.usedPercent,
      windowMinutes: typeof w.windowDurationMins === 'number' ? w.windowDurationMins : null,
      resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt : null,
    };
  };
  return {
    planType: typeof rl.planType === 'string' ? rl.planType : null,
    primary: win(rl.primary),
    secondary: win(rl.secondary),
  };
}

/**
 * Normalize a session-file `token_count.rate_limits` object (snake_case, and
 * `window_minutes` rather than the RPC's `windowDurationMins`). used_percent is
 * a float here.
 */
export function normalizeCodexSession(rateLimits: unknown): CodexSnapshot {
  const rl = (rateLimits ?? {}) as Record<string, unknown>;
  const win = (v: unknown): CodexWindowRaw | null => {
    if (!v || typeof v !== 'object') return null;
    const w = v as Record<string, unknown>;
    if (typeof w.used_percent !== 'number') return null;
    return {
      usedPercent: w.used_percent,
      windowMinutes: typeof w.window_minutes === 'number' ? w.window_minutes : null,
      resetsAt: typeof w.resets_at === 'number' ? w.resets_at : null,
    };
  };
  return {
    planType: typeof rl.plan_type === 'string' ? rl.plan_type : null,
    primary: win(rl.primary),
    secondary: win(rl.secondary),
  };
}

// ── Grok ───────────────────────────────────────────────────────────────────

/** One credits window from the CLI billing endpoint (`format=credits`). */
export interface GrokBillingSnap {
  id: 'weekly' | 'credits';
  usedPercent: number;
  resetsAt: string | null;
  windowMinutes: number | null;
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function grokWindowMinutes(periodType: string | null, startIso: string | null, endIso: string | null): number | null {
  if (periodType?.includes('WEEKLY')) return 10080;
  if (periodType?.includes('MONTHLY')) {
    if (startIso && endIso) {
      const mins = Math.round((Date.parse(endIso) - Date.parse(startIso)) / 60_000);
      if (Number.isFinite(mins) && mins > 0) return mins;
    }
    return 30 * 1440;
  }
  if (startIso && endIso) {
    const mins = Math.round((Date.parse(endIso) - Date.parse(startIso)) / 60_000);
    if (Number.isFinite(mins) && mins > 0) return mins;
  }
  return null;
}

/**
 * Normalize `GET …/v1/billing?format=credits`. Dollar-format bodies (no
 * `creditUsagePercent`) return null — SuperGrok subscriptions report zeros
 * there and must not become a fake 0% meter.
 */
export function normalizeGrokBilling(body: unknown): GrokBillingSnap | null {
  if (!body || typeof body !== 'object') return null;
  const config = (body as { config?: unknown }).config;
  if (!config || typeof config !== 'object') return null;
  const cfg = config as Record<string, unknown>;
  if (typeof cfg.creditUsagePercent !== 'number' || !Number.isFinite(cfg.creditUsagePercent)) return null;
  const period = cfg.currentPeriod && typeof cfg.currentPeriod === 'object' ? (cfg.currentPeriod as Record<string, unknown>) : null;
  const periodType = typeof period?.type === 'string' ? period.type : null;
  const resetsAt = isoOrNull(period?.end) ?? isoOrNull(cfg.billingPeriodEnd);
  const startIso = isoOrNull(period?.start) ?? isoOrNull(cfg.billingPeriodStart);
  const windowMinutes = grokWindowMinutes(periodType, startIso, resetsAt);
  const weekly = Boolean(periodType?.includes('WEEKLY')) || windowMinutes === 10080;
  return {
    id: weekly ? 'weekly' : 'credits',
    usedPercent: Math.max(0, Math.min(100, Math.round(cfg.creditUsagePercent))),
    resetsAt,
    windowMinutes,
  };
}

export function buildGrokProvider(
  snap: GrokBillingSnap | null,
  connected: boolean,
  planType: string | null,
  capturedAt: string | null,
  error: string | null,
): ProviderUsage {
  if (!connected) {
    return { connected: false, planType: null, windows: [], capturedAt: null, source: null, error: null };
  }
  if (error) {
    return { connected: true, planType, windows: [], capturedAt, source: null, error };
  }
  if (!snap) {
    return {
      connected: true,
      planType,
      windows: [],
      capturedAt,
      source: null,
      error: 'Grok usage is unavailable.',
    };
  }
  return {
    connected: true,
    planType,
    windows: [
      {
        id: snap.id,
        label: labelForWindowMinutes(snap.windowMinutes) ?? (snap.id === 'weekly' ? 'Weekly' : 'Credits'),
        usedPercent: snap.usedPercent,
        resetsAt: snap.resetsAt,
        windowMinutes: snap.windowMinutes,
        status: null,
      },
    ],
    capturedAt,
    source: 'live',
    error: null,
  };
}
