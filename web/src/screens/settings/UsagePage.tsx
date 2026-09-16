import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, Loader2, RefreshCw } from 'lucide-react';
import {
  api,
  type OpenRouterUsage,
  type OpenRouterSpendPeriod,
  type ClaudeLimitResetClaim,
  type ClaudeLimitResetStatus,
  type ProviderUsage,
  type UsageResponse,
  type UsageWindow,
} from '../../lib/api';
import { formatFreshness, formatReset, parseTime } from '../../lib/usageFormat';
import { ProviderIcon } from '../../components/ProviderIcon';
import { Button } from '@/components/ui/button';
import { Segmented } from '../../components/toolbox/controls';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

// Warning/critical thresholds, styled to match the app's danger (destructive)
// and warning (amber) conventions. Both tokens are theme-aware (light/dark).
function meterTone(pct: number): { bar: string; text: string } {
  if (pct >= 95) return { bar: 'bg-destructive', text: 'text-destructive' };
  if (pct >= 80) return { bar: 'bg-amber-500', text: 'text-amber-700 dark:text-amber-300' };
  return { bar: 'bg-brand', text: 'text-foreground' };
}

const SEGMENTS = 10;

/** Filled block count for a percentage: 94% → 9, 95% → 10. Clamps to 0…SEGMENTS. */
export function segmentFill(pct: number): number {
  return Math.round(Math.max(0, Math.min(100, pct)) / (100 / SEGMENTS));
}

/**
 * Row label for a window. The wire sends "Weekly (all models)" / "Weekly (Fable)";
 * shorten those so they fit the card's fixed label column.
 */
export function windowLabel(w: UsageWindow): string {
  const raw = w.id === 'seven_day_overage_included' ? 'Weekly (Fable)' : w.label;
  const scope = /^Weekly \((.+)\)$/.exec(raw)?.[1];
  return scope ? `Weekly · ${scope.replace(/ models$/, '')}` : raw;
}

/** Window family for the footer, so the several weeklies read as one "weekly". */
function resetFamily(label: string): string {
  return label.startsWith('Weekly') ? 'weekly' : label.toLowerCase();
}

/**
 * One consolidated reset line for a card: "5-hour resets in 4h 0m · weekly in
 * 1d 16h". Windows of the same family that reset at the same time collapse —
 * Claude's weeklies almost always share a reset.
 */
