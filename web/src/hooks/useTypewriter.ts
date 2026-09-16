import { useEffect, useRef, useState } from 'react';

// Reveal speed for assistant text: faster than a human reads, so it never
// feels like it's dragging, but slow enough that a burst of text (a fast
// model, a reconnect replaying a whole buffered turn) reads as "typed" rather
// than a giant block appearing instantly.
const CHARS_PER_SEC = 260;
// However long the backlog, catch up within this many seconds — otherwise a
// very long message would take an unreasonably long time to fully reveal.
const MAX_CATCHUP_SEC = 1.2;

/**
 * Reveals `target` progressively instead of all at once. While `active` is
 * false the full target is shown immediately (used for history loaded from a
 * snapshot, which shouldn't animate). While true, revealed text catches up to
 * `target` at a capped rate that accelerates for large backlogs.
 */
export function useTypewriter(target: string, active: boolean): string {
  const [revealed, setRevealed] = useState(() => (active ? '' : target));
  const targetRef = useRef(target);
  const revealedLenRef = useRef(active ? 0 : target.length);
  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef<number | null>(null);
  targetRef.current = target;

  useEffect(() => {
    if (!active) {
      revealedLenRef.current = target.length;
      setRevealed(target);
    }
  }, [target, active]);

  // Kicks the reveal loop off whenever there's fresh backlog. Deliberately
  // does NOT cancel/restart an already-running loop on every new delta — the
  // loop reads targetRef each frame, so new text just feeds it. Restarting on
  // every delta reset the frame-timing baseline dozens of times a second and
  // is what made the reveal look stuttery under fast streaming.
  useEffect(() => {
    if (!active) return;
    // Target shrank — e.g. the streaming buffer reset to '' when a turn ended,
    // or a new (shorter) streaming turn began. Drop the reveal cursor to the
    // new target and rebase the loop timing, otherwise the early-return below
    // leaves `revealed` showing the previous, longer reply until the new text
    // grows past it (a stale ghost of the last answer).
    if (revealedLenRef.current > target.length) {
      revealedLenRef.current = target.length;
      lastTsRef.current = null;
      setRevealed(target);
    }
    if (revealedLenRef.current >= target.length) return;
    if (rafRef.current !== null) return; // loop already running, it'll pick up the new target itself

    function tick(ts: number) {
      const last = lastTsRef.current ?? ts;
      const dt = Math.min(ts - last, 100);
      lastTsRef.current = ts;

      const t = targetRef.current;
      if (revealedLenRef.current > t.length) revealedLenRef.current = t.length;
      const backlog = t.length - revealedLenRef.current;
      if (backlog > 0) {
        const rate = Math.max(CHARS_PER_SEC, backlog / MAX_CATCHUP_SEC);
        const chars = Math.max(1, Math.round((rate * dt) / 1000));
        revealedLenRef.current = Math.min(t.length, revealedLenRef.current + chars);
        setRevealed(t.slice(0, revealedLenRef.current));
      }

      if (revealedLenRef.current < targetRef.current.length) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        rafRef.current = null;
        lastTsRef.current = null;
      }
    }
    rafRef.current = requestAnimationFrame(tick);
  }, [target, active]);

  // Only the unmount case cancels the loop outright.
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      lastTsRef.current = null;
    };
  }, []);

  return revealed;
}
