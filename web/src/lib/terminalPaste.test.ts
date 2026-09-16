import { describe, expect, it } from 'vitest';
import { prepareTerminalPaste } from './terminalPaste';

describe('terminal paste', () => {
  it('sends plain clipboard text unchanged', () => {
    expect(prepareTerminalPaste('npm run build\n', false)).toBe('npm run build\n');
  });

  it('wraps text when bracketed paste mode is active', () => {
    expect(prepareTerminalPaste('line one\nline two', true)).toBe('\x1b[200~line one\nline two\x1b[201~');
  });

  it('removes escape bytes from bracketed clipboard text', () => {
    expect(prepareTerminalPaste('safe\x1b[201~unsafe', true)).toBe('\x1b[200~safe[201~unsafe\x1b[201~');
  });
});
