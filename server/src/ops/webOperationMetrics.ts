/** Fixed labels only: never record requests, SQL, identities or exception text. */
export const WEB_OPERATION_PHASES = ['routines', 'stale_questions', 'question_rechecks', 'call_poll', 'notifications', 'search'] as const;
export type WebOperationPhase = typeof WEB_OPERATION_PHASES[number];
type Kind = 'sync' | 'elapsed';
type Failure = 'none' | 'busy' | 'locked' | 'timeout' | 'other';
export interface WebOperation { at: number; phase: WebOperationPhase; kind: Kind; ms: number; failure: Failure }
const LIMIT = 32, AGE_MS = 300000, COALESCE_MS = 30000, SLOW_MS = 100;

function failureCategory(error: unknown): Failure {
  if (!error || typeof error !== 'object') return 'other';
  const value = error as { code?: unknown; name?: unknown };
  if (typeof value.code === 'string') {
    if (value.code === 'SQLITE_BUSY' || value.code.startsWith('SQLITE_BUSY_')) return 'busy';
    if (value.code === 'SQLITE_LOCKED' || value.code.startsWith('SQLITE_LOCKED_')) return 'locked';
  }
  return value.name === 'TimeoutError' || value.name === 'AbortError' ? 'timeout' : 'other';
}

/** Reconstruct known fields; callers never forward arbitrary telemetry keys. */
export function sanitizeWebOperations(input: unknown, at: number): WebOperation[] {
  if (!Array.isArray(input) || !Number.isFinite(at)) return [];
  return input.slice(-LIMIT).flatMap((raw: unknown): WebOperation[] => {
    if (!raw || typeof raw !== 'object') return [];
    const value = raw as WebOperation;
    if (!WEB_OPERATION_PHASES.includes(value.phase) || !['sync', 'elapsed'].includes(value.kind)
      || !['none', 'busy', 'locked', 'timeout', 'other'].includes(value.failure)
      || !Number.isFinite(value.at) || value.at > at || value.at < at - AGE_MS
      || !Number.isFinite(value.ms) || value.ms < 0) return [];
    return [{ at: value.at, phase: value.phase, kind: value.kind, ms: Math.min(60000, Math.round(value.ms * 10) / 10), failure: value.failure }];
  });
}

/** Requires the independently verified listener and a fresh atomic publication. */
export function readWebOperations(telemetry: unknown, pid: number, at: number): WebOperation[] {
  if (!telemetry || typeof telemetry !== 'object' || !Number.isFinite(at)) return [];
  const value = telemetry as { pid?: unknown; at?: unknown; operations?: unknown };
  if (value.pid !== pid || typeof value.at !== 'number' || !Number.isFinite(value.at)
    || value.at > at || at - value.at >= 90000) return [];
  return sanitizeWebOperations(value.operations, at);
}

export function createWebOperationMetrics(clocks = { wall: () => Date.now(), monotonic: () => performance.now() }) {
  let entries: WebOperation[] = [];
  const record = (phase: WebOperationPhase, kind: Kind, start: number, failure: Failure) => {
    const ms = clocks.monotonic() - start;
    if (!Number.isFinite(ms) || ms < 0 || (ms < SLOW_MS && failure === 'none')) return;
    const at = clocks.wall();
    const next = sanitizeWebOperations([{ at, phase, kind, ms, failure }], at)[0];
    if (!next) return;
    // Coalesce repeated evidence for the same phase/kind within 30 seconds.
    entries = sanitizeWebOperations(entries, at).filter(entry => entry.phase !== phase || entry.kind !== kind || at - entry.at >= COALESCE_MS);
    entries.push(next); entries = entries.slice(-LIMIT);
  };
  return {
    snapshot: () => sanitizeWebOperations(entries, clocks.wall()),
    measure<T>(phase: WebOperationPhase, work: () => T): T {
      const start = clocks.monotonic();
      try { const result = work(); record(phase, 'sync', start, 'none'); return result; }
      catch (error) { record(phase, 'sync', start, failureCategory(error)); throw error; }
    },
    async measureAsync<T>(phase: WebOperationPhase, work: () => Promise<T>): Promise<T> {
      const start = clocks.monotonic();
      let pending: Promise<T>;
      try { pending = work(); record(phase, 'sync', start, 'none'); }
      catch (error) { record(phase, 'sync', start, failureCategory(error)); throw error; }
      try { const result = await pending; record(phase, 'elapsed', start, 'none'); return result; }
      catch (error) { record(phase, 'elapsed', start, failureCategory(error)); throw error; }
    },
  };
}
export type WebOperationMetrics = ReturnType<typeof createWebOperationMetrics>;
