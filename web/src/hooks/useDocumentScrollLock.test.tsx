import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { isTextEntryFocused, useDocumentScrollLock } from './useDocumentScrollLock';

describe('isTextEntryFocused', () => {
  it('treats inputs, textareas, selects and contenteditable as text entry', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
      expect(isTextEntryFocused({ tagName })).toBe(true);
    }
    expect(isTextEntryFocused({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isTextEntryFocused({ tagName: 'DIV' })).toBe(false);
    expect(isTextEntryFocused({ tagName: 'BUTTON' })).toBe(false);
    expect(isTextEntryFocused(null)).toBe(false);
  });
});

describe('useDocumentScrollLock', () => {
  it('is a no-op during static render', () => {
    function Probe() {
      useDocumentScrollLock(true);
      return <span>ok</span>;
    }
    expect(renderToStaticMarkup(<Probe />)).toContain('ok');
  });
});
