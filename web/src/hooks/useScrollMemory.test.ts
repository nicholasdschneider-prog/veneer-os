import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearScrollPositions,
  readScrollPosition,
  restoreScrollStep,
  saveScrollPosition,
  userScrolledAway,
} from './useScrollMemory';

/** Mimics a browser clamping scrollTop to the scrollable range. */
function container(maxTop: number) {
  let top = 0;
  return {
    get scrollTop() {
      return top;
    },
    set scrollTop(next: number) {
      top = Math.max(0, Math.min(next, maxTop));
    },
  };
}

describe('scroll memory', () => {
  beforeEach(() => clearScrollPositions());

  it('remembers an offset per key and defaults to the top', () => {
    saveScrollPosition('chats:active', 640);
    expect(readScrollPosition('chats:active')).toBe(640);
    expect(readScrollPosition('chats:archived')).toBe(0);
  });

  it('lands in one step once the rows are tall enough', () => {
    const el = container(2000);
    expect(restoreScrollStep(el, 640)).toBe('done');
    expect(el.scrollTop).toBe(640);
  });

  it('retries while the list is still shorter than the remembered offset', () => {
    const el = container(300);
    expect(restoreScrollStep(el, 640)).toBe('retry');
    expect(el.scrollTop).toBe(300);
    const grown = container(2000);
    grown.scrollTop = el.scrollTop;
    expect(restoreScrollStep(grown, 640)).toBe('done');
    expect(grown.scrollTop).toBe(640);
  });

  it('treats an offset that differs from the last assignment as the user taking over', () => {
    expect(userScrolledAway(300, 300)).toBe(false);
    expect(userScrolledAway(420, 300)).toBe(true);
    expect(userScrolledAway(420, null)).toBe(false);
  });
});
