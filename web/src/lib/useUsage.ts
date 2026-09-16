import { useEffect, useRef, useState } from 'react';
import { api, subscribeCodexAccountChanges, type ProviderUsage, type UsageResponse, type UsageWindow } from './api';
import { parseTime } from './usageFormat';
import { wsBus } from './ws';

/**
 * One shared read of GET /api/usage for the nav rings (desktop rail + mobile
 * bar mount the same hook instance's data via NavShell, so there is exactly one
 * fetch in flight for both).
 *
 * Refresh policy, deliberately cheap — no polling anywhere:
 *  1. One fetch on mount.
 *  2. A `usage_updated` push over the app WebSocket (the runner emits one when
 *     a turn's rate-limit telemetry lands) triggers a plain re-fetch, debounced
 *     2s so a burst of stream events collapses into one request.
 *  3. While a chat is open, a snapshot older than five minutes earns ONE
 *     `?refresh=1` re-probe (the server coalesces probes within 15s). Codex has
 *     no stream event at all, so this is the only thing that moves its ring.
 *  4. A successful Codex account change clears its old meter and reloads usage.
 *  5. A 30s local tick re-renders staleness and reset text with no network.
 *
 * All workspace roles share this read. Failed requests stop retries for the
 * session and leave the rings without new data.
 */

/** A snapshot older than this reads as stale: re-probe eligible (still drawn as last known). */
export const USAGE_STALE_MS = 5 * 60 * 1000;
/** Collapse a burst of `usage_updated` pushes into one fetch. */
export const USAGE_PUSH_DEBOUNCE_MS = 2_000;
/** Local re-render cadence for staleness / countdown text (no network). */
export const USAGE_TICK_MS = 30_000;

export interface UsageRingModel {
  provider: 'claude' | 'codex';
  /** Window shorthand under the ring. */
  label: '5hr' | 'week';
  percent: number;
  /** Reading older than USAGE_STALE_MS (drives re-probe; still drawn as-is). */
  stale: boolean;
  /** No reading for this window at all: drawn muted/dashed. */
  unknown: boolean;
  /** Tooltip line 1 — also the first half of the aria-label. */
  primaryText: string;
  /** Tooltip line 2 (reset time + the companion window), or null. */
  secondaryText: string | null;
}

/** Epoch ms of the freshest capture across the providers we draw, or null. */
export function newestCapturedAtMs(usage: UsageResponse | null): number | null {
  if (!usage) return null;
  const stamps: string[] = [];
  const { claude, codex } = usage.providers;
  for (const account of claude.accounts ?? []) if (account.capturedAt) stamps.push(account.capturedAt);
  if (claude.capturedAt) stamps.push(claude.capturedAt);
  if (codex.capturedAt) stamps.push(codex.capturedAt);
  let newest: number | null = null;
  for (const stamp of stamps) {
    const t = parseTime(stamp);
    if (Number.isFinite(t) && (newest == null || t > newest)) newest = t;
  }
  return newest;
}

/** A capture is stale when it is missing or older than USAGE_STALE_MS. */
export function isUsageStale(capturedAt: string | null | undefined, now: number): boolean {
  if (!capturedAt) return true;
  const t = parseTime(capturedAt);
  if (!Number.isFinite(t)) return true;
  return now - t > USAGE_STALE_MS;
}

/**
 * Should we spend a `?refresh=1` probe right now? Only with a chat open (the
 * ring is only worth money while you're burning quota) and only when what we
 * hold has aged past the stale threshold.
 */
export function shouldReprobe(
  { newestMs, chatOpen, now }: { newestMs: number | null; chatOpen: boolean; now: number },
): boolean {
  if (!chatOpen) return false;
  if (newestMs == null) return true;
  return now - newestMs > USAGE_STALE_MS;
}

