import { afterEach, describe, expect, it, vi } from 'vitest';
import { whenVisible } from './whenVisible';

describe('whenVisible', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('polls while visible and skips while hidden', () => {
    const poll = vi.fn();
    const tick = whenVisible(poll);
    vi.stubGlobal('document', { visibilityState: 'visible' });
    tick();
    vi.stubGlobal('document', { visibilityState: 'hidden' });
    tick();
    expect(poll).toHaveBeenCalledTimes(1);
  });
});
