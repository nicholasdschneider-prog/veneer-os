import { api } from './api';

/**
 * Archive grace period. Tapping "archive" (from the chat list or the chat
 * header) doesn't write immediately — the row shows as "Archiving…" with an
 * Undo for a few seconds, and only then does the `archived=true` PATCH fire.
 *
 * The tricky part is that the intent lives only in this tab's memory during the
 * grace window, so it must survive two things:
 *   1. Component unmount / SPA navigation — handled by keeping the timers here
 *      at module scope rather than inside a component. The timer fires normally
 *      even after you leave the chat or the list.
 *   2. Page unload (refresh / tab close) — handled by the `pagehide` listener
 *      below, which flushes every still-pending write with a keepalive request
 *      so it completes during teardown. Without this, a quick refresh would
 *      silently cancel the archive (the bug this module fixes).
 *
 * Undo simply cancels the pending write, so an undone archive never hits the
 * server — which also means it never needlessly interrupts a still-working
 * agent (the server-side archive kills any running agent).
 */

const timers = new Map<string, ReturnType<typeof setTimeout>>();

// Ids whose archive write has fired (grace period elapsed) but which a still
// in-flight list poll may briefly re-surface: a poll that was sent BEFORE the
// server archived returns stale "still active" data and, landing after the row
// was dropped, re-inserts it for a few seconds until the next poll. We hold
// each committed id here and hide it from rendered lists until the polls catch
// up, then drop it (below) for memory hygiene. See isArchiveCommitted.
const committed = new Set<string>();

// A committed id stays hidden this long after its write resolves — long enough
// to outlast any poll that was already in flight when the archive landed (those
// resolve within a round-trip of the server processing the write). Any poll
// started after the write returns archived-excluded data, so this can be short.
const COMMITTED_HOLD_MS = 6_000;

// Bumped on every change; components subscribe via useSyncExternalStore to
// re-render their "Archiving…" rows as pending state comes and goes.
let version = 0;
const listeners = new Set<() => void>();
function notify() {
  version += 1;
  for (const l of listeners) l();
}

export function subscribePendingArchive(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function pendingArchiveVersion(): number {
  return version;
}

export function isArchivePending(id: string): boolean {
  return timers.has(id);
}

/**
 * True from the moment an archive's write fires until the polls have caught up.
 * Lists should hide these rows entirely (unlike pending rows, which stay visible
 * greyed with Undo) so a stale in-flight poll can't briefly re-surface them.
 */
export function isArchiveCommitted(id: string): boolean {
  return committed.has(id);
}

/**
 * Start (or ignore, if already pending) the deferred archive for a chat.
 * `onCommit` runs after the write lands — callers use it to drop the row from a
 * visible list ahead of the next poll. It is not called if the write is undone
 * or flushed on unload.
 */
export function scheduleArchive(id: string, delayMs: number, onCommit?: () => void): void {
  if (timers.has(id)) return;
  timers.set(
    id,
    setTimeout(() => {
      timers.delete(id);
      // Hide the row immediately and keep it hidden across the write and the
      // window where an earlier poll may still be in flight (see `committed`).
      committed.add(id);
      notify();
      void api
        .updateConversation(id, { archived: true })
        .then(() => {
          onCommit?.();
          // Write landed; hold briefly so any in-flight poll resolves, then drop.
          setTimeout(() => {
            committed.delete(id);
            notify();
          }, COMMITTED_HOLD_MS);
        })
        .catch(() => {
          // Write failed — un-hide so the row reappears rather than vanishing.
          committed.delete(id);
          notify();
        });
    }, delayMs),
  );
  notify();
}

/** Cancel a pending archive (Undo) — the write never happens. */
export function cancelArchive(id: string): void {
  const t = timers.get(id);
  if (!t) return;
  clearTimeout(t);
  timers.delete(id);
  notify();
}

if (typeof window !== 'undefined') {
  // The page is going away — commit every pending archive before we lose them.
  // keepalive lets these PATCHes finish after the document is torn down.
  const flush = () => {
    for (const [id, t] of timers) {
      clearTimeout(t);
      void api.updateConversation(id, { archived: true }, { keepalive: true }).catch(() => undefined);
    }
    timers.clear();
  };
  // pagehide is the reliable unload signal on mobile Safari (where this app
  // mostly runs); it covers refresh, tab close, and bfcache navigation.
  window.addEventListener('pagehide', flush);
}