function localTime(iso: string | null): string | null {
  if (!iso) return null;
  const t = parseTime(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function findWindow(windows: UsageWindow[], id: string): UsageWindow | null {
  return windows.find((w) => w.id === id) ?? null;
}

/** Codex's weekly bucket: the longest window it reported (usually `secondary`). */
export function codexWeeklyWindow(windows: UsageWindow[]): UsageWindow | null {
  let best: UsageWindow | null = null;
  for (const w of windows) {
    if ((w.windowMinutes ?? 0) < 1440) continue;
    if (!best || (w.windowMinutes ?? 0) > (best.windowMinutes ?? 0)) best = w;
  }
  return best ?? findWindow(windows, 'secondary');
}

/** The Claude account new turns run on; falls back to the flat provider view. */
function activeClaude(claude: ProviderUsage): {
  label: string | null;
  windows: UsageWindow[];
  capturedAt: string | null;
} {
  const accounts = claude.accounts ?? [];
  const active = accounts.find((a) => a.active) ?? accounts[0];
  if (active) {
    return { label: active.label, windows: active.windows, capturedAt: active.capturedAt };
  }
  return {
    label: claude.accountEmail ?? claude.planType ?? null,
    windows: claude.windows,
    capturedAt: claude.capturedAt,
  };
}

/** Ring model for Claude's five-hour window, or null when not connected. */
export function claudeRingModel(usage: UsageResponse | null, now: number): UsageRingModel | null {
  const claude = usage?.providers.claude;
  if (!claude?.connected) return null;
  const { label, windows, capturedAt } = activeClaude(claude);
  const fiveHour = findWindow(windows, 'five_hour');
  const weekly = findWindow(windows, 'seven_day');
  const percent = fiveHour?.usedPercent ?? 0;
  const stale = isUsageStale(capturedAt, now);
  const unknown = !fiveHour;
  const reset = localTime(fiveHour?.resetsAt ?? null);
  const parts: string[] = [];
  if (reset) parts.push(`resets ${reset}`);
  if (weekly) parts.push(`week ${Math.round(weekly.usedPercent)}%`);
  return {
    provider: 'claude',
    label: '5hr',
    percent,
    stale,
    unknown,
    primaryText: `Claude${label ? ` · ${label}` : ''} · ${Math.round(percent)}% of 5hr used`,
    secondaryText: parts.length > 0 ? parts.join(' · ') : null,
  };
}

/** Ring model for Codex's weekly window, or null when not connected. */
export function codexRingModel(usage: UsageResponse | null, now: number): UsageRingModel | null {
  const codex = usage?.providers.codex;
  if (!codex?.connected) return null;
  const weekly = codexWeeklyWindow(codex.windows);
  const percent = weekly?.usedPercent ?? 0;
  const stale = isUsageStale(codex.capturedAt, now);
  const unknown = !weekly;
  const reset = localTime(weekly?.resetsAt ?? null);
  return {
    provider: 'codex',
    label: 'week',
    percent,
    stale,
    unknown,
    primaryText: `Codex${codex.planType ? ` · ${codex.planType}` : ''} · ${Math.round(percent)}% of week used`,
    secondaryText: reset ? `resets ${reset}` : null,
  };
}

/** Full accessible sentence for a ring: both tooltip lines, plus the target. */
export function ringAriaLabel(model: UsageRingModel): string {
  const lines = [model.primaryText, model.secondaryText].filter(Boolean);
  return `${lines.join(' · ')}. Open usage settings.`;
}

/**
 * Leading-edge-off, trailing-edge debouncer for `usage_updated` pushes: the
 * first push arms a timer, every push inside the window is swallowed, and one
 * fetch runs at the end. A turn that emits several rate-limit events therefore
 * costs one GET, not one per event. `cancel` is for unmount.
 */
export function createPushDebouncer(
  run: () => void,
  waitMs: number = USAGE_PUSH_DEBOUNCE_MS,
): { push: () => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    push() {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        run();
      }, waitMs);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

export interface UsageState {
  usage: UsageResponse | null;
  /** Ticks every USAGE_TICK_MS so staleness and reset text stay honest. */
  now: number;
  /** A failed request: stop asking until the session or account changes. */
  unavailable: boolean;
}

export function useUsage(chatOpen: boolean): UsageState {
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const activeRef = useRef(true);
  const unavailableRef = useRef(false);
  const inFlightRef = useRef(false);
  const usageRef = useRef<UsageResponse | null>(null);
  const chatOpenRef = useRef(chatOpen);
  chatOpenRef.current = chatOpen;

  useEffect(() => {
    activeRef.current = true;
    let requestId = 0;

    const load = (refresh: boolean): void => {
      if (unavailableRef.current || inFlightRef.current) return;
      inFlightRef.current = true;
      const id = ++requestId;
      void api
        .usage(refresh)
        .then((next) => {
          if (!activeRef.current || id !== requestId) return;
          usageRef.current = next;
          setUsage(next);
          setNow(Date.now());
        })
        .catch(() => {
          // Stop after a failed request rather than retrying on every push.
          if (activeRef.current && id === requestId) {
            unavailableRef.current = true;
            setUnavailable(true);
          }
        })
        .finally(() => {
          if (id === requestId) inFlightRef.current = false;
        });
    };

    load(false);

    const debouncer = createPushDebouncer(() => load(false));
    const offPush = wsBus.subscribeGlobal((kind) => {
      if (kind !== 'usage_updated' || unavailableRef.current) return;
      debouncer.push();
    });
    const offAccount = subscribeCodexAccountChanges(() => {
      // Drop the old account immediately, including any request already in flight.
      ++requestId;
      inFlightRef.current = false;
      debouncer.cancel();
      // A successful admin action is a new opportunity after a failed usage read.
      unavailableRef.current = false;
      setUnavailable(false);
      const previous = usageRef.current;
      if (previous) {
        const next: UsageResponse = {
          ...previous,
          providers: {
            ...previous.providers,
            codex: { connected: false, planType: null, windows: [], capturedAt: null, source: null, error: null },
          },
        };
        usageRef.current = next;
        setUsage(next);
      }
      load(false);
    });

    const tick = setInterval(() => {
      if (!activeRef.current) return;
      const at = Date.now();
      setNow(at);
      // Nothing fresh has arrived in five minutes and a chat is open: spend one
      // probe. The server coalesces anything inside 15s, so this stays cheap.
      if (shouldReprobe({ newestMs: newestCapturedAtMs(usageRef.current), chatOpen: chatOpenRef.current, now: at })) {
        load(true);
      }
    }, USAGE_TICK_MS);

    return () => {
      activeRef.current = false;
      ++requestId;
      inFlightRef.current = false;
      debouncer.cancel();
      clearInterval(tick);
      offPush();
      offAccount();
    };
  }, []);

  return { usage, now, unavailable };
}
