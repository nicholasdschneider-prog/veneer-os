import type Database from 'better-sqlite3';

/** Gate new automatic work, never interrupt a turn or throttle a human reply. */
export function createBackgroundAdmission(db: Database.Database, limit = 4): () => boolean {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) {
    throw new Error('VP_BACKGROUND_ACTIVE_LIMIT must be an integer from 1 to 32');
  }
  const active = db.prepare("SELECT COUNT(*) AS n FROM pending_turns WHERE status='pending'");
  let blocked = false;
  // Called before each dispatch, not once per tick: a synchronous dispatch
  // reserves its pending turn before the next scheduler can consume a slot.
  return () => {
    const count = (active.get() as { n: number }).n;
    const nextBlocked = count >= limit;
    if (nextBlocked !== blocked) {
      console.info(`[background-admission] ${nextBlocked ? 'deferring new automatic work' : 'capacity available'}; active=${count} limit=${limit}`);
      blocked = nextBlocked;
    }
    return !nextBlocked;
  };
}
