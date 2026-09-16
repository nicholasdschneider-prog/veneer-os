const EASTERN_TIME_ZONE = 'America/New_York';

// Claude Code names the reset zone in parentheses. Historically always UTC;
// current builds write the user's own IANA zone ("America/Indianapolis").
const CLAUDE_LIMIT_RESET_RE =
  /^(You've (?:hit|reached) your .+? limit · resets )(\d{1,2})(?::(\d{2}))?(am|pm) \(([^)]+)\)$/i;

export interface ClaudeRateLimitMessageMetadata {
  isApiErrorMessage?: boolean;
  apiErrorStatus?: number;
  error?: string;
  model?: string;
  resultError?: boolean;
}

function nextUtcReset(reference: Date, hour12: number, minute: number, meridiem: string): Date | null {
  if (!Number.isFinite(reference.getTime()) || hour12 < 1 || hour12 > 12 || minute < 0 || minute > 59) return null;
  const hour = (hour12 % 12) + (meridiem.toLowerCase() === 'pm' ? 12 : 0);
  let reset = new Date(
    Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate(), hour, minute),
  );
  if (reset.getTime() < reference.getTime()) reset = new Date(reset.getTime() + 24 * 60 * 60 * 1_000);
  return reset;
}

function isUtcZone(zone: string): boolean {
  return zone.trim().toUpperCase() === 'UTC';
}

/**
 * Offset (ms) of `zone` from UTC at `instant`, or null when Intl rejects the
 * zone. Formatting the instant in the zone and reading it back as if it were
 * UTC is the standard way to recover an offset without a tz database.
 */
function zoneOffsetMs(zone: string, instant: Date): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(instant);
    const field = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
    const asUtc = Date.UTC(
      field('year'),
      field('month') - 1,
      field('day'),
      field('hour') % 24, // some locales render midnight as 24
      field('minute'),
      field('second'),
    );
    if (!Number.isFinite(asUtc)) return null;
    return asUtc - instant.getTime();
  } catch {
    return null; // unknown/invalid IANA zone
  }
}

/** The instant a wall-clock time in `zone` corresponds to. Two passes settle DST. */
function instantForZonedWallClock(
  zone: string,
  parts: { year: number; month: number; day: number; hour: number; minute: number },
): Date | null {
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  let instant = wall;
  for (let pass = 0; pass < 2; pass++) {
    const offset = zoneOffsetMs(zone, new Date(instant));
    if (offset === null) return null;
    instant = wall - offset;
  }
  return new Date(instant);
}

/** Calendar date `instant` falls on inside `zone`. */
function zonedDate(zone: string, instant: Date): { year: number; month: number; day: number } | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(instant);
    const field = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
    const year = field('year');
    const month = field('month');
    const day = field('day');
    if (![year, month, day].every(Number.isFinite)) return null;
    return { year, month, day };
  } catch {
    return null;
  }
}

/** Next occurrence of a 12-hour clock time in an IANA zone, after `reference`. */
function nextZonedReset(
  zone: string,
  reference: Date,
  hour12: number,
  minute: number,
  meridiem: string,
): Date | null {
  if (!Number.isFinite(reference.getTime()) || hour12 < 1 || hour12 > 12 || minute < 0 || minute > 59) return null;
  const hour = (hour12 % 12) + (meridiem.toLowerCase() === 'pm' ? 12 : 0);
  const today = zonedDate(zone, reference);
  if (!today) return null;
  const first = instantForZonedWallClock(zone, { ...today, hour, minute });
  if (!first) return null;
  if (first.getTime() >= reference.getTime()) return first;
  // Already past today — the reset is the same clock time tomorrow. Build the
  // next calendar day in the zone (UTC arithmetic on the date parts is safe:
  // only the day number matters, and it is resolved back through the zone).
  const tomorrow = new Date(Date.UTC(today.year, today.month - 1, today.day) + 24 * 60 * 60 * 1_000);
  return instantForZonedWallClock(zone, {
    year: tomorrow.getUTCFullYear(),
    month: tomorrow.getUTCMonth() + 1,
    day: tomorrow.getUTCDate(),
    hour,
    minute,
  });
}

/**
 * The absolute reset instant a Claude limit message names, or null when the
 * text is not a limit message or names a zone Intl cannot resolve. Callers that
 * need a deadline (account failover) fall back to a fixed window instead.
 */
export function parseClaudeLimitReset(text: string, at: Date = new Date()): Date | null {
  const match = CLAUDE_LIMIT_RESET_RE.exec(text.trim());
  if (!match) return null;
  const hour = Number(match[2]);
  const minute = Number(match[3] ?? 0);
  const zone = match[5]!;
  if (isUtcZone(zone)) return nextUtcReset(at, hour, minute, match[4]!);
  return nextZonedReset(zone, at, hour, minute, match[4]!);
}

const CLAUDE_LIMIT_PREFIX_RE = /^You've (?:hit|reached) your .+? limit\b/i;

/**
 * True when an assistant message is Claude Code's synthetic subscription-limit
 * reply. The stream carries only `isApiErrorMessage` (the 429 status and
 * `error: 'rate_limit'` exist in the on-disk session file, not on stdout), so
 * trust the metadata the CLI does send and confirm with the message text.
 */
export function isClaudeSessionLimitMessage(text: string, metadata: ClaudeRateLimitMessageMetadata): boolean {
  return isTrustedClaudeRateLimit(metadata) && CLAUDE_LIMIT_PREFIX_RE.test(text.trim());
}

function isTrustedClaudeRateLimit(metadata: ClaudeRateLimitMessageMetadata): boolean {
  return Boolean(
    metadata.resultError
      || metadata.isApiErrorMessage
      || metadata.apiErrorStatus === 429
      || metadata.error === 'rate_limit'
      || metadata.model === '<synthetic>',
  );
}

/**
 * Claude Code writes subscription limit failures as synthetic assistant text.
 * Older builds clock them in UTC, which reads as a puzzle; localize only those.
 * A message that already names a local zone is left exactly as written — it is
 * in the user's own time. Claude's transcript is never touched either way; this
 * rewrites only the normalized event Veneer sends to the UI.
 */
export function displayClaudeRateLimitMessage(
  text: string,
  metadata: ClaudeRateLimitMessageMetadata,
  at: Date = new Date(),
): string {
  const match = CLAUDE_LIMIT_RESET_RE.exec(text);
  if (!match || !isTrustedClaudeRateLimit(metadata)) return text;
  if (!isUtcZone(match[5]!)) return text;

  const hour = Number(match[2]);
  const minute = Number(match[3] ?? 0);
  const reset = nextUtcReset(at, hour, minute, match[4]!);
  if (!reset) return text;

  const eastern = new Intl.DateTimeFormat('en-US', {
    timeZone: EASTERN_TIME_ZONE,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  }).format(reset);
  return `${match[1]}${eastern}`;
}
