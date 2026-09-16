// Pure formatting helpers for the Settings → Usage section. Kept free of React
// so the countdown / relative-time logic is unit-testable in isolation.

/** Parse an ISO-8601 (or "YYYY-MM-DD HH:MM:SS") timestamp to epoch ms, or NaN. */
export function parseTime(iso: string): number {
  const d = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
  return d.getTime();
}

/** Coarse, human duration for a positive span of seconds: "3h 12m", "2d 4h", "12m", "<1m". */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  if (mins > 0) return `${mins}m`;
  return '<1m';
}

/**
 * Friendly relative countdown for a window reset time. Returns "resets in 3h 12m"
 * for a future time, "resets soon" when it's within ~30s or already past, or null
 * when there's no reset time to show.
 */
export function formatReset(resetsAt: string | null, now: number = Date.now()): string | null {
  if (!resetsAt) return null;
  const end = parseTime(resetsAt);
  if (Number.isNaN(end)) return null;
  const secs = Math.round((end - now) / 1000);
  if (secs <= 30) return 'resets soon';
  return `resets in ${formatDuration(secs)}`;
}

/**
 * Freshness hint from a capture time: "as of just now", "as of 25 min ago",
 * "as of 3h ago", "as of 2d ago". Returns null when there's no capture time.
 * Future / negative spans clamp to "as of just now".
 */
export function formatFreshness(capturedAt: string | null, now: number = Date.now()): string | null {
  if (!capturedAt) return null;
  const t = parseTime(capturedAt);
  if (Number.isNaN(t)) return null;
  const secs = Math.round((now - t) / 1000);
  if (secs < 60) return 'as of just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `as of ${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `as of ${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `as of ${days}d ago`;
}
