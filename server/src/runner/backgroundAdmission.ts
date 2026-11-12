import type Database from 'better-sqlite3';
import { DISK_FLOOR_BLOCK_BYTES, DISK_FLOOR_RESUME_BYTES, gib, type DiskFloorStatus } from './diskFloorStatus.js';

const REPORT_EVERY_MS = 60_000;

/** Gate new automatic work, never interrupt a turn or throttle a human reply. */
export function createBackgroundAdmission(
  db: Database.Database,
  limit = 4,
  freeBytes?: () => number,
  /** Receives the disk floor on every change and at most once a minute otherwise. */
  reportDisk?: (status: DiskFloorStatus) => void,
  now: () => number = Date.now,
): ((opts?: { ignoreActiveLimit?: boolean }) => boolean) & { diskStatus: () => DiskFloorStatus | null } {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) {
    throw new Error('VP_BACKGROUND_ACTIVE_LIMIT must be an integer from 1 to 32');
  }
  const active = db.prepare("SELECT COUNT(*) AS n FROM pending_turns WHERE status='pending'");
  let blocked = false;
  let diskBlocked = false;
  let disk: DiskFloorStatus | null = null;
  let lastReport = 0;

  function checkDisk(): void {
    if (!freeBytes) return;
    let free: number | null;
    try {
      const value = freeBytes();
      free = Number.isFinite(value) ? value : null;
    } catch {
      free = null;
    }
    const next = free === null || free < (diskBlocked ? DISK_FLOOR_RESUME_BYTES : DISK_FLOOR_BLOCK_BYTES);
    const at = now();
    const changed = disk === null || next !== diskBlocked;
    if (changed && (disk !== null || next)) {
      const freeText = free === null ? 'unknown' : `${gib(free)} GiB`;
      console.info(
        next
          ? `[background-admission] disk floor: holding new automatic work; free=${freeText}, resumes at ${gib(DISK_FLOOR_RESUME_BYTES)} GiB`
          : `[background-admission] disk floor cleared; free=${freeText}`,
      );
    }
    diskBlocked = next;
    disk = {
      diskBlocked,
      freeBytes: free,
      sinceAt: changed ? new Date(at).toISOString() : disk!.sinceAt,
      resumeAtBytes: DISK_FLOOR_RESUME_BYTES,
      updatedAt: new Date(at).toISOString(),
    };
    if (reportDisk && (changed || at - lastReport >= REPORT_EVERY_MS)) {
      lastReport = at;
      try {
        reportDisk(disk);
      } catch (err) {
        console.warn(`[background-admission] could not record disk status: ${(err as Error).message}`);
      }
    }
  }

  // Called before each dispatch, not once per tick: a synchronous dispatch
  // reserves its pending turn before the next scheduler can consume a slot.
  // ignoreActiveLimit admits a human reply past the turn limit; the disk
  // floor still applies, and it does not change the logged admission state.
  const admit = (opts: { ignoreActiveLimit?: boolean } = {}) => {
    checkDisk();
    if (opts.ignoreActiveLimit) return !diskBlocked;
    const count = (active.get() as { n: number }).n;
    const nextBlocked = count >= limit || diskBlocked;
    if (nextBlocked !== blocked) {
      console.info(`[background-admission] ${nextBlocked ? 'deferring new automatic work' : 'capacity available'}; active=${count} limit=${limit} diskBlocked=${diskBlocked}`);
      blocked = nextBlocked;
    }
    return !nextBlocked;
  };
  return Object.assign(admit, { diskStatus: () => disk });
}
