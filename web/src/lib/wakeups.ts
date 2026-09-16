import type { PendingWakeup } from './types';

/** The raw conversation_wakeups row as the server sends it. */
export interface WakeupRow {
  id: string;
  wake_key: string;
  reason: string;
  scheduled_for: string;
  created_at: string;
  status?: string;
}

// SQLite's datetime('now') has no zone suffix but is UTC; parsing it as local
// time would shift created_at by the offset and skew the progress bar.
function toIso(value: string): string {
  if (!value) return value;
  const normalized = /[Zz]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value.replace(' ', 'T')}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

export function toPendingWakeup(row: WakeupRow): PendingWakeup {
  return {
    id: row.id,
    key: row.wake_key,
    reason: row.reason,
    scheduledFor: toIso(row.scheduled_for),
    createdAt: toIso(row.created_at),
  };
}

/** Pending only, soonest first — the order the chip renders in. */
export function toPendingWakeups(rows: WakeupRow[] | undefined): PendingWakeup[] {
  return (rows ?? [])
    .filter((row) => row.status === undefined || row.status === 'pending')
    .map(toPendingWakeup)
    .sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor));
}
