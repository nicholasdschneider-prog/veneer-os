import type Database from 'better-sqlite3';

/**
 * The runner's disk floor (see backgroundAdmission.ts) holds new automatic
 * work, builds included, below 10 GiB free and keeps holding until 12 GiB.
 * The runner publishes its view in the shared settings table so the web
 * process and bots can say why queued work is not starting.
 */
export const DISK_FLOOR_SETTING = 'runner_disk_floor';
export const DISK_FLOOR_BLOCK_BYTES = 10 * 1024 ** 3;
export const DISK_FLOOR_RESUME_BYTES = 12 * 1024 ** 3;
/** The runner refreshes once a minute; older rows mean the runner is not reporting. */
const STALE_AFTER_MS = 5 * 60_000;

export interface DiskFloorStatus {
  diskBlocked: boolean;
  /** Free bytes on the data volume at the last check; null when it could not be read. */
  freeBytes: number | null;
  /** ISO time the current blocked/clear state began. */
  sinceAt: string;
  resumeAtBytes: number;
  /** ISO time of the last write. */
  updatedAt: string;
}

export function writeDiskFloorStatus(db: Database.Database, status: DiskFloorStatus): void {
  db.prepare(
    'INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json',
  ).run(DISK_FLOOR_SETTING, JSON.stringify(status));
}

/** The active disk floor, or null when space is fine, unknown, or the report is stale. */
export function activeDiskFloor(db: Database.Database, now = Date.now()): DiskFloorStatus | null {
  try {
    const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(DISK_FLOOR_SETTING) as
      | { value_json: string }
      | undefined;
    if (!row) return null;
    const status = JSON.parse(row.value_json) as DiskFloorStatus;
    if (!status.diskBlocked) return null;
    if (!(now - Date.parse(status.updatedAt) <= STALE_AFTER_MS)) return null;
    return status;
  } catch {
    return null;
  }
}

export function gib(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}

/** One line for people and bots: why queued work is not starting. */
export function diskFloorLine(status: DiskFloorStatus): string {
  const free = status.freeBytes === null ? 'free space unknown' : `${gib(status.freeBytes)} GiB free`;
  return (
    `Paused: disk low (${free}, needs ${gib(status.resumeAtBytes)}). ` +
    'Builds and bot wake-ups resume automatically once space is freed.'
  );
}