export function resetSummary(windows: UsageWindow[], now: number): string | null {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const w of windows) {
    const reset = formatReset(w.resetsAt, now);
    if (!reset) continue;
    const family = resetFamily(windowLabel(w));
    if (seen.has(`${family}|${reset}`)) continue;
    seen.add(`${family}|${reset}`);
    parts.push(`${family} ${parts.length === 0 ? reset : reset.replace(/^resets /, '')}`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

export interface UsageCardSpec {
  key: string;
  name: string;
  usage: ProviderUsage;
  kind: 'claude' | 'codex' | 'grok';
  /** The account new turns run on — wears the Active tab. */
  active?: boolean;
  /** Exact account for switching and reset actions. */
  accountId?: string;
}

/**
 * Switch which account new turns run on, then reload so the Active tab moves to
 * the card you tapped. Failures land on the page's existing error banner.
 */
export async function switchAccount(
  accountId: string,
  deps: {
    activate: (accountId: string) => Promise<unknown>;
    reload: () => void;
    onError: (message: string) => void;
  },
): Promise<void> {
  try {
    await deps.activate(accountId);
    deps.reload();
  } catch (err) {
    deps.onError((err as Error).message);
  }
}

/** Kept for callers that still import the Claude-specific name. */
export const switchClaudeAccount = switchAccount;

/**
 * One card per connected account when several are connected (a single
 * blended meter would say nothing about which account still has headroom),
 * else the provider's flat view under the account's own label.
 */
function accountCards(
  kind: 'claude' | 'codex',
  fallbackName: string,
  provider: ProviderUsage,
): UsageCardSpec[] {
  const accounts = provider.accounts ?? [];
  if (accounts.length > 1) {
    return accounts.map((account) => ({
      key: kind === 'claude' ? account.accountId : `${kind}:${account.accountId}`,
      name: account.label,
      kind,
      active: account.active,
      accountId: account.accountId,
      usage: {
        connected: account.connected ?? true,
        planType: account.planType,
        accountEmail: account.accountEmail,
        windows: account.windows,
        capturedAt: account.capturedAt,
        source: account.source,
        error: account.error ?? null,
        limitReset: account.limitReset,
      },
    }));
  }
  return [{
    key: kind,
    name: accounts[0]?.label ?? fallbackName,
    kind,
    accountId: accounts[0]?.accountId,
    usage: provider,
  }];
}

/**
 * Claude accounts in the order the registry returns them, then Codex's, then
 * Grok. Cards hold still: activating one moves the tab, it doesn't reshuffle
 * the grid under the pointer. Kept compatible with the pre-Grok API during
 * rolling restarts.
 */
export function orderUsageCards(providers: UsageResponse['providers']): UsageCardSpec[] {
  return [
    ...accountCards('claude', 'Claude', providers.claude),
    ...accountCards('codex', 'Codex', providers.codex),
    ...(providers.grok
      ? [{ key: 'grok', name: 'Grok', kind: 'grok' as const, usage: providers.grok }]
      : []),
  ];
}

/**
 * Oldest capture among the cards on screen — one freshness line for the page is
 * only honest if it reports the stalest card, not the luckiest one.
 */
export function oldestCapturedAt(providers: UsageResponse['providers']): string | null {
  let oldest: string | null = null;
  let oldestMs = Infinity;
  for (const card of orderUsageCards(providers)) {
    const at = card.usage.capturedAt;
    if (!at) continue;
    const ms = parseTime(at);
    if (Number.isNaN(ms) || ms >= oldestMs) continue;
    oldest = at;
    oldestMs = ms;
  }
  return oldest;
}

/** One window as a row: label, segmented meter, percent used. */
function UsageMeterRow({ window: w }: { window: UsageWindow }) {
  const pct = Math.max(0, Math.min(100, Math.round(w.usedPercent)));
  const tone = meterTone(pct);
  const filled = segmentFill(pct);
  const label = windowLabel(w);
  return (
    <div className="grid grid-cols-[112px_minmax(0,1fr)_auto] items-center gap-2">
      <span className="min-w-0 truncate font-medium">{label}</span>
      <div
        role="meter"
        aria-label={`${label}: ${pct}% used`}
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        className="flex gap-0.5"
      >
        {Array.from({ length: SEGMENTS }, (_, i) => (
          <span
            key={i}
            aria-hidden="true"
            className={`h-2 flex-1 rounded-[2px] transition-colors ${i < filled ? tone.bar : 'bg-muted'}`}
          />
        ))}
      </div>
      <span className={`shrink-0 tabular-nums ${tone.text}`}>{pct}%</span>
    </div>
  );
}

/**
 * Geometry shared by the Active tab and the switch tab: flush with the card's
 * top border, square on top, hanging down into the card. Both wear it so the
 * slot reads as one control that changes state in place.
 */
const CORNER_TAB = 'absolute right-4 top-0 rounded-b-md px-2 py-0.5 text-xs font-medium';

export function limitResetText(status: ClaudeLimitResetStatus, now: number): string {
  if (status.available) {
    return `${status.resetsPerWeek}/week · still counts toward weekly usage`;
  }
  const next = formatReset(status.nextAvailableAt, now)?.replace(/^resets /, '');
  return `Session reset used${next ? ` · available ${next}` : ''}`;
}

/** One account/provider card: identity header, meter rows, and a reset footer. */
export function UsageAccountCard({
  name,
  usage,
  now,
  kind,
  active,
  onActivate,
  busy,
  switchDisabled,
  onLimitReset,
  resetBusy,
}: {
  name: string;
  usage: ProviderUsage;
  now: number;
  kind: 'claude' | 'codex' | 'grok';
  /** Marks the Claude account new turns run on: brand ring plus the Active tab. */
  active?: boolean;
  /** Omitted when switching isn't offered (single account, or a read-only grid). */
  onActivate?: () => void;
  /** This card's switch is in flight. */
  busy?: boolean;
  /** Some card's switch is in flight — all switch buttons wait it out. */
  switchDisabled?: boolean;
  /** Consume this exact Claude account's provider-authorized weekly reset. */
  onLimitReset?: () => void;
  resetBusy?: boolean;
}) {
  const metered = usage.connected && !usage.error && usage.windows.length > 0;
  // Freshness is reported once for the whole page, so the footer is resets only
  // — and a card with nothing to count down ends right after its meters.
  const resets = metered ? resetSummary(usage.windows, now) : null;
  const corner = active || Boolean(onActivate);
  const limitReset = kind === 'claude' ? usage.limitReset ?? null : null;
  return (
    <Card size="sm" className={active ? 'relative ring-2 ring-brand' : corner ? 'relative' : undefined}>
      {/* The corner slot hangs off the top border rather than sitting in the
          title row, so the active account is obvious across a grid of cards.
          Switching reuses the same slot: the tab you tap becomes the Active tab. */}
      {active ? (
        <span className={`${CORNER_TAB} bg-brand text-background`}>
          Active<span className="sr-only"> account</span>
        </span>
      ) : onActivate ? (
        <button
          type="button"
          aria-label={`Use this account: ${name}`}
          onPointerUp={onActivate}
          disabled={busy || switchDisabled}
          className={`${CORNER_TAB} inline-flex items-center justify-center bg-muted text-muted-foreground transition-colors hover:bg-brand hover:text-background focus-visible:bg-brand focus-visible:text-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:pointer-events-none disabled:opacity-50`}
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : 'Use this'}
        </button>
      ) : null}
      <CardHeader className={corner ? 'pr-20' : undefined}>
        <CardTitle className="flex min-w-0 items-center gap-2">
          <ProviderIcon provider={kind} variant="color" className="size-4" />
          <span className="min-w-0 truncate">{name}</span>
          {usage.planType ? (
            <span className="shrink-0 rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-brand">
              {usage.planType}
            </span>
          ) : null}
        </CardTitle>
        {!usage.connected ? (
          <CardDescription className="text-xs">Not connected</CardDescription>
        ) : /* An un-renamed account is labelled by its email — no need to say it twice. */
        usage.accountEmail && usage.accountEmail !== name ? (
          <CardDescription className="truncate text-xs" title={usage.accountEmail}>
            {usage.accountEmail}
          </CardDescription>
        ) : null}
      </CardHeader>

      {usage.connected ? (
        <CardContent>
          {usage.error ? (
            <p className="text-muted-foreground">{usage.error}</p>
          ) : usage.windows.length === 0 ? (
            <p className="text-muted-foreground">
              {kind === 'claude'
                ? 'No usage data yet — appears after the first Claude turn.'
                : 'No usage data yet.'}
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {usage.windows.map((w) => (
                <UsageMeterRow key={w.id} window={w} />
              ))}
            </div>
          )}
        </CardContent>
      ) : null}

      {resets || limitReset ? (
        <CardFooter className="flex-col items-stretch gap-2 text-xs text-muted-foreground">
          {resets ? <p className="truncate">{resets}</p> : null}
          {limitReset ? (
            <div className="flex items-center justify-between gap-3 border-t pt-2">
              <p>{limitResetText(limitReset, now)}</p>
              {limitReset.available && onLimitReset ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  disabled={resetBusy}
                  onPointerUp={onLimitReset}
                >
                  {resetBusy ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : 'Reset session'}
                </Button>
              ) : null}
            </div>
          ) : null}
        </CardFooter>
      ) : null}
    </Card>
  );
}

