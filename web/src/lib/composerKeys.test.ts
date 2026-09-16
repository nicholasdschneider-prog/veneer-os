import { describe, expect, it } from 'vitest';
import { isComposerSubmitKey } from './composerKeys';

describe('chat composer submit keys', () => {
  it('submits with the main Enter key', () => {
    expect(isComposerSubmitKey({ key: 'Enter', code: 'Enter', shiftKey: false })).toBe(true);
  });

  it('submits with keypad Enter while dictation uses the existing send flow', () => {
    expect(isComposerSubmitKey({ key: 'Enter', code: 'NumpadEnter', shiftKey: false })).toBe(true);
    expect(isComposerSubmitKey({ key: 'NumpadEnter', code: 'NumpadEnter', shiftKey: false })).toBe(
      true,
    );
  });

  it('keeps Shift+Enter as a newline for either Enter key', () => {
    expect(isComposerSubmitKey({ key: 'Enter', code: 'Enter', shiftKey: true })).toBe(false);
    expect(isComposerSubmitKey({ key: 'Enter', code: 'NumpadEnter', shiftKey: true })).toBe(false);
  });
});
