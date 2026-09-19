import { describe, expect, it } from 'vitest';
import { botModelChipLabel, joinDictation, withAttachmentFooter } from './botComposer';

describe('withAttachmentFooter', () => {
  it('returns the trimmed text when nothing is attached', () => {
    expect(withAttachmentFooter('  hi  ', [])).toBe('hi');
  });
  it('lists attached paths under the shared footer heading', () => {
    expect(withAttachmentFooter('see this', ['/tmp/a.png'])).toBe(
      'see this\n\nAttached files (saved on this server — read them from these paths):\n- /tmp/a.png',
    );
  });
  it('sends attachments alone when the text is empty', () => {
    expect(withAttachmentFooter('', ['/x'])).toMatch(/^Attached files/);
  });
});

describe('botModelChipLabel', () => {
  it('is empty until the provider is known', () => {
    expect(botModelChipLabel(null, null, null)).toBeNull();
  });
  it('names provider, model and effort', () => {
    expect(botModelChipLabel('claude', 'claude-opus-5', 'high', 'Claude Opus 5')).toBe('Claude Opus 5 · High');
  });
});

describe('joinDictation', () => {
  it('adds a space only when the base does not end with whitespace', () => {
    expect(joinDictation('a', 'b')).toBe('a b');
    expect(joinDictation('a ', 'b')).toBe('a b');
    expect(joinDictation('', 'b')).toBe('b');
  });
});
