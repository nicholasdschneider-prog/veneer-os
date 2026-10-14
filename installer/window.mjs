// The approved maintenance window, checked the same way everywhere.
//
// Call assertWithinWindow with a FRESH clock read: after every awaited or
// expensive check (occupancy, pending turns, binding verification, backup
// hash) and immediately before every irreversible step (plist write, pointer
// move, reload-helper bootstrap, each bootout, the `running` commit). A time
// captured before an await or a hash is never used to decide.

export class WindowEndedError extends Error {
  constructor(message) { super(message); this.code = 'refused_deadline'; }
}

/**
 * Throws WindowEndedError (code `refused_deadline`) unless now < deadline.
 * `deadline` is an ISO string, epoch ms or null (no window bound); `now` is a
 * clock function, called here so the read is always current.
 */
export function assertWithinWindow(deadline, now, phase) {
  if (deadline === null || deadline === undefined) return;
  const end = typeof deadline === 'number' ? deadline : Date.parse(deadline);
  if (!Number.isFinite(end)) throw new WindowEndedError(`${phase}: the approved window end is not a valid time`);
  const t = now();
  const ms = t instanceof Date ? t.getTime() : t;
  if (!(ms < end)) throw new WindowEndedError(`${phase}: refused_deadline: the approved window ended at ${new Date(end).toISOString()}`);
}