/** The account-card grid: 2-up where there's room, 1-up on narrow screens. */
export function UsageCardGrid({
  providers,
  now,
  onActivate,
  switching,
  onLimitReset,
  resetting,
}: {
  providers: UsageResponse['providers'];
  now: number;
  /** Omit to render read-only cards; only per-account Claude and Codex cards can switch. */
  onActivate?: (accountId: string, kind: 'claude' | 'codex') => void;
  /** Account id whose switch is in flight. */
  switching?: string | null;
  onLimitReset?: (accountId: string, name: string) => void;
  resetting?: string | null;
}) {
  // items-start: a card ends after its own content instead of stretching to
  // match the tallest card in its row.
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] items-start gap-3">
      {orderUsageCards(providers).map((card) => {
        const accountId = card.accountId;
        const kind = card.kind;
        const canSwitch = kind !== 'grok' && (providers[kind].accounts?.length ?? 0) > 1;
        return (
          <UsageAccountCard
            key={card.key}
            name={card.name}
            active={card.active}
            usage={card.usage}
            now={now}
            kind={card.kind}
            onActivate={canSwitch && onActivate && accountId && !card.active ? () => onActivate(accountId, kind as 'claude' | 'codex') : undefined}
            busy={switching != null && switching === accountId}
            switchDisabled={switching != null}
            onLimitReset={onLimitReset && accountId && kind === 'claude' ? () => onLimitReset(accountId, card.name) : undefined}
            resetBusy={resetting != null && resetting === accountId}
          />
        );
      })}
    </div>
  );
}

