import { describe, expect, it } from 'vitest';
import { finalizedDictatedTodoTitle, joinTodoDictation } from './todoDictation';

describe('todo dictation', () => {
  it('appends speech to an existing typed draft', () => {
    expect(joinTodoDictation('Call Sam', 'tomorrow morning')).toBe('Call Sam tomorrow morning');
    expect(joinTodoDictation('First line\n', 'second line')).toBe('First line\nsecond line');
  });

  it('returns a trimmed title after user-stopped committed speech', () => {
    expect(finalizedDictatedTodoTitle('user', true, '  Call Sam tomorrow  ')).toBe('Call Sam tomorrow');
  });

  it('does not create a todo without a successful final transcript', () => {
    expect(finalizedDictatedTodoTitle('cancel', true, 'Call Sam')).toBeNull();
    expect(finalizedDictatedTodoTitle('unexpected', true, 'Call Sam')).toBeNull();
    expect(finalizedDictatedTodoTitle('user', false, 'Typed before opening the mic')).toBeNull();
    expect(finalizedDictatedTodoTitle('user', true, '   ')).toBeNull();
  });
});
