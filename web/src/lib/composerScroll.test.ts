import { describe, expect, it } from 'vitest';
import { syncComposerScroll } from './composerScroll';

describe('composer scroll', () => {
  it('follows appended dictation and keeps the highlight aligned', () => {
    const textarea = { scrollTop: 24, scrollHeight: 180 };
    const highlight = { scrollTop: 0, scrollHeight: 180 };

    syncComposerScroll(textarea, highlight, true);

    expect(textarea.scrollTop).toBe(180);
    expect(highlight.scrollTop).toBe(180);
  });

  it('keeps the current position during normal editing', () => {
    const textarea = { scrollTop: 24, scrollHeight: 180 };
    const highlight = { scrollTop: 0, scrollHeight: 180 };

    syncComposerScroll(textarea, highlight, false);

    expect(textarea.scrollTop).toBe(24);
    expect(highlight.scrollTop).toBe(24);
  });
});
