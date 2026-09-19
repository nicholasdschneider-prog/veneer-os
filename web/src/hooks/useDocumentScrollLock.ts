import { useEffect } from 'react';

const EDITABLE = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

export function isTextEntryFocused(
  active: { tagName: string; isContentEditable?: boolean } | null,
): boolean {
  if (!active) return false;
  if (EDITABLE.has(active.tagName)) return true;
  return active.isContentEditable === true;
}

/**
 * The app shell is a fixed-height column: every screen scrolls inside its own
 * container and the document itself never should. iOS Safari still pans the
 * layout viewport to reveal a focused text field under its keyboard, and that
 * window scroll offset survives the keyboard closing, which leaves the bottom
 * bar floating mid-screen above a blank strip. Snap the window back to the
 * origin whenever the document ends up scrolled while no field has focus.
 */
export function useDocumentScrollLock(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    let timers: number[] = [];
    const settle = () => {
      if (isTextEntryFocused(document.activeElement)) return;
      if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
    };
    // Blur fires before iOS finishes retracting the keyboard, so settle again
    // after the animation has had time to finish.
    const onFocusOut = () => {
      timers.forEach((t) => window.clearTimeout(t));
      timers = [50, 400].map((ms) => window.setTimeout(settle, ms));
    };
    const vv = window.visualViewport;
    document.addEventListener('focusout', onFocusOut);
    window.addEventListener('scroll', settle, { passive: true });
    vv?.addEventListener('resize', settle);
    settle();
    return () => {
      timers.forEach((t) => window.clearTimeout(t));
      document.removeEventListener('focusout', onFocusOut);
      window.removeEventListener('scroll', settle);
      vv?.removeEventListener('resize', settle);
    };
  }, [enabled]);
}