function formatUsd(value: number): string {
  if (value > 0 && value < 0.01) return `$${value.toFixed(4)}`;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}

function SpendStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg bg-muted/50 px-3 py-2.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums">{formatUsd(value)}</p>
    </div>
  );
}

const MODEL_PERIODS: { value: OpenRouterSpendPeriod; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'lifetime', label: 'Lifetime' },
];

function formatCount(value: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function ModelSpendBreakdown({ usage }: { usage: OpenRouterUsage }) {
  const [period, setPeriod] = useState<OpenRouterSpendPeriod>('today');
  const breakdown = usage.modelBreakdown;
  const rows = breakdown.periods[period];

  return (
    <div className="border-t pt-4">
      <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <p className="font-medium">Cost by model</p>
          <p className="text-xs text-muted-foreground">Only models used by this client key.</p>
        </div>
        <Segmented value={period} options={MODEL_PERIODS} onChange={setPeriod} />
      </div>

      {!breakdown.configured ? (
        <p className="mt-3 rounded-lg bg-muted/50 px-3 py-2.5 text-muted-foreground">
          Model cost breakdown is not set up for this instance.
        </p>
      ) : breakdown.error ? (
        <p className="mt-3 rounded-lg bg-amber-500/10 px-3 py-2.5 text-amber-800 dark:text-amber-200">
          {breakdown.error}
        </p>
      ) : rows.length === 0 ? (
        <p className="mt-3 rounded-lg bg-muted/50 px-3 py-2.5 text-muted-foreground">
          No OpenRouter spend in this period.
        </p>
      ) : (
        <div className="mt-3 overflow-hidden rounded-xl border">
          {rows.map((row) => (
            <div
              key={row.model}
              className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 border-b px-3 py-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto] sm:items-center"
            >
              <p className="min-w-0 break-words font-medium">{row.model}</p>
              <p className="font-semibold tabular-nums sm:order-4">{formatUsd(row.costUsd)}</p>
              <p className="text-xs text-muted-foreground sm:text-right">
                <span className="sm:hidden">Requests: </span>{formatCount(row.requestCount)}<span className="hidden sm:inline"> requests</span>
              </p>
              <p className="text-right text-xs text-muted-foreground sm:text-right">
                <span className="sm:hidden">Tokens: </span>{formatCount(row.tokensTotal)}<span className="hidden sm:inline"> tokens</span>
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function OpenRouterSpend({ usage, now }: { usage: OpenRouterUsage; now: number }) {
  const freshness = formatFreshness(usage.capturedAt, now);
  const limitSpent =
    usage.summary?.limitUsd != null && usage.summary.remainingUsd != null
      ? Math.max(0, usage.summary.limitUsd - usage.summary.remainingUsd)
      : null;
  const limitPct =
    limitSpent != null && usage.summary?.limitUsd
      ? Math.max(0, Math.min(100, (limitSpent / usage.summary.limitUsd) * 100))
      : null;

  if (!usage.connected) {
    return <p className="text-muted-foreground">OpenRouter is not connected.</p>;
  }
  if (usage.error || !usage.summary) {
    return <div className="rounded-xl bg-destructive/10 px-4 py-2.5 text-destructive">{usage.error ?? 'Usage is unavailable.'}</div>;
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <SpendStat label="Today" value={usage.summary.todayUsd} />
        <SpendStat label="This week" value={usage.summary.weekUsd} />
        <SpendStat label="This month" value={usage.summary.monthUsd} />
        <SpendStat label="Lifetime" value={usage.summary.lifetimeUsd} />
      </div>

      {limitPct != null && usage.summary.limitUsd != null && usage.summary.remainingUsd != null ? (
        <div>
          <div className="mb-1 flex items-center justify-between gap-3 text-xs">
            <span className="text-muted-foreground">Key spending limit</span>
            <span className="tabular-nums">
              {formatUsd(usage.summary.remainingUsd)} remaining of {formatUsd(usage.summary.limitUsd)}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div className={`h-full rounded-full ${meterTone(limitPct).bar}`} style={{ width: `${limitPct}%` }} />
          </div>
        </div>
      ) : null}

      <ModelSpendBreakdown usage={usage} />

      {freshness ? <p className="text-xs text-muted-foreground">OpenRouter data {freshness}</p> : null}
    </div>
  );
}

/**
 * Usage page: one card per Claude account / provider, each with a segmented
 * meter per rate-limit window. Reads GET /api/usage; the refresh button
 * re-fetches with ?refresh=1. A local `now` ticks every 30s so
 * countdowns/freshness stay live between fetches.
 */
export function UsagePage({ canManage = false }: { canManage?: boolean }) {
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const [resetTarget, setResetTarget] = useState<{ accountId: string; name: string } | null>(null);
  const [resetting, setResetting] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const load = useCallback((refresh: boolean) => {
    if (refresh) setRefreshing(true);
    else setLoading(true);
    api
      .usage(refresh)
      .then((r) => {
        setUsage(r);
        setError(null);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => {
        setLoading(false);
        setRefreshing(false);
        setNow(Date.now());
      });
  }, []);

  useEffect(() => load(false), [load]);

  // Cached re-fetch: the active flag comes from the account registry, not the
  // probe, so there's nothing to re-probe after a switch.
  const activate = useCallback(
    (accountId: string, kind: 'claude' | 'codex') => {
      setSwitching(accountId);
      void switchAccount(accountId, {
        activate: (id) => (kind === 'codex' ? api.codexAccountActivate(id) : api.claudeAccountActivate(id)),
        reload: () => load(false),
        onError: setError,
      }).finally(() => setSwitching(null));
    },
    [load],
  );

  const freshness = usage ? formatFreshness(oldestCapturedAt(usage.providers), now) : null;

  const claimLimitReset = useCallback(async () => {
    if (!resetTarget || resetting) return;
    const { accountId, name } = resetTarget;
    setResetting(accountId);
    try {
      const claim: ClaudeLimitResetClaim = await api.claudeLimitReset(accountId);
      const messages: Record<ClaudeLimitResetClaim['result'], string> = {
        reset: `${name}'s session limit was reset. Weekly usage was not reset.`,
        already_used: `${name}'s weekly session reset has already been used.`,
        not_limited: `${name} is not session-limited, so no reset was used.`,
        ineligible: `Claude is not offering a session reset for ${name} right now.`,
        unavailable: `Claude could not reset ${name} right now. No success was reported.`,
      };
      setNotice(messages[claim.result]);
      setResetTarget(null);
      load(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setResetting(null);
    }
  }, [load, resetTarget, resetting]);

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-5">
        {/* Title and controls share one row — this page's own header, since the
            shell's would leave the freshness line stranded below it. */}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <h1 className="max-w-[40ch] text-balance text-2xl font-semibold tracking-tight">Usage</h1>
          <div className="flex shrink-0 items-center gap-2">
            {freshness ? <span className="text-xs text-muted-foreground">{freshness}</span> : null}
            <Button
              variant="ghost"
              size="icon-lg"
              className="rounded-full text-muted-foreground"
              onPointerUp={() => load(true)}
              disabled={loading || refreshing}
              aria-label="Refresh all usage"
            >
              <RefreshCw className={`size-4 ${refreshing ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>

        <div className="text-sm">
          {error ? (
            <div className="mb-4 rounded-xl bg-destructive/10 px-4 py-2.5 text-destructive">{error}</div>
          ) : null}
          {notice ? (
            <div className="mb-4 rounded-xl bg-brand/10 px-4 py-2.5 text-foreground">{notice}</div>
          ) : null}

          {loading && !usage ? (
            <p className="text-muted-foreground">Loading…</p>
          ) : usage ? (
            <UsageCardGrid
              providers={usage.providers}
              now={now}
              onActivate={canManage ? activate : undefined}
              switching={switching}
              onLimitReset={canManage ? (accountId, name) => {
                setNotice(null);
                setResetTarget({ accountId, name });
              } : undefined}
              resetting={resetting}
            />
          ) : null}
        </div>
      </section>

      <OpenRouterPanel usage={usage} now={now} loading={loading} />

      <Dialog open={resetTarget !== null} onOpenChange={(open) => !open && !resetting && setResetTarget(null)}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Reset {resetTarget?.name}'s session limit?</DialogTitle>
            <DialogDescription>
              This uses that account's once-weekly session reset. It still counts toward the weekly limit and does not
              switch the active account.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              className="h-11 flex-1 rounded-xl"
              disabled={resetting !== null}
              onPointerUp={() => setResetTarget(null)}
            >
              Cancel
            </Button>
            <Button
              className="h-11 flex-1 rounded-xl"
              disabled={resetting !== null}
              onPointerUp={() => void claimLimitReset()}
            >
              {resetting ? 'Resetting…' : 'Use weekly reset'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Spend detail is a look-it-up, not a glance, so it starts collapsed on every
 * visit. Native <details> keeps the keyboard and screen-reader behaviour for
 * free; no state to persist.
 */
export function OpenRouterPanel({
  usage,
  now,
  loading,
}: {
  usage: UsageResponse | null;
  now: number;
  loading: boolean;
}) {
  const weekUsd = usage?.openrouter.connected ? (usage.openrouter.summary?.weekUsd ?? null) : null;
  return (
    <Card className="[--card-spacing:--spacing(5)]">
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-(--card-spacing) font-heading text-base font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <ProviderIcon provider="openrouter" variant="color" className="size-5" />
          OpenRouter spend
          {weekUsd != null ? (
            <span className="text-sm font-normal tabular-nums text-muted-foreground">
              {formatUsd(weekUsd)} this week
            </span>
          ) : null}
          <ChevronDown
            aria-hidden="true"
            className="ml-auto size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
          />
        </summary>
        <div className="mt-(--card-spacing) px-(--card-spacing) text-sm">
          {loading && !usage ? <p className="text-muted-foreground">Loading…</p> : null}
          {usage ? <OpenRouterSpend usage={usage.openrouter} now={now} /> : null}
        </div>
      </details>
    </Card>
  );
}
