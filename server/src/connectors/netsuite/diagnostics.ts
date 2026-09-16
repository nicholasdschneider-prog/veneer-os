export type NetSuiteDiagnostic = {
  event: 'token' | 'request' | 'retry' | 'page' | 'suiteql' | 'health';
  operation?: 'token' | 'rest' | 'suiteql' | 'health';
  attempt?: number;
  status?: number | 'ok' | 'error' | 'cached';
  durationMs?: number;
  totalDurationMs?: number;
  delayMs?: number;
  reason?: 'network' | 'status' | 'authentication' | 'timeout';
  timeoutStage?: 'token' | 'request' | 'backoff' | 'total';
  page?: number;
  pages?: number;
  rows?: number;
};

const PREFIX = '[netsuite] ';
const EVENTS = new Set(['token', 'request', 'retry', 'page', 'suiteql', 'health']);
const OPERATIONS = new Set(['token', 'rest', 'suiteql', 'health']);
const STRING_STATUSES = new Set(['ok', 'error', 'cached']);
const REASONS = new Set(['network', 'status', 'authentication', 'timeout']);
const TIMEOUT_STAGES = new Set(['token', 'request', 'backoff', 'total']);
const NUMERIC_FIELDS = new Set([
  'attempt',
  'durationMs',
  'totalDurationMs',
  'delayMs',
  'page',
  'pages',
  'rows',
]);
const ALLOWED_FIELDS = new Set([
  'component',
  'event',
  'operation',
  'attempt',
  'status',
  'durationMs',
  'totalDurationMs',
  'delayMs',
  'reason',
  'timeoutStage',
  'page',
  'pages',
  'rows',
]);

export function formatNetSuiteDiagnostic(fields: NetSuiteDiagnostic): string {
  return `${PREFIX}${JSON.stringify({ component: 'netsuite', ...fields })}`;
}

/**
 * Accept only the fixed metadata schema produced by nsClient. This lets the
 * provider harness forward nested MCP stderr without turning arbitrary CLI or
 * third-party connector output into platform logs.
 */
export function parseNetSuiteDiagnosticLine(line: string): string | null {
  const prefixAt = line.indexOf(PREFIX);
  if (prefixAt < 0) return null;
  const raw = line.slice(prefixAt + PREFIX.length).trim();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    parsed.component !== 'netsuite' ||
    typeof parsed.event !== 'string' ||
    !EVENTS.has(parsed.event) ||
    Object.keys(parsed).some((key) => !ALLOWED_FIELDS.has(key))
  ) {
    return null;
  }
  if (parsed.operation !== undefined && (typeof parsed.operation !== 'string' || !OPERATIONS.has(parsed.operation))) return null;
  if (
    parsed.status !== undefined &&
    !(
      (typeof parsed.status === 'number' && Number.isFinite(parsed.status)) ||
      (typeof parsed.status === 'string' && STRING_STATUSES.has(parsed.status))
    )
  ) {
    return null;
  }
  if (parsed.reason !== undefined && (typeof parsed.reason !== 'string' || !REASONS.has(parsed.reason))) return null;
  if (
    parsed.timeoutStage !== undefined &&
    (typeof parsed.timeoutStage !== 'string' || !TIMEOUT_STAGES.has(parsed.timeoutStage))
  ) {
    return null;
  }
  for (const field of NUMERIC_FIELDS) {
    const value = parsed[field];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) return null;
  }
  return `${PREFIX}${JSON.stringify(parsed)}`;
}

export function forwardNetSuiteDiagnosticChunk(
  buffered: string,
  chunk: string,
  log: Pick<Console, 'error'>,
): string {
  const combined = buffered + chunk;
  const lines = combined.split(/\r?\n/);
  const remainder = lines.pop() ?? '';
  for (const line of lines) {
    const safe = parseNetSuiteDiagnosticLine(line);
    if (safe) log.error(safe);
  }
  return remainder.slice(-4_096);
}
