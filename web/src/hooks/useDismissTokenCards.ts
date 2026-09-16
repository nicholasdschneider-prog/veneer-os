import { useEffect } from 'react';

/** The token-count footer is a native <details>; this is its selector. */
export const TOKEN_CARD_SELECTOR = 'details[data-slot="token-count"]';

type Dismissable = { open: boolean; contains(node: Node | null): boolean };

/**
 * Close every open token card that does not contain `target`. Pure so it can
 * be tested without a DOM; `null` target (Escape) closes them all.
 */
export function closeTokenCardsOutside(cards: Iterable<Dismissable>, target: Node | null): number {
  let closed = 0;
  for (const card of cards) {
    if (!card.open) continue;
    if (target && card.contains(target)) continue;
    card.open = false;
    closed += 1;
  }
  return closed;
}

/**
 * Tap-outside / Escape dismissal for the token breakdown cards. Older chat
 * rows are frozen static HTML with no React handlers, so this is one
 * document-level listener rather than per-card state.
 */
export function useDismissTokenCards(): void {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const cards = () => document.querySelectorAll<HTMLDetailsElement>(TOKEN_CARD_SELECTOR);
    const onPointerDown = (event: PointerEvent) => {
      closeTokenCardsOutside(cards(), event.target instanceof Node ? event.target : null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeTokenCardsOutside(cards(), null);
    };
    document.addEventListener('pointerdown', onPointerDown, { capture: true });
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, { capture: true });
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);
}
