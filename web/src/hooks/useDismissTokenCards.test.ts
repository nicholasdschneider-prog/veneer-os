import { describe, expect, it } from 'vitest';
import { closeTokenCardsOutside } from './useDismissTokenCards';

function card(open: boolean, owns: object) {
  return { open, contains: (node: unknown) => node === owns };
}

describe('closeTokenCardsOutside', () => {
  it('closes open cards that do not contain the tap target', () => {
    const inside = {};
    const a = card(true, inside);
    const b = card(true, {});
    const c = card(false, {});
    expect(closeTokenCardsOutside([a, b, c], inside as unknown as Node)).toBe(1);
    expect(a.open).toBe(true);
    expect(b.open).toBe(false);
    expect(c.open).toBe(false);
  });

  it('closes everything for Escape (no target)', () => {
    const a = card(true, {});
    const b = card(true, {});
    expect(closeTokenCardsOutside([a, b], null)).toBe(2);
    expect(a.open || b.open).toBe(false);
  });
});
