import { describe, it, expect } from 'vitest';
import { hasUnselectedMention, roomActivityLabel } from './teamRooms';
describe('room bot feedback', () => {
  it('warns about plain mentions without granting authority', () => {
    expect(hasUnselectedMention('@Grant answer Ali', [], false)).toBe(true);
    expect(hasUnselectedMention('Hello grant@example.test', [], false)).toBe(false);
    expect(hasUnselectedMention('@Grant answer', [{key:'bot:1', name:'Grant', kind:'bot'}], false)).toBe(false);
    expect(hasUnselectedMention('@everyone answer', [], true)).toBe(false);
  });
  it('does not equate pending work with typing or no reply with success', () => {
    expect(roomActivityLabel.working).toBe('Working…');
    expect(roomActivityLabel.no_reply).toContain('No room reply');
    expect(roomActivityLabel.failed).toContain('error');
  });
});
