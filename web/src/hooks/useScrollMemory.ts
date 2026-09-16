import { useEffect, useLayoutEffect, useRef } from 'react';

// Remembers a scroll container's offset across unmounts so a screen that is
// swapped out (mobile routing renders one pane at a time) comes back where the
// user left it. In-memory only: a reload starts at the top, which is the
// expected "fresh" behaviour.
const positions = new Map<string, number>();

/** How long a mount keeps trying to reach the remembered offset while rows load. */
const RESTORE_WINDOW_MS = 3000;

export function readScrollPosition(key: string): number {
  return positions.get(key) ?? 0;
}

export function saveScrollPosition(key: string, top: number): void {
  positions.set(key, top);
}

export function clearScrollPositions(): void {
  positions.clear();
}

type Scrollable = { scrollTop: number };

/**
 * One restore attempt. Rows arrive asynchronously, so the container may still
 * be too short to reach the target; the browser clamps the assignment, and the
 * caller retries on the next render until the offset actually lands.
 */
export function restoreScrollStep(el: Scrollable, target: number): 'done' | 'retry' {
  el.scrollTop = target;
  return el.scrollTop >= target - 1 ? 'done' : 'retry';
}

/**
 * Whether a scroll event during a pending restore came from the user rather
 * than from our own clamped assignment. A user gesture moves the offset away
 * from whatever we last assigned, which means: stop restoring, they took over.
 */
export function userScrolledAway(current: number, lastAssigned: number | null): boolean {
  return lastAssigned !== null && current !== lastAssigned;
}

/**
 * Attach the returned ref to a scroll container. Its offset is saved on every
 * scroll and on unmount, and restored on the next mount under the same key.
 */
export function useScrollMemory<T extends HTMLElement>(key: string) {
  const ref = useRef<T>(null);
  const target = useRef(readScrollPosition(key));
  const pending = useRef(target.current > 0);
  const lastAssigned = useRef<number | null>(null);
  const timer = useRef<number | null>(null);

  // Stops the restore window: put browser scroll anchoring back and stop
  // re-asserting the offset.
  const finish = () => {
    pending.current = false;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    if (ref.current) ref.current.style.overflowAnchor = '';
  };

  // Runs after every render: each data arrival re-renders, so this naturally
  // retries as the list grows until the remembered offset is reachable, and
  // re-asserts it if a later load nudged it. Scroll anchoring is off for the
  // window because rows inserting above the viewport would otherwise shift a
  // correctly restored offset to keep the interim content in place.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !pending.current) return;
    if (timer.current === null) {
      el.style.overflowAnchor = 'none';
      timer.current = window.setTimeout(finish, RESTORE_WINDOW_MS);
    }
    restoreScrollStep(el, target.current);
    lastAssigned.current = el.scrollTop;
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      if (pending.current && userScrolledAway(el.scrollTop, lastAssigned.current)) finish();
      saveScrollPosition(key, el.scrollTop);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [key]);

  // Final save must be a layout-effect cleanup: passive cleanups run after the
  // node is already detached, and a detached element reports scrollTop 0.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    return () => {
      saveScrollPosition(key, el.scrollTop);
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [key]);

  return ref;
}
